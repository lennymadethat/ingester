// workers.js — the agents. Each one: { name, appliesTo(c), run(env, item) }.
// Non-destructive: every agent reads item.text and writes NEW derivative pages
// or appends dated blocks under a named section. Nothing here edits a page the
// owner wrote by hand, except to append under a section they can see.
import { writePage, appendToPage } from './memory.js';
import { completeJSON, clip, slugify, todayISO } from './lib.js';

const roll = (env, path, section, block) => appendToPage(path, section, block, env);

// 1. Source page — one page per dropped file, under wiki/sources/ingester/.
const ingester = {
  name: 'ingester',
  appliesTo: (c) => Boolean(c.hasText),
  async run(env, item) {
    const data = await completeJSON(env,
      `Summarize this ${item.kind} for a personal knowledge base. Return JSON:
{"title":"short title","summary":"3-6 sentence summary","key_points":["..."],"decisions":["..."],"entities":["people/companies/things named"]}
CONTENT:\n${clip(item.text)}`,
      { system: 'You write tight, factual notes. No fluff.' });
    const slug = slugify(data.title);
    const md = `# ${data.title}\n\n**Domain:** ${item.c.domain} · **Source file:** \`${item.base}\` · **Ingested:** ${todayISO()}\n\n## Summary\n${data.summary}\n\n## Key points\n${(data.key_points || []).map(k => `- ${k}`).join('\n')}\n\n## Decisions\n${(data.decisions || []).map(k => `- ${k}`).join('\n') || '- (none)'}\n\n## Entities\n${(data.entities || []).join(', ')}\n`;
    const r = await writePage(`wiki/sources/ingester/${slug}.md`, md, env);
    return { summary: `source page → ${r.path}`, outputs: [r.path] };
  },
};

// 2. Tags and cross-link suggestions.
const tagger = {
  name: 'tagger',
  appliesTo: (c) => Boolean(c.hasText),
  async run(env, item) {
    const data = await completeJSON(env,
      `From this content, list topic tags and likely cross-links. Return JSON:
{"tags":["topic tags"],"links":["[[likely existing page names]]"]}
CONTENT:\n${clip(item.text, 4000)}`);
    const block = `### ${todayISO()} — ${item.base}\nTags: ${(data.tags || []).join(', ')}\nSuggested links: ${(data.links || []).join(' ')}`;
    const r = await roll(env, 'output/ingester/link-suggestions.md', 'Cross-link suggestions', block);
    return { summary: `tagged (${(data.tags || []).length} tags)`, outputs: [r.path] };
  },
};

// 3. Action items from meetings and transcripts.
const actionItems = {
  name: 'action-items',
  appliesTo: (c) => Boolean(c.hasText) && (c.type === 'meeting' || c.type === 'transcript' || c.hasActions),
  async run(env, item) {
    const data = await completeJSON(env,
      `Extract concrete action items. Return JSON:
{"items":[{"task":"...","owner":"who or null","due":"date or null"}]}
If none, items:[]. CONTENT:\n${clip(item.text)}`);
    if (!data.items?.length) return { summary: 'no action items', outputs: [] };
    const block = `### ${todayISO()} — ${item.base}\n${data.items.map(i => `- [ ] ${i.task}${i.owner ? ` (@${i.owner})` : ''}${i.due ? ` — due ${i.due}` : ''}`).join('\n')}`;
    const r = await roll(env, 'output/ingester/action-items.md', 'Action items', block);
    return { summary: `${data.items.length} action items`, outputs: [r.path] };
  },
};

// 4. Receipts, invoices, bills → an expense log.
const receipt = {
  name: 'receipt',
  appliesTo: (c) => c.domain === 'finance' || ['invoice', 'receipt', 'bill', 'statement'].includes(c.type),
  async run(env, item) {
    const data = await completeJSON(env,
      `Extract financial fields. Return JSON:
{"vendor":"","date":"","doc_no":"","total":"","category":"","claimable":"true/false + why or empty"}
CONTENT:\n${clip(item.text, 5000)}`);
    const block = `### ${todayISO()} — ${item.base}\n- **${data.vendor || '?'}** ${data.total || ''} · ${data.date || '?'} · ${data.category || ''} · doc ${data.doc_no || '—'} · claimable: ${data.claimable || '—'}`;
    const r = await roll(env, 'output/ingester/expense-log.md', 'Expense log', block);
    return { summary: `expense: ${data.vendor || '?'} ${data.total || ''}`, outputs: [r.path] };
  },
};

// 5. People named → a contact inbox.
const people = {
  name: 'people',
  appliesTo: (c) => Boolean(c.hasText),
  async run(env, item) {
    const data = await completeJSON(env,
      `List real people named (skip generic roles). Return JSON:
{"people":[{"name":"","context":"why they appear"}]}
CONTENT:\n${clip(item.text, 5000)}`);
    if (!data.people?.length) return { summary: 'no people', outputs: [] };
    const block = `### ${todayISO()} — ${item.base}\n${data.people.map(p => `- **${p.name}** — ${p.context}`).join('\n')}`;
    const r = await roll(env, 'output/ingester/contact-inbox.md', 'People named', block);
    return { summary: `${data.people.length} people`, outputs: [r.path] };
  },
};

// 6. Cross-project ideas. OWNER_CONTEXT (wrangler.toml) is one line naming what
// the owner works on; without it this agent stays quiet.
const crossProject = {
  name: 'cross-project',
  appliesTo: (c, env) => Boolean(c.hasText) && Boolean(env?.OWNER_CONTEXT),
  async run(env, item) {
    const data = await completeJSON(env,
      `The owner works on: ${env.OWNER_CONTEXT}
Does this content offer any idea, technique, or opportunity that could improve ANY of those, even one it wasn't meant for? Return JSON:
{"opportunities":[{"project":"","insight":"","why":""}]}
If none, opportunities:[]. CONTENT:\n${clip(item.text)}`);
    if (!data.opportunities?.length) return { summary: 'no cross-project hits', outputs: [] };
    const block = `### ${todayISO()} — ${item.base}\n${data.opportunities.map(o => `- **${o.project}:** ${o.insight} — _${o.why}_`).join('\n')}`;
    const r = await roll(env, 'output/ingester/cross-project-opportunities.md', 'Cross-project opportunities', block);
    return { summary: `${data.opportunities.length} opportunities`, outputs: [r.path] };
  },
};

// 7. Media with no text → flagged, never dropped.
const mediaFallback = {
  name: 'media-fallback',
  appliesTo: (c) => ['audio', 'video', 'image', 'binary'].includes(c.kind) && !c.hasText,
  async run(env, item) {
    const block = `### ${todayISO()} — ${item.base}\nNo text could be extracted (${item.note || 'unknown'}). Needs a transcription step or a manual look.`;
    const r = await roll(env, 'output/ingester/needs-attention.md', 'Files needing attention', block);
    return { summary: 'no text → flagged', outputs: [r.path] };
  },
};

export const WORKERS = [ingester, tagger, actionItems, receipt, people, crossProject, mediaFallback];
