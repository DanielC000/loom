import type { Session } from "@loom/shared";
import { Button } from "./ui";

/**
 * WHETHER End Session is offered at all — the role + liveness half of its gating, as ONE predicate.
 *
 * Extracted by card 102bc915, which gave the Atlas session node its own End Session; the classic
 * Overview's fleet cluster that used to hold the only copy went with that page (card acbb6df6).
 *
 * NON-WORKER is the load-bearing half: a human must never end a worker out from under the manager
 * that dispatched it. The BUSY half is deliberately NOT here — it belongs to the button, because it
 * disables rather than hides (an idle-gated control that vanished mid-turn would read as broken).
 *
 * Typed on the two fields it READS rather than on `Session`, so the session node's own narrower
 * `SessionNodeRow` (a Pick + Partial of `SessionListItem`) satisfies it without a cast. A full
 * `Session` still does — every field it names is optional here and present there.
 *
 * @decision 102bc915 — every End Session mount must read THIS predicate and render EndSessionButton.
 * A second copy of "live and not a worker" is how one surface keeps offering it after the other stops.
 */
export function canEndSession(s: Partial<Pick<Session, "role" | "processState">>): boolean {
  return s.processState === "live" && s.role !== "worker";
}

/** The End Session control itself — one label, one hover text, one idle gate, both mounts. */
export function EndSessionButton({ s, onEnd, ending, style }: {
  s: Partial<Pick<Session, "busy">>; onEnd: () => void; ending: boolean; style?: React.CSSProperties;
}) {
  return (
    <Button disabled={ending || s.busy} style={style}
      title="Run /loom-session-end to log progress + leave it resumable, then stop this session (graceful, resumable — lives on Archive)."
      onClick={(ev) => { ev.stopPropagation(); onEnd(); }}>End Session</Button>
  );
}
