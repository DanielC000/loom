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
// Resume is gated by the shared canResumeSession (lib/sessions.ts) — NOT a bare
// `processState === "exited"` check. A session leaves "exited" for "archived" within the same
// onExit handler that set it, so a caller sourced from the rail/god-eye lists (which exclude
// archived rows) would otherwise never see the exited state long enough to offer Resume (finding
// #15). canResumeSession also treats an already-archived row (archivedAt set) as resumable, so a
// caller that folds archived sessions in (e.g. the Overview fleet accordion) gets a working Resume
// through that path too — both branches call the same resumeSession mutation.
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
      {live && s.role !== "worker" && <Button disabled={ending || s.busy}
        title="Run /loom-session-end to log progress + leave it resumable, then stop this session (graceful, resumable — lives on Archive)."
        onClick={(ev) => { ev.stopPropagation(); onEnd(); }}>End Session</Button>}
      {live && <Button disabled={forking || s.busy} onClick={(ev) => { ev.stopPropagation(); onFork(); }}
        title={s.busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}>Fork</Button>}
      {live && <Button disabled={stopping} title="Stop this session — graceful Ctrl-C, clean and resumable"
        onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>}
      {canResume && <Button disabled={resuming} title="Resume this session and attach its terminal" onClick={onResume}>Resume</Button>}
      {s.resumability === "dead" && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>dead</span>}
    </>
  );
}
