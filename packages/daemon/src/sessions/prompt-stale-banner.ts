/**
 * Card c8f855e1 — advisory `[loom:prompt-stale]` banner for a kickoff that asserts a first-run / new-project /
 * empty-board state on a project whose live board has long since filled up.
 *
 * ADVISORY ONLY: {@link composePromptStaleBanner} PREPENDS a short banner and never rewrites the brief. The
 * detector deliberately errs toward NOT firing — a false banner on every spawn teaches agents to ignore it —
 * so it matches only declarative present-tense claims ("This is a new project", "The board is empty") and
 * vetoes any sentence where a conditional/negating lead precedes the match ("On a first run, ...", "If the
 * board is empty, ..."). A bare imperative ("bootstrap the board") is NOT a trigger: a token match there
 * cannot tell a conditional instruction from an assertive claim.
 */
import type { SessionRole } from "@loom/shared";

export const PROMPT_STALE_TAG = "[loom:prompt-stale]";
/** The banner fires only when the project board holds MORE than this many cards. */
export const PROMPT_STALE_BOARD_THRESHOLD = 10;

const ASSERTIVE_CLAIMS: RegExp[] = [
  /\bthis\s+is\s+(?:a\s+|an\s+|our\s+)?(?:brand[- ]?new|new|fresh|greenfield)\s+(?:project|board|workspace|repo(?:sitory)?|codebase)\b/i,
  /\bthis\s+is\s+(?:the|a|your|our)\s+(?:very\s+)?first[- ]run\b/i,
  /\b(?:the|your|this)\s+(?:project\s+)?board\s+is\s+(?:currently\s+|still\s+|totally\s+)?(?:empty|blank|fresh)\b/i,
  /\b(?:with|has|have|having|starts?\s+with)\s+(?:an\s+)?empty\s+board\b/i,
  /\bthere\s+are\s+no\s+(?:cards|tasks)\s+(?:yet|on\s+the\s+board)\b/i,
  /\byou\s+are\s+(?:just\s+)?(?:starting|beginning|bootstrapping)\s+(?:a\s+|an\s+)?(?:brand[- ]?new|new|fresh)\s+project\b/i,
  /\b(?:the|this)\s+project\s+is\s+(?:brand[- ]?new|greenfield)\b/i,
];

/** A lead-in that makes a matching sentence conditional or negated, not a claim. */
const CONDITIONAL_LEAD =
  /\b(?:if|when|whenever|unless|in\s+case|should|once|until|assuming|provided|not|never|no\s+longer|on\s+(?:a|the|your)\s+(?:very\s+)?first[- ]run|on\s+first[- ]run|for\s+a|for\s+an)\b|n't\b/i;
const CONDITIONAL_TRAIL = /^\W*(?:unless|if|until)\b/i;

/** The agent's own brief: everything before the first Loom-appended `[loom:` section, quotes/code removed. */
function briefSpan(prompt: string): string {
  const cut = prompt.indexOf("[loom:");
  const head = cut === -1 ? prompt : prompt.slice(0, cut);
  return head
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
}

/** True when the agent's own brief makes an ASSERTIVE (non-conditional) first-run / empty-board claim. */
export function detectFirstRunClaim(prompt: string): boolean {
  const sentences = briefSpan(prompt).split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    for (const re of ASSERTIVE_CLAIMS) {
      const m = re.exec(s);
      if (!m) continue;
      if (CONDITIONAL_LEAD.test(s.slice(0, m.index))) continue;
      if (CONDITIONAL_TRAIL.test(s.slice(m.index + m[0].length))) continue;
      return true;
    }
  }
  return false;
}

export function composePromptStaleBanner(
  prompt: string,
  ctx: { role?: SessionRole | null; countBoardCards: () => number },
): string {
  // A worker's kickoff is a per-task manager message that routinely QUOTES these phrases; the drift this
  // guards is a standing agent brief.
  if (ctx.role === "worker" || !prompt || prompt.startsWith(PROMPT_STALE_TAG)) return prompt;
  if (!detectFirstRunClaim(prompt)) return prompt; // cheap text pre-filter first: the count runs only on a hit
  const cards = ctx.countBoardCards();
  if (!(cards > PROMPT_STALE_BOARD_THRESHOLD)) return prompt;
  return `${PROMPT_STALE_TAG} This brief claims a new project / empty board / first run, but the live board holds ${cards} cards. `
    + `The live board and project memory are authoritative over any such claim in the brief; the brief itself is unchanged below.\n\n${prompt}`;
}
