// lib.js — turn a dropped file into text, decide where it belongs, small helpers.

import { complete, readDocument } from './llm.js';

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const slugify = (s) => (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
export const clip = (t, n = 8000) => (t || '').slice(0, n);

export function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || '*');
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-ingester-token', 'Access-Control-Max-Age': '86400' };
}
export const json = (obj, status, request, env) => new Response(JSON.stringify(obj, null, 2), { status: status || 200, headers: { 'Content-Type': 'application/json', ...cors(env, request) } });

// Model → parsed JSON (strips ``` fences; tolerant of prose around the object).
export async function completeJSON(env, prompt, opts = {}) {
  const txt = await complete(env, { system: opts.system || 'Output JSON only. No prose.', prompt, maxTokens: opts.maxTokens });
  let s = txt.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a > 0 || b >= 0) s = s.slice(a < 0 ? 0 : a, b < 0 ? s.length : b + 1);
  return JSON.parse(s);
}

const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'json', 'log'];
const HTML_EXT = ['html', 'htm'];
const DOC_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
const MEDIA_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'mp4', 'mov', 'webm', 'mkv', 'avi'];

// Turn an inbox object into text. { kind, text, note }.
export async function extract(env, key, body) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  const name = key.split('/').pop();
  if (TEXT_EXT.includes(ext)) return { kind: 'text', text: new TextDecoder().decode(body), note: null };
  if (HTML_EXT.includes(ext)) {
    const raw = new TextDecoder().decode(body);
    return { kind: 'text', text: raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), note: null };
  }
  // PDFs, scans and photos: the model reads them directly.
  if (DOC_EXT.includes(ext)) return readDocument(env, { name, bytes: body });
  // Audio and video need a transcription service this repo does not bundle.
  // The media-fallback agent flags them so nothing is silently dropped.
  if (MEDIA_EXT.includes(ext)) {
    const kind = ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext) ? 'video' : 'audio';
    return { kind, text: '', note: 'no transcription service configured' };
  }
  try { const t = new TextDecoder('utf-8', { fatal: true }).decode(body); return { kind: 'text', text: t, note: null }; }
  catch { return { kind: 'binary', text: '', note: `unsupported type .${ext}` }; }
}

// Routing classifier. Domains come from wrangler.toml (DOMAINS), so the owner
// defines their own worlds; the project index comes from the library so the
// classifier can only name a project page that exists.
export async function classify(env, item, projectSlugs = []) {
  const domains = (env.DOMAINS || 'work=your job; finance=money, receipts, bills, statements; personal=friends, home, health')
    .split(';').map(s => s.trim()).filter(Boolean);
  const domainKeys = domains.map(d => d.split('=')[0].trim());
  return completeJSON(env,
    `Classify this dropped file for routing into a personal knowledge base. Return JSON:
{"type":"invoice|receipt|bill|statement|meeting|transcript|article|note|other",
 "domain":"${[...domainKeys, 'unknown'].join('|')}",
 "hasActions":true,
 "project":"one slug from the PROJECTS list below, or '' if none fits",
 "title":"short title"}
DOMAINS: ${domains.join('; ')}
PROJECTS: ${projectSlugs.length ? projectSlugs.join(', ') : '(none yet)'}
FILENAME: ${item.base}
EXCERPT:\n${clip(item.text, 3000)}`,
    { system: 'You are a precise routing classifier. Output JSON only.' });
}
