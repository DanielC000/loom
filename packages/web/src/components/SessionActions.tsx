import type { Session } from "@loom/shared";
import { Button } from "./ui";
import { color, font } from "../theme";
import { canResumeSession } from "../lib/sessions";

// The per-session quick-action cluster — Clear-rate-limit / Fork / Stop / Resume — with its
// per-state gating. The Workspace cockpit and the Overview fleet-accordion cockpit drive the SAME
// buttons with identical gating, titles, and event handling (no divergence). The state predicates
// (live / canResume / rateLimited) are computed here from `s`; the caller owns the mutations and
// passes the handlers + pending flags. Typed on `Session`, so it accepts a `SessionListItem` (which
// extends Session) unchanged.
//
// Manual archive was REMOVED (archiving is now automatic on session exit — Card A); stopped sessions
// live on the Archive page. There is no manual-archive button here anymore.
//
// @decision b37750a4 — Resume is gated by the shared canResumeSession (lib/sessions.ts), never a bare
// `processState === "exited"` check: a session can leave "exited" for "archived" within the same onExit
// handler that set it, so canResumeSession also treats an already-archived row as resumable.
//
// Note the `ev.stopPropagation()` on Fork/Stop/Clear: these buttons can sit next to a
// click-to-select row, so the click must not bubble to the row's onSelect. Resume keeps no
// stopPropagation, matching the original SessionRow exactly.
export function SessionActions({
  s, onResume, resuming, onStop, stopping, onFork, forking, onEnd, ending, onClearRateLimit, clearingRateLimit,
}: {
  s: Session;
  onResume: () => void; resuming: boolean;
  onStop: () => void; stopping: boolean;
  onFork: () => void; forking: boolean;
  onEnd: () => void; ending: boolean;
  onClearRateLimit: () => void; clearingRateLimit: boolean;
}) {
  const canResume = canResumeSession(s);
  const live = s.processState === "live";
  const rateLimited = !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
  return (
    <>
      {rateLimited && <Button disabled={clearingRateLimit} title="Clear the rate-limit hold + the global usage latch and re-submit the held turn now (mirrors the auto-resume path)"
        onClick={(ev) => { ev.stopPropagation(); onClearRateLimit(); }}>Clear rate limit &amp; retry now</Button>}
      {/* End Session — one-click graceful wrap-up (card f55bd338): injects a /loom-session-end + end_me turn.
          Sits LEFT of Fork. NON-worker only — a human must never end a worker out from under its manager
          (the terminal-card cluster renders for manager/platform/setup/auditor; the role guard is the
          explicit backstop). Idle-gated like Fork (disabled while busy). */}
      {canEndSession(s) && <EndSessionButton s={s} onEnd={onEnd} ending={ending} />}
      {live && <Button disabled={forking || s.busy} onClick={(ev) => { ev.stopPropagation(); onFork(); }}
        title={s.busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}>Fork</Button>}
      {live && <Button disabled={stopping} title="Stop this session — graceful Ctrl-C, clean and resumable"
        onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>}
      {canResume && <Button disabled={resuming} title="Resume this session and attach its terminal" onClick={onResume}>Resume</Button>}
      {s.resumability === "dead" && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>dead</span>}
    </>
  );
}

/**
 * WHETHER End Session is offered at all — the role + liveness half of its gating, as ONE predicate.
 *
 * Extracted by card 102bc915, which gave the Atlas session node its own End Session. Before that this
 * rule was inline in the cluster above and the cluster had exactly one mount (the classic Overview's
 * fleet accordion), so retiring /overview would have taken End Session out of the product entirely —
 * it is the only action with no other home: Fork and Stop live on the Sessions tab and the session
 * node, Resume on the Archive tab, and Clear-rate-limit on an attention row.
 *
 * NON-WORKER is the load-bearing half: a human must never end a worker out from under the manager
 * that dispatched it. The BUSY half is deliberately NOT here — it belongs to the button, because it
 * disables rather than hides (an idle-gated control that vanished mid-turn would read as broken).
 *
 * Typed on the two fields it READS rather than on `Session`, so the session node's own narrower
 * `SessionNodeRow` (a Pick + Partial of `SessionListItem`) satisfies it without a cast. A full
 * `Session` still does — every field it names is optional here and present there.
 *
 * @decision 102bc915 — both End Session mounts must read THIS predicate and render EndSessionButton.
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
