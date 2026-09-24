// memory.js — write pages into a Second Brain library (Postgres + pgvector,
// the `pages` + `chunks` schema from github.com/lennymadethat/second-brain).
// Chunk at headings → embed with OpenAI text-embedding-3-large → upsert.
// Same chunking and the same embedding model as the Second Brain server, so a
// page written here is indistinguishable from one written through MCP.

const EMBED_MODEL = 'text-embedding-3-large';   // 3072 dims, matches halfvec(3072)
const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;

const KIND_BY_PREFIX = [
  ['wiki/projects/', 'project'],
  ['wiki/entities/', 'entity'],
  ['wiki/methodology/', 'methodology'],
  ['wiki/concepts/', 'concept'],
  ['wiki/sources/', 'source'],
  ['wiki/chats/', 'chat'],
  ['output/', 'output'],
  ['raw/', 'raw'],
];
const SPECIAL_FILES = { 'wiki/identity.md': 'identity', 'wiki/log.md': 'log', 'wiki/index.md': 'index', 'AGENTS.md': 'rules', 'CLAUDE.md': 'rules' };

export function validatePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path required');
  const norm = p.replace(/\\/g, '/').trim();
  if (norm.includes('..')) throw new Error('path traversal not allowed');
  if (norm.startsWith('/')) throw new Error('path must be relative (no leading slash)');
  if (!norm.toLowerCase().endsWith('.md')) throw new Error('path must end in .md');
  return norm;
}

function deriveKind(relPath) {
  if (SPECIAL_FILES[relPath]) return { kind: SPECIAL_FILES[relPath], subtype: null };
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (!relPath.startsWith(prefix)) continue;
    if (kind === 'entity') {
      const rest = relPath.slice(prefix.length); const slash = rest.indexOf('/');
      return { kind, subtype: slash > 0 ? rest.slice(0, slash) : null };
    }
    return { kind, subtype: null };
  }
  return { kind: 'other', subtype: null };
}

function deriveTitle(body, fallback) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

function extractMetadata(body) {
  const lines = body.split('\n');
  const wikilinks = new Set(); const wikiRe = /\[\[([^\[\]]+?)\]\]/g; let m;
  while ((m = wikiRe.exec(body)) !== null) wikilinks.add(m[1].trim());
  return {
    h2_outline: lines.filter(l => l.startsWith('## ')).map(l => l.slice(3).trim()),
    cross_refs: [...wikilinks],
    body_lines: lines.length,
    has_table: /^\|.*\|.*$/m.test(body),
  };
}

