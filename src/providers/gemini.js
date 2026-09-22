/**
 * Google Gemini provider — genuinely free tier (rate-limited; ~10 requests/day
 * needed here against a ~250/day allowance). Uses Gemini's native JSON-schema
 * response enforcement.
 *
 * Honest caveat, also in docs/SETUP.md: Google may use free-tier inputs to
 * improve its products, and the scoring prompt contains the interest profile.
 */
import { buildScoringUser, buildDigestUser } from './format.js';
import { extractJson } from './json-util.js';

export const name = 'gemini';
export const label = 'Gemini API (free tier)';
export const concurrency = 2; // free tier allows ~10 requests/minute

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function model() {
  // gemini-2.5-flash returns 404 "no longer available to new users" on keys
  // created after mid-2026; Google's error names gemini-3.6-flash as the successor.
  return process.env.GEMINI_MODEL ?? 'gemini-3.6-flash';
}

/**
 * Gemini's responseSchema is an OpenAPI subset: additionalProperties and $comment
 * are rejected, so the shared schemas are converted rather than duplicated.
 */
export function toGeminiSchema(node) {
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  if (node.type) out.type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (node.enum) out.enum = node.enum;
  if (node.description) out.description = node.description;
  if (node.required) out.required = node.required;
  if (node.items) out.items = toGeminiSchema(node.items);
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  return out;
}

async function call(system, user, schema, usage) {
  const m = model();
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: toGeminiSchema(schema),
    temperature: 0.2,
    maxOutputTokens: 16384,
  };
  // 2.5-series models think by default; structured triage doesn't need it and it
  // burns the free-tier token budget.
  if (/^gemini-2\.5/.test(m)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch(`${BASE}/${m}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  // Gemini names these differently from Anthropic; normalized here so the
  // tracker sees one shape regardless of provider.
  const meta = data.usageMetadata ?? {};
  usage?.record(m, {
    input_tokens: meta.promptTokenCount ?? 0,
    output_tokens: meta.candidatesTokenCount ?? 0,
  });
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return extractJson(text);
}

export async function scoreBatch({ system, historyText, payload, schema, usage }) {
  const out = await call(system, buildScoringUser(historyText, payload), schema, usage);
  return out.stories ?? [];
}

export async function writeDigest({ system, payload, schema, usage }) {
  return call(system, buildDigestUser(payload), schema, usage);
}
