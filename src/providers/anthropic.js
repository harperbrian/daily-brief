/**
 * Anthropic API provider. The only paid path (~$5-6/month with the caching below).
 * Uses forced tool_choice for hard schema enforcement, and prompt caching on the
 * triage system prompt + history block, which are identical across all batches in
 * a run — that's the bulk of the repeated input tokens.
 */
import { historyBlock, scoringPayloadBlock, buildDigestUser } from './format.js';

export const name = 'anthropic';
export const label = 'Anthropic API';
export const concurrency = 3; // parallel batches; higher risks 429s on low API tiers

let clientPromise;
function getClient() {
  clientPromise ??= import('@anthropic-ai/sdk').then(
    (m) => new m.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  );
  return clientPromise;
}

export async function scoreBatch({ system, historyText, payload, schema, usage }) {
  const client = await getClient();
  const model = process.env.TRIAGE_MODEL ?? 'claude-haiku-4-5-20251001';
  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: historyBlock(historyText), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: scoringPayloadBlock(payload) }],
    tools: [
      { name: 'submit_scores', description: 'Submit triage scores for every candidate.', input_schema: schema },
    ],
    tool_choice: { type: 'tool', name: 'submit_scores' },
  });

  usage?.record(model, res.usage);
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('model returned no tool_use block');
  return block.input.stories ?? [];
}

export async function writeDigest({ system, payload, schema, usage }) {
  const client = await getClient();
  const model = process.env.WRITER_MODEL ?? 'claude-sonnet-5';
  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: buildDigestUser(payload) }],
    tools: [
      { name: 'submit_digest', description: 'Submit the finished daily brief.', input_schema: schema },
    ],
    tool_choice: { type: 'tool', name: 'submit_digest' },
  });

  usage?.record(model, res.usage);
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('model returned no tool_use block');
  return block.input;
}
