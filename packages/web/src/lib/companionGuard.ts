import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { isCompanionSession } from "./sessions";

/**
 * Companion resolution for a rendered terminal (card 5c87f4b6) — resolved from the session STORE, never
 * from a caller-supplied prop.
 *
 * ⚠️ NOT fail-closed in the pending case. Read the window below before trusting this either way.
 *
 * WHY THE STORE RATHER THAN A PROP: the natural fix — "have the terminal read `session.role`" — fails
 * OPEN. `TerminalCardSession` types `role` as OPTIONAL, so a caller can simply not pass it, and
 * `undefined === "assistant"` is false ⇒ a fully writable Composer + stdin for a Companion. That would
 * have swapped "a caller forgets `readOnly`" (the original defect) for "a caller omits `role`" — the same
 * bug one layer down, in the very place it was put so it couldn't drift. A caller supplies only the id it
 * must already have to attach a terminal at all, and there is no field it can omit its way past.
 *
 * It reads the shared ["allSessions"] query — the same key/queryFn every session surface already polls,
 * so react-query dedups it to ZERO extra network. `select` narrows the result to a boolean, so a
 * subscribed terminal re-renders only when that boolean actually flips, not on every 3s poll.
 *
 * ── THE PENDING WINDOW (deliberate; do not "fix" it) ───────────────────────────────────────────────
 * `data` is `undefined` until ["allSessions"] first resolves, and this returns `false` for it. So on a
 * COLD cache — a hard refresh or a pasted/bookmarked deep link, not an in-app navigation — a Companion's
 * terminal is briefly writable until the query lands.
 *
 * That `false` collapses two genuinely different unknowns into one answer, and only one of them is a real
 * fact: "resolved, and this id is not a session" (a raw shell — correct and load-bearing, see
 * isCompanionSession) versus "not resolved yet" (a guess, and it guesses open). The distinction is real;
 * the resolution below is a judgement call, not an oversight.
 *
 * WHY THE WINDOW IS HARMLESS: the guard genuinely re-arms when the query lands — the derived `readOnly`
 * is in TerminalPane's attach-effect dependency array, so the effect re-runs and xterm is reconstructed
 * with `disableStdin`. And the daemon refuses a companion stdin write server-side regardless
 * (`role !== "assistant"` on both /ws/term and POST /api/sessions/:id/input), so nothing can actually be
 * written during the window. What remains is the original cosmetic silence, for milliseconds.
 *
 * ⛔ WHY PENDING-⇒-WATCH-ONLY WAS REJECTED — do not "harden" this to `data ?? true`: ["allSessions"] is a
 * SINGLE shared query, so treating pending as companion would briefly disable stdin on EVERY worker,
 * manager and shell terminal on a cold load, then tear down and re-attach each websocket when it flips.
 * That is a visible regression to normal sessions, which this card's DoD explicitly forbids ("a NORMAL
 * worker session ⇒ still fully writable, unchanged"). Trading a real regression for every session against
 * a millisecond of cosmetic silence for one is the wrong direction. The pending-⇒-false behaviour is
 * pinned by an assertion in test/companion-terminal-guard.mjs so it stays a tested decision.
 *
 * A RAW SHELL is not a DB Session and has no row here ⇒ `false` ⇒ it keeps taking keystrokes, unchanged.
 * That is the intended answer, not a gap: see isCompanionSession's own note on why an unknown role must
 * NOT read as watch-only.
 */
export function useIsCompanionSession(sessionId: string): boolean {
  const { data } = useQuery({
    queryKey: ["allSessions"],
    queryFn: api.allSessions,
    select: (rows) => isCompanionSession(rows.find((s) => s.id === sessionId)),
  });
  // PENDING (`undefined`) ⇒ false ⇒ writable. Deliberate, and NOT fail-closed — see the pending-window
  // note above for why `?? true` was rejected. Pinned by test/companion-terminal-guard.mjs.
  return data ?? false;
}