function chunkPage(body) {
  const lines = body.split('\n'); const sections = []; let cur = { heading: null, content: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) { if (cur.content.length) sections.push(cur); cur = { heading: line.replace(/^##\s+/, '').trim(), content: [line] }; }
    else cur.content.push(line);
  }
  if (cur.content.length) sections.push(cur);
  const chunks = [];
  for (const s of sections) {
    const text = s.content.join('\n').trim(); if (!text) continue;
    if (text.length <= CHUNK_TARGET_CHARS) { chunks.push({ heading: s.heading, body: text }); continue; }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + CHUNK_TARGET_CHARS, text.length);
      const sub = text.slice(start, end).trim(); if (sub) chunks.push({ heading: s.heading, body: sub });
      if (end === text.length) break; start = end - CHUNK_OVERLAP_CHARS;
    }
  }
  return chunks;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Insert content under "## {section}" (newest-at-top); create the section if missing.
export function appendUnderSection(body, section, content) {
  const lines = body.split('\n');
  const re = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`);
  const idx = lines.findIndex(l => re.test(l));
  if (idx === -1) {
    const trimmed = body.replace(/\n+$/, '');
    return `${trimmed}\n\n## ${section}\n\n${content}\n`;
  }
  let insertIdx = idx + 1;
  while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
  return [...lines.slice(0, idx + 1), '', content, '', ...lines.slice(insertIdx)].join('\n');
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const vectorLiteral = (v) => '[' + v.join(',') + ']';

function headers(env, extra) {
  return { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function embedTexts(inputs, env) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs, encoding_format: 'float' }),
  });
  if (!resp.ok) throw new Error(`embeddings ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

export async function readPage(rawPath, env) {
  const safe = validatePath(rawPath);
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/pages`);
  url.searchParams.set('path', `eq.${safe}`);
  url.searchParams.set('deleted_at', 'is.null');
  url.searchParams.set('select', 'path,kind,subtype,title,body,metadata,updated_at');
  const resp = await fetch(url.toString(), { headers: headers(env, { Accept: 'application/vnd.pgrst.object+json' }) });
  if (resp.status === 406) return null;
  if (!resp.ok) throw new Error(`library read ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

// All live project pages — path + title. The classifier and the rollup use it.
export async function listProjectPages(env) {
  const url = `${env.SUPABASE_URL}/rest/v1/pages?kind=eq.project&deleted_at=is.null&select=path,title`;
  const resp = await fetch(url, { headers: headers(env) });
  if (!resp.ok) throw new Error(`library project list ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

export async function writePage(rawPath, body, env, metaOverride) {
  const filePath = validatePath(rawPath);
  if (typeof body !== 'string') throw new Error('body must be a string');
  const { kind, subtype } = deriveKind(filePath);
  const title = deriveTitle(body, filePath.split('/').pop().replace(/\.md$/i, ''));
  const metadata = { ...extractMetadata(body), ...(metaOverride || {}) };
  const bodyHash = await sha256(body);
  const chunks = chunkPage(body);
  let chunkEmbeddings = [], pageEmbeddingLiteral = null;
  if (chunks.length > 0) { chunkEmbeddings = await embedTexts(chunks.map(c => c.body), env); pageEmbeddingLiteral = vectorLiteral(chunkEmbeddings[0]); }

  const upsertResp = await fetch(`${env.SUPABASE_URL}/rest/v1/pages?on_conflict=path`, {
    method: 'POST', headers: headers(env, { Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify([{ path: filePath, kind, subtype, title, body, metadata, hash: bodyHash, embedding: pageEmbeddingLiteral, deleted_at: null }]),
  });
  if (!upsertResp.ok) throw new Error(`library upsert ${upsertResp.status}: ${(await upsertResp.text()).slice(0, 200)}`);

  const delResp = await fetch(`${env.SUPABASE_URL}/rest/v1/chunks?page_path=eq.${encodeURIComponent(filePath)}`, { method: 'DELETE', headers: headers(env) });
  if (!delResp.ok && delResp.status !== 204) throw new Error(`library chunk delete ${delResp.status}`);

  if (chunks.length > 0) {
    const rows = await Promise.all(chunks.map(async (c, i) => ({
      page_path: filePath, chunk_index: i, heading: c.heading, body: c.body,
      token_count: Math.max(1, Math.round(c.body.length / 4)), embedding: vectorLiteral(chunkEmbeddings[i]), hash: await sha256(c.body),
    })));
    const insResp = await fetch(`${env.SUPABASE_URL}/rest/v1/chunks`, { method: 'POST', headers: headers(env), body: JSON.stringify(rows) });
    if (!insResp.ok) throw new Error(`library chunk insert ${insResp.status}: ${(await insResp.text()).slice(0, 200)}`);
  }
  return { path: filePath, kind, subtype, title, chunks_written: chunks.length };
}

// Append under a section of a page; create the page if missing (newest-at-top).
export async function appendToPage(rawPath, section, content, env) {
  const filePath = validatePath(rawPath);
  const existing = await readPage(filePath, env);
  const baseBody = existing && typeof existing.body === 'string' ? existing.body : `# ${filePath.split('/').pop().replace(/\.md$/i, '')}\n`;
  const newBody = appendUnderSection(baseBody, section.trim(), content);
  await writePage(filePath, newBody, env);
  return { path: filePath, created: !existing };
}

export function libraryConfigured(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.OPENAI_API_KEY);
}
