// rollup.js — after the agents run, tell the PROJECT PAGE something new arrived.
// Append-only under one dedicated section; never touches the curated parts of
// the page. No confident project match → a review queue, so nothing is lost.
import { listProjectPages, appendToPage } from './memory.js';
import { completeJSON, clip, todayISO } from './lib.js';

export const ROLLUP_SECTION = 'Inbox roll-ups (ingester, newest at top)';
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

let _index = null;
export async function projectIndex(env) {
  if (_index) return _index;
  const pages = await listProjectPages(env);
  _index = pages.map(p => ({ path: p.path, tail: norm(p.path.split('/').pop().replace(/\.md$/i, '')) }));
  return _index;
}

// exact normalized → token subset (≥2 shared) → overlap ≥0.6. null if unsure.
export async function findProjectPage(env, hint) {
  if (!hint) return null;
  const idx = await projectIndex(env);
  const h = norm(hint);
  const ht = new Set(h.split('-').filter(Boolean));
  let best = null, bestScore = 0;
  for (const { path, tail } of idx) {
    if (tail === h) return path;
    const st = new Set(tail.split('-').filter(Boolean));
    let overlap = 0; for (const t of ht) if (st.has(t)) overlap++;
    const subset = overlap >= 2 && (overlap === st.size || overlap === ht.size);
    const score = subset ? 1 : overlap / Math.max(ht.size, st.size, 1);
    if (score > bestScore) { bestScore = score; best = path; }
  }
  return bestScore >= 0.6 ? best : null;
}

export async function rollupToProject(env, item) {
  const hint = item.c?.project;
  if (!hint) return { summary: 'no project target', outputs: [] };
  const page = await findProjectPage(env, hint);
  if (!page) {
    const r = await appendToPage('output/ingester/rollup-review-queue.md', 'Roll-ups needing a project (route by hand)',
      `### ${todayISO()} — ${item.base}\nClassifier project hint: "${hint}" — no confident match. Source content is not lost; route by hand.`, env);
    return { summary: `no project match for "${hint}" → review queue`, outputs: [r.path] };
  }
  const data = await completeJSON(env,
    `Extract ONLY what is NEW and actionable for the project page "${page.split('/').pop().replace(/\.md$/i, '')}". Return JSON:
{"skip":true,"bullets":["concise updates: decisions, asks, blockers, action items"]}
skip=true if nothing project-relevant. CONTENT:\n${clip(item.text, 8000)}`,
    { system: 'You write terse project roll-up bullets. No fluff.' });
  if (data.skip || !data.bullets?.length) return { summary: 'nothing project-relevant', outputs: [] };
  const block = `### ${todayISO()} — from \`${item.base}\`\n${data.bullets.map(b => `- ${b}`).join('\n')}`;
  await appendToPage(page, ROLLUP_SECTION, block, env);
  return { summary: `rolled up → ${page} (${data.bullets.length} bullets)`, outputs: [page] };
}
