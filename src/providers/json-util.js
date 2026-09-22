/**
 * Extracts a JSON object from model output that may be wrapped in code fences or
 * prose. Needed for providers without hard structured-output enforcement
 * (claude-code CLI); harmless for those with it.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty model output');
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in model output');

  return JSON.parse(t.slice(start, end + 1));
}
