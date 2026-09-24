// events.js — the ledger. One row per processed file (ingest_events) and one
// row per agent run per file (agent_runs), in the same Postgres as the library.
// migrations/0001_ingester_ledger.sql creates both. A ledger write never blocks
// or fails a run.

function headers(env) {
  const SR = env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: SR, authorization: `Bearer ${SR}`, 'content-type': 'application/json', prefer: 'return=minimal' };
}

export async function emitEvent(env, ev) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, skipped: true };
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/ingest_events`, { method: 'POST', headers: headers(env), body: JSON.stringify(ev) });
    return { ok: r.ok, status: r.status, err: r.ok ? null : (await r.text()).slice(0, 200) };
  } catch (e) { return { ok: false, err: e.message }; }
}

export async function recordAgentRun(env, { base, source, agent, status, summary, outputs, domain }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/agent_runs`, {
      method: 'POST', headers: headers(env),
      body: JSON.stringify({ source_filename: base, source: source || null, agent, status: status || 'done', summary: summary || null, outputs: outputs || null, domain: domain || null }),
    });
  } catch { /* never block the pipeline on the ledger */ }
}

export function eventFor({ base, c, recipe, page, filed, note }) {
  return {
    source_filename: base,
    detected_type: c.type || 'note',
    routed_project: c.project || null,
    domain: c.domain || 'unknown',
    summary: c.title || base,
    reasoning: `Routed to ${c.project || c.domain}; ${recipe} agent(s) ran.`,
    page: page || filed || null,
    moved_to: filed || null,
    status: 'processed',
    error: note || null,
  };
}
