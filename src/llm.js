// llm.js — where the Ingester thinks, and what happens when it cannot.
//
// One Anthropic client, two entry points:
//   complete()      a text prompt in, text out (the classifier and every agent)
//   readDocument()  a PDF or image in, its text out (Claude reads the file itself;
//                   no OCR service, no PDF library)
//
// When the API is unreachable, rate-limited, or down, the caller gets an
// `Unavailable` error. The queue treats that as "not now": the file stays in the
// inbox and the next sweep picks it up. Nothing is lost and nothing is retried
// in a hot loop.

import Anthropic from '@anthropic-ai/sdk';

export class Unavailable extends Error {
  constructor(msg) { super(msg); this.name = 'Unavailable'; this.unavailable = true; }
}

const DEFAULT_MODEL = 'claude-opus-5';

function client(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Unavailable('ANTHROPIC_API_KEY not set');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 300_000 });
}

function unavailableIf(err) {
  if (err instanceof Anthropic.RateLimitError) return new Unavailable(`rate limited: ${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new Unavailable(`API ${err.status}: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new Unavailable(`API unreachable: ${err.message}`);
  return err;
}

function textOf(response) {
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation || response.stop_details?.category || 'refused';
    throw new Error(`model declined: ${why}`);
  }
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// One request. Server-side refusal fallbacks are on by default: if the primary
// model declines a document on policy grounds, the API re-runs the same request
// on a fallback model inside the same call. Drop `betas` + `fallbacks` (and use
// client.messages.create) if you do not want that.
async function send(env, params) {
  const c = client(env);
  try {
    return await c.beta.messages.create({
      model: env.MODEL || DEFAULT_MODEL,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...params,
    });
  } catch (err) {
    throw unavailableIf(err);
  }
}

// A text prompt in, text out. Short outputs (JSON for routing and extraction),
// so effort stays low and max_tokens modest.
export async function complete(env, { system, prompt, maxTokens }) {
  const response = await send(env, {
    max_tokens: maxTokens || 4096,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return textOf(response);
}

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Chunked so a multi-megabyte scan does not blow the call stack.
function toBase64(bytes) {
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A PDF or image in, its text out. The file goes to the model as a document or
// image block, and the model transcribes it. A scan with no text layer works the
// same way as a born-digital PDF.
export async function readDocument(env, { name, bytes }) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const data = toBase64(bytes);
  const block = ext === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: IMAGE_MIME[ext], data } };
  const response = await send(env, {
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: 'You transcribe documents. Output the full text content, in reading order, as plain text. Keep tables as rows. If the document is an image with no text, describe it in one paragraph.',
    messages: [{ role: 'user', content: [block, { type: 'text', text: `Transcribe this file (${name}).` }] }],
  });
  const text = textOf(response);
  return { kind: ext === 'pdf' ? 'pdf' : 'image', text, note: text ? null : 'no text found' };
}

export async function llmConfigured(env) {
  return { configured: !!env.ANTHROPIC_API_KEY, model: env.MODEL || DEFAULT_MODEL };
}
