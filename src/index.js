// Ingester — drop a file, get a memory.
//
// The inbox is an R2 bucket (files at the root). Each file is read, classified,
// handed to a small squad of agents that write derivative pages into a Second
// Brain library, rolled up onto the matching project page, and then filed under
// processed/{domain}/. Location is the idempotency key: root = not yet done.
//
// Triggers:
//   cron (every 15 min)  -> scheduled() -> enqueue one job per pending file
//   POST /upload         -> put a file in the inbox and queue it   [token-gated]
//   POST /run            -> enqueue everything pending             [token-gated]
//   POST /run?inline=1   -> process a few files synchronously (debug)
//   POST /dream          -> run the weekly consolidation pass now  [token-gated]
//   GET  /status         -> pending counts                         [token-gated]
//   GET  /health         -> public
import { json, cors, extract, classify } from './lib.js';
import { libraryConfigured } from './memory.js';
import { WORKERS } from './workers.js';
import { rollupToProject, projectIndex } from './rollup.js';
import { emitEvent, eventFor, recordAgentRun } from './events.js';
import { runDream } from './dream.js';
import { Unavailable, llmConfigured } from './llm.js';

const PROCESSED = (env) => env.PROCESSED_PREFIX || 'processed/';
const STAGING = 'staging/';
const WORKERS_BY_NAME = Object.fromEntries(WORKERS.map(w => [w.name, w]));

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const authed = (request, env) => !!env.INGESTER_TOKEN && timingSafeEqual(request.headers.get('x-ingester-token') || '', env.INGESTER_TOKEN);

