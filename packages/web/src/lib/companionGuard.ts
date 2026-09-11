import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { isCompanionSession } from "./sessions";

/**
 * Companion resolution for a rendered terminal (card 5c87f4b6) — resolved from the session STORE, never
 * from a caller-supplied prop.
 *
 * ⚠️ NOT fail-closed in the pending case. Read the window below before trusting this either way.
 *
 * @decision 5c87f4b6 — resolve companion status from the session STORE, never a caller-supplied
 * `role` prop: a prop can be omitted and fails open; a store lookup cannot.
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
 * @decision 5c87f4b6 — the pending-window gap is harmless: the guard re-arms once the query lands,
 * and the daemon refuses a companion stdin write server-side regardless.
 *
 * ⛔ do not "harden" this to `data ?? true` — the pending-⇒-false behaviour is pinned by an
 * assertion in test/companion-terminal-guard.mjs so it stays a tested decision.
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
