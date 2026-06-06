import type { Session } from "@loom/shared";
import { Button } from "./ui";
import { color, font } from "../theme";

// The per-session quick-action cluster — Clear-rate-limit / Fork / Stop / Resume / Archive — with its
// per-state gating. Extracted VERBATIM from Workspace's SessionRow so the Workspace single-session
// cockpit and the Overview fleet-accordion cockpit drive the SAME buttons with identical gating,
// titles, and event handling (no divergence). The state predicates (live / canResume / rateLimited)
// are computed here from `s`; the caller owns the mutations and passes the handlers + pending flags.
// The archive confirm (a manager's worker-count cascade prompt) lives in the CALLER's onArchive, so
// each page keeps its own confirm wording — this component just invokes it. Typed on `Session`, so it
// accepts a `SessionListItem` (which extends Session) unchanged.
//
// Note the `ev.stopPropagation()` on Fork/Stop/Clear/Archive: these buttons can sit next to a
// click-to-select row, so the click must not bubble to the row's onSelect. Resume keeps no
// stopPropagation, matching the original SessionRow exactly.
export function SessionActions({
  s, onResume, resuming, onStop, stopping, onFork, forking, onClearRateLimit, clearingRateLimit, onArchive, archiving,
}: {
  s: Session;
  onResume: () => void; resuming: boolean;
  onStop: () => void; stopping: boolean;
  onFork: () => void; forking: boolean;
  onClearRateLimit: () => void; clearingRateLimit: boolean;
  onArchive: () => void; archiving: boolean;
}) {
  const canResume = s.processState === "exited" && s.resumability !== "dead";
  const live = s.processState === "live";
  const rateLimited = !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
  return (
    <>
      {rateLimited && <Button disabled={clearingRateLimit} title="Clear the rate-limit hold + the global usage latch and re-submit the held turn now (mirrors the auto-resume path)"
        onClick={(ev) => { ev.stopPropagation(); onClearRateLimit(); }}>Clear rate limit &amp; retry now</Button>}
      {live && <Button disabled={forking || s.busy} onClick={(ev) => { ev.stopPropagation(); onFork(); }}
        title={s.busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}>Fork</Button>}
      {live && <Button disabled={stopping} title="Stop this session — graceful Ctrl-C, clean and resumable"
        onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>}
      {canResume && <Button disabled={resuming} title="Resume this session and attach its terminal" onClick={onResume}>Resume</Button>}
      {s.resumability === "dead" && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>dead</span>}
      {/* Archive is exited-only (a live session must be stopped first) — moves it (and a manager's
          workers) out of the rail into the Archive tab. */}
      {!live && <Button disabled={archiving} title="Archive this session out of the rail (a manager archives its workers too)"
        onClick={(ev) => { ev.stopPropagation(); onArchive(); }}>Archive</Button>}
    </>
  );
}