async function listInbox(env, limit = 25) {
  const out = [];
  let cursor;
  do {
    const res = await env.INBOX.list({ cursor, limit: 1000 });
    for (const o of res.objects) {
      if (o.key.startsWith(PROCESSED(env)) || o.key.startsWith(STAGING)) continue;
      if (o.key.endsWith('/') || o.size === 0) continue;
      out.push(o.key);
      if (out.length >= limit) return out;
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

const applies = (w, c, env) => { try { return w.appliesTo(c, env); } catch { return false; } };

async function prepare(env, key) {
  // Cheap checks first, so the model never reads a file we cannot file.
  if (!libraryConfigured(env)) throw new Unavailable('library not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + OPENAI_API_KEY)');
  let slugs;
  try { slugs = (await projectIndex(env)).map(p => p.tail); }
  catch (e) { throw new Unavailable(`library unreachable: ${e.message}`); }
  const obj = await env.INBOX.get(key);
  if (!obj) return null;
  const body = await obj.arrayBuffer();
  const base = key.split('/').pop();
  const { kind, text, note } = await extract(env, key, body);
  const c = await classify(env, { base, text }, slugs);
  c.hasText = Boolean(text && text.trim().length > 0);
  c.kind = kind;
  return { body, base, kind, text, note, c };
}

async function fileOriginal(env, key, body, domain) {
  const filed = `${PROCESSED(env)}${domain || 'unknown'}/${key.split('/').pop()}`;
  await env.INBOX.put(filed, body);
  await env.INBOX.delete(key);
  return filed;
}

// Inline path: everything for one file in one invocation (debugging, small inboxes).
async function processOne(env, key, log) {
  const p = await prepare(env, key);
  if (!p) return { key, status: 'gone' };
  const item = { base: p.base, kind: p.kind, text: p.text, note: p.note, c: p.c };
  const recipe = WORKERS.filter(w => applies(w, p.c, env));
  const outputs = [];
  for (const w of recipe) {
    try {
      const r = await w.run(env, item); log(`  [${w.name}] ${r.summary}`); outputs.push(...(r.outputs || []));
      await recordAgentRun(env, { base: p.base, source: p.kind, agent: w.name, status: 'done', summary: r.summary, outputs: r.outputs, domain: p.c.domain });
    } catch (e) {
      if (e instanceof Unavailable) throw e;
      log(`  [${w.name}] error: ${e.message}`);
      await recordAgentRun(env, { base: p.base, agent: w.name, status: 'error', summary: String(e.message), domain: p.c.domain });
    }
  }
  try {
    const r = await rollupToProject(env, item); log(`  [rollup] ${r.summary}`); outputs.push(...(r.outputs || []));
    await recordAgentRun(env, { base: p.base, agent: 'rollup', status: 'done', summary: r.summary, outputs: r.outputs, domain: p.c.domain });
  } catch (e) {
    if (e instanceof Unavailable) throw e;
    log(`  [rollup] error: ${e.message}`);
    await recordAgentRun(env, { base: p.base, agent: 'rollup', status: 'error', summary: String(e.message), domain: p.c.domain });
  }
  const filed = await fileOriginal(env, key, p.body, p.c.domain);
  const page = outputs.find(o => typeof o === 'string' && o.startsWith('wiki/')) || filed;
  const ev = await emitEvent(env, eventFor({ base: p.base, c: p.c, recipe: recipe.length, page, filed, note: p.note }));
  if (!ev.ok && !ev.skipped) log(`  [ledger] insert failed: ${ev.err}`);
  log(`✓ ${p.base} → ${p.c.domain}/${p.c.type} → ${filed}`);
  return { key, base: p.base, domain: p.c.domain, type: p.c.type, project: p.c.project || null, recipe: recipe.map(w => w.name), outputs, status: 'processed' };
}

// Queue path, step 1 (the sorter): read + classify once, stage the prepared item,
// file the original, write the ledger row, then fan out ONE job per agent.
async function dispatchFile(env, key) {
  const p = await prepare(env, key);
  if (!p) return { key, status: 'gone' };
  const recipe = WORKERS.filter(w => applies(w, p.c, env));
  const stagingKey = `${STAGING}${crypto.randomUUID()}.json`;
  await env.INBOX.put(stagingKey, JSON.stringify({ base: p.base, kind: p.kind, text: p.text, c: p.c, note: p.note }));
  const filed = await fileOriginal(env, key, p.body, p.c.domain);
  await emitEvent(env, eventFor({ base: p.base, c: p.c, recipe: recipe.length, page: filed, filed, note: p.note }));
  const agents = [...recipe.map(w => w.name), 'rollup'];
  for (const agent of agents) await env.JOBS.send({ kind: 'agent', agent, staging: stagingKey, base: p.base });
  return { key, base: p.base, domain: p.c.domain, agents, status: 'dispatched' };
}

// Queue path, step 2: run ONE agent on a staged item, in its own invocation with
// its own retry and its own ledger row.
async function runAgent(env, agent, stagingKey) {
  const obj = await env.INBOX.get(stagingKey);
  if (!obj) return { agent, status: 'staging-gone' };
  const s = JSON.parse(await obj.text());
  const item = { base: s.base, kind: s.kind, text: s.text, c: s.c, note: s.note };
  try {
    let r;
    if (agent === 'rollup') r = await rollupToProject(env, item);
    else { const w = WORKERS_BY_NAME[agent]; if (!w) return { agent, status: 'unknown-agent' }; r = await w.run(env, item); }
    await recordAgentRun(env, { base: s.base, source: s.kind, agent, status: 'done', summary: r.summary, outputs: r.outputs, domain: s.c.domain });
    return { agent, status: 'done', summary: r.summary };
  } catch (e) {
    await recordAgentRun(env, { base: s.base, agent, status: 'error', summary: String(e.message), domain: s.c.domain });
    throw e;
  }
}

// Staged items older than a day are deleted. A day, not an hour: an agent job
// can wait out an API outage, and deleting its input underneath it loses work.
async function cleanStaging(env) {
  let n = 0, cursor; const cutoff = Date.now() - 86400000;
  do {
    const res = await env.INBOX.list({ prefix: STAGING, cursor, limit: 1000 });
    for (const o of res.objects) { if (o.uploaded && o.uploaded.getTime() < cutoff) { await env.INBOX.delete(o.key); n++; } }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return n;
}

async function enqueuePending(env, cap = 500) {
  if (!env.JOBS) return { queued: 0, error: 'JOBS queue not bound' };
  const keys = await listInbox(env, cap);
  for (const key of keys) await env.JOBS.send({ key });
  return { queued: keys.length };
}

export async function runOnce(env, { limit = 6 } = {}) {
  if (!libraryConfigured(env)) return { error: 'library not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + OPENAI_API_KEY)' };
  const logs = []; const log = (m) => logs.push(m);
  const items = [];
  for (const key of await listInbox(env, limit)) {
    try { items.push(await processOne(env, key, log)); }
    catch (e) {
      const parked = e instanceof Unavailable;
      log(`${parked ? '…' : '!'} ${key}: ${e.message}${parked ? ' (parked, will retry next sweep)' : ''}`);
      items.push({ key, status: parked ? 'parked' : 'error', error: e.message });
    }
  }
  return {
    processed: items.filter(i => i.status === 'processed').length,
    parked: items.filter(i => i.status === 'parked').length,
    errors: items.filter(i => i.status === 'error').length,
    items, log: logs,
  };
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 12 * * SUN') {
      ctx.waitUntil(runDream(env).then(r => console.log('dream run:', JSON.stringify(r)))
        .catch(e => console.log('dream error:', String(e.message || e))));
      return;
    }
    ctx.waitUntil(Promise.all([
      enqueuePending(env).then(r => console.log('ingester cron enqueued:', JSON.stringify(r))),
      cleanStaging(env).then(n => n && console.log('ingester staging cleaned:', n)),
    ]));
  },

  // Two job kinds, each its own invocation, each retried on its own:
  //   {kind:'agent', agent, staging}  -> one agent on a staged item
  //   {key} or an R2 event            -> the sorter: stage + fan out
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const b = msg.body || {};
      try {
        if (b.kind === 'agent') {
          const r = await runAgent(env, b.agent, b.staging);
          console.log('ingester agent:', JSON.stringify({ agent: b.agent, base: b.base, status: r.status }));
          msg.ack(); continue;
        }
        let key = b.key;
        if (!key && b.object && b.object.key) {
          if (b.action && /Delete/i.test(b.action)) { msg.ack(); continue; }
          key = b.object.key;
        }
        if (!key || key.startsWith(PROCESSED(env)) || key.startsWith(STAGING) || key.endsWith('/')) { msg.ack(); continue; }
        const r = await dispatchFile(env, key);
        console.log('ingester dispatch:', JSON.stringify({ key, status: r.status, agents: r.agents }));
        msg.ack();
      } catch (e) {
        // The model or the library is unreachable: not a failure, just not now.
        // A file not yet dispatched is still in the inbox, so the next sweep
        // finds it (ack keeps it out of the dead-letter queue). An agent job has
        // no such home, so it waits ten minutes and tries again.
        if (e instanceof Unavailable || e?.name === 'Unavailable') {
          console.log('ingester parked (' + e.message + '):', JSON.stringify(b).slice(0, 120));
          if (b.kind === 'agent') msg.retry({ delaySeconds: 600 }); else msg.ack();
          continue;
        }
        console.log('ingester job error:', JSON.stringify(b).slice(0, 140), String(e.message || e));
        msg.retry({ delaySeconds: 60 });   // a real error backs off; it never spins
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, request) });

    if (path === '/health' && request.method === 'GET') {
      let inboxOk = true; try { await env.INBOX.list({ limit: 1 }); } catch { inboxOk = false; }
      return json({
        ok: true, service: 'ingester', version: env.INGESTER_VERSION || 'dev',
        inbox: inboxOk, library: libraryConfigured(env), queue: !!env.JOBS,
        llm: await llmConfigured(env),
        agents: WORKERS.map(w => w.name),
      }, 200, request, env);
    }

    if (['/run', '/status', '/upload', '/dream'].includes(path) && !authed(request, env)) {
      return json({ error: 'unauthorized' }, 401, request, env);
    }

    if (path === '/status' && request.method === 'GET') {
      const keys = await listInbox(env, 1000);
      return json({ pending: keys.length, keys: keys.slice(0, 50) }, 200, request, env);
    }

    if (path === '/upload' && request.method === 'POST') {
      let name = url.searchParams.get('name') || '';
      let bytes;
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('multipart/form-data')) {
        const form = await request.formData(); const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: 'no file field' }, 400, request, env);
        name = name || file.name || `upload-${Date.now()}`; bytes = await file.arrayBuffer();
      } else {
        if (!name) return json({ error: 'provide ?name=filename.ext for raw uploads' }, 400, request, env);
        bytes = await request.arrayBuffer();
      }
      if (!bytes || bytes.byteLength === 0) return json({ error: 'empty upload' }, 400, request, env);
      name = name.split('/').pop();
      await env.INBOX.put(name, bytes);
      let queued = false;
      if (env.JOBS && url.searchParams.get('process') !== 'false') { await env.JOBS.send({ key: name }); queued = true; }
      return json({ uploaded: name, bytes: bytes.byteLength, queued }, 200, request, env);
    }

    if (path === '/dream' && request.method === 'POST') {
      try { return json(await runDream(env), 200, request, env); }
      catch (e) { return json({ error: e.message }, e instanceof Unavailable ? 503 : 500, request, env); }
    }

    if (path === '/run' && request.method === 'POST') {
      if (url.searchParams.get('inline') === 'true' || url.searchParams.get('inline') === '1') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '6', 10) || 6, 20);
        return json(await runOnce(env, { limit }), 200, request, env);
      }
      return json(await enqueuePending(env), 200, request, env);
    }

    return json({ error: 'not found', routes: ['GET /health', 'GET /status', 'POST /run', 'POST /upload', 'POST /dream'] }, 404, request, env);
  },
};
