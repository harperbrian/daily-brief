/**
 * Provider selection, as an ordered CASCADE rather than a single pick. Every
 * available credential is chained: if the primary fails at 6:30 AM, the next one
 * takes over automatically and the brief still lands.
 *
 * Default order (free first, most capable first within free):
 *   CLAUDE_CODE_OAUTH_TOKEN → claude-code   $0 extra on a Claude Pro/Max plan
 *   GEMINI_API_KEY          → gemini        $0, Google free tier
 *   ANTHROPIC_API_KEY       → anthropic     metered, hard schema enforcement
 *   (always last)           → heuristic     $0 forever, rules only, cannot fail
 *
 * MODEL_PROVIDER forces one to lead; the rest still follow it as fallbacks.
 * MODEL_PROVIDER=heuristic disables models entirely.
 */
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import * as claudeCode from './claude-code.js';
import * as heuristic from './heuristic.js';

const REGISTRY = { anthropic, gemini, 'claude-code': claudeCode, heuristic, none: heuristic };
const DEFAULT_ORDER = ['claude-code', 'gemini', 'anthropic'];

const CREDENTIAL = {
  'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export const heuristicProvider = heuristic;

/**
 * Returns { primary, chain } where chain is every usable provider in order,
 * always ending in heuristic so the pipeline can never run out of options.
 */
export function pickProvider(env, log) {
  const forced = (env.MODEL_PROVIDER ?? '').trim().toLowerCase() || null;
  if (forced && !REGISTRY[forced]) {
    throw new Error(
      `unknown MODEL_PROVIDER "${forced}" — expected anthropic | gemini | claude-code | heuristic`
    );
  }

  if (forced === 'heuristic' || forced === 'none') {
    log(`model provider: ${heuristic.label} (forced)`);
    return { primary: heuristic, chain: [heuristic] };
  }

  // Available = has its credential. claude-code is allowed without one so a
  // local run can use the developer's own CLI login.
  const available = DEFAULT_ORDER.filter(
    (n) => env[CREDENTIAL[n]] || (n === 'claude-code' && forced === 'claude-code')
  );

  if (forced && !available.includes(forced)) {
    throw new Error(`MODEL_PROVIDER=${forced} but ${CREDENTIAL[forced]} is not set`);
  }

  // Forced provider leads; everything else keeps its default relative order.
  const ordered = forced ? [forced, ...available.filter((n) => n !== forced)] : available;
  const chain = [...ordered.map((n) => REGISTRY[n]), heuristic];

  if (ordered.length === 0) {
    log(`model provider: ${heuristic.label} — no model credentials found`);
  } else {
    log(`model provider: ${chain[0].label}${chain.length > 1 ? ` (fallbacks: ${chain.slice(1).map((p) => p.name).join(' → ')})` : ''}`);
    if (ordered[0] === 'claude-code' && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      log('  no CLAUDE_CODE_OAUTH_TOKEN — relying on local CLI auth', 'warn');
    }
  }

  return { primary: chain[0], chain };
}
