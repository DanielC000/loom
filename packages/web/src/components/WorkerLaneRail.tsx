// The worker LANE RAIL beside a manager's terminal (card dd5c8724, owner pick "C · Lane rail",
// request 050b30ba). One lane per worker this manager runs: status, card, where it is on the
// dispatch → review → merge track, its last report, context and any gate timer. Selecting a lane
// reveals its hops out (Review diff, Session, Card). Derivations live in lib/workerLanes.ts.
//
// Reads ONLY existing cache entries — `["allSessions"]` (kept live over /ws/fleet), `["tasks", projectId]`,
// `["orchEvents", managerId]` (shared with the Timeline tab and the card dialog) and `["gates-active"]`
// (shared with the Gates page, polled only while a lane is live). The merge write path stays on the
// review surface; this rail only links to it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { workerReviewPath, workerSessionPath } from "../lib/cardWorker";
import {
  LANE_STEPS, LANE_STEP_LABEL, buildWorkerLanes, finishedRecently, formatElapsed, formatGateTimer, managerWorkers,
  workerLaneCtx, type FinishedOutcome, type WorkerLane,
} from "../lib/workerLanes";
import type { SessionListItem, Task } from "@loom/shared";
import { Dot, Meter, Panel, StatusPill } from "./ui";
import type { Tone } from "../theme";

const OUTCOME_TONE: Record<FinishedOutcome, Tone> = { merged: "live", stopped: "muted", exited: "muted" };

/** A clock for the elapsed readings: every second while a gate timer is on screen, else every 15s. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), fast ? 1000 : 15_000);
    return () => clearInterval(id);
  }, [fast]);
  return now;
}

function cardPath(taskId: string): string {
  return `/board?task=${encodeURIComponent(taskId)}`;
}

function Lane({ lane, task, now, selected, onSelect }: {
  lane: WorkerLane<SessionListItem>;
  task: Task | undefined;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { worker: w, status, step, report, reviewPending, gate } = lane;
  const at = LANE_STEPS.indexOf(step);
  const ctx = workerLaneCtx(w);
  const age = formatElapsed(w.createdAt, now);
  const reportAge = report ? formatElapsed(report.ts, now) : null;
  const taskId = w.taskId ?? null;
  // The current step wears the pill's own tone, so the track and the pill always say the same thing.
  const nowTone = status.tone;
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return; // a focused action link handles its own Enter
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); }
  };
  return (
    <li className={`loom-wlane${selected ? " is-selected" : ""}`} tabIndex={0} onClick={onSelect} onKeyDown={onKey}
      aria-current={selected ? "true" : undefined} data-testid="worker-lane" data-worker-id={w.id}
      data-step={step} data-status={status.key} aria-label={`${w.agentName}, ${status.label}, ${LANE_STEP_LABEL[step]}`}>
      <div className="loom-wlane-top">
        <StatusPill tone={status.tone} label={status.label} data-testid="worker-lane-status" />
        <b className="loom-wlane-name">{w.agentName}</b>
        <span className="loom-wlane-id">{w.id.slice(0, 8)}</span>
        <span className="loom-wlane-grow" />
        {age && <span className="loom-wlane-meta" title="Since dispatch">{age}</span>}
      </div>
      <div className="loom-wlane-title" data-testid="worker-lane-title">
        {taskId && <span className="loom-wlane-taskid">#{taskId.slice(0, 8)}</span>}
        {task?.title ?? (w.branch ? <span className="loom-wlane-branch">{w.branch}</span> : null)}
      </div>
      <div className="loom-wlane-track" aria-hidden="true">
        {LANE_STEPS.map((s, k) => (
          <i key={s} className={k < at ? "is-done" : k === at ? `is-now tone-${nowTone}` : undefined} />
        ))}
      </div>
      <div className="loom-wlane-steps" data-testid="worker-lane-steps">
        {LANE_STEPS.map((s, k) => (
          <span key={s} className={k === at ? "is-now" : undefined} aria-current={k === at ? "step" : undefined}>
            {LANE_STEP_LABEL[s]}
          </span>
        ))}
      </div>
      {report?.status === "blocked" && report.needs ? (
        <div className="loom-wlane-rep is-needs" title={report.needs}>Needs: {report.needs}</div>
      ) : report?.summary ? (
        <div className="loom-wlane-rep" title={report.summary}>{report.summary}</div>
      ) : (
        <div className="loom-wlane-rep is-none">No report yet</div>
      )}
      <div className="loom-wlane-bot">
        {ctx && (
          <span className="loom-wlane-ctx" title="Context used">
            <Meter value={ctx.pct} max={100} tone={ctx.warn ? "attn" : "accent"} width={56} />
            <span className={ctx.warn ? "is-warn" : undefined}>{ctx.pct}%</span>
          </span>
        )}
        {gate && (
          <span className={`loom-wlane-gate${gate.phase === "queued" ? " is-queued" : ""}`} data-testid="worker-lane-gate">
            {gate.kind === "merge" ? "merge gate" : "self-check"}
            {gate.phase === "queued" ? " queued " : " "}
            {formatGateTimer(gate.since, now)}
          </span>
        )}
        <span className="loom-wlane-grow" />
        {reportAge && <span className="loom-wlane-meta" title="Since the last report">{reportAge} ago</span>}
      </div>
      <div className="loom-wlane-acts" data-testid="worker-lane-actions">
        {reviewPending && (
          <Link to={workerReviewPath(w.id)} className="loom-btn loom-btn-primary loom-wlane-act" data-testid="worker-lane-review"
            title="Open this branch's diff to review the merge request">
            Review diff <span aria-hidden>↗</span>
          </Link>
        )}
        <Link to={workerSessionPath(w.id)} className="loom-btn loom-btn-default loom-wlane-act" data-testid="worker-lane-session"
          title={`Open ${w.agentName}'s session`}>
          Session <span aria-hidden>↗</span>
        </Link>
        {taskId && (
          <Link to={cardPath(taskId)} className="loom-btn loom-btn-ghost loom-wlane-act" data-testid="worker-lane-card"
            title="Open this worker's card on the board">
            Card
          </Link>
        )}
      </div>
    </li>
  );
}

export function WorkerLaneRail({ managerId, projectId }: { managerId: string; projectId: string | undefined }) {
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const events = useQuery({ queryKey: ["orchEvents", managerId], queryFn: ({ signal }) => api.orchestrationEvents(managerId, signal) });
  const workers = useMemo(() => managerWorkers(sessionsQ.data, managerId), [sessionsQ.data, managerId]);
  const anyLive = workers.some((w) => w.processState === "live" || w.processState === "starting");
  const gatesQ = useQuery({
    queryKey: ["gates-active"],
    queryFn: ({ signal }) => api.gatesActive(signal),
    refetchInterval: 3000,
    enabled: anyLive,
  });
  const tasksQ = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: ({ signal }) => api.tasks(projectId ?? "", signal),
    staleTime: 4000,
    enabled: !!projectId && workers.length > 0,
  });

  const hasGate = workers.some((w) => w.pendingMerge?.state === "running")
    || !!gatesQ.data?.gates.some((g) => g.gateType === "worker" && workers.some((w) => w.id === g.sessionId));
  const now = useNow(hasGate);
  const lanes = useMemo(() => buildWorkerLanes(workers, events.data, gatesQ.data?.gates, now),
    [workers, events.data, gatesQ.data, now]);
  const finished = useMemo(() => finishedRecently(events.data, new Set(workers.map((w) => w.id)), now),
    [events.data, workers, now]);
  const taskById = useMemo(() => new Map((tasksQ.data ?? []).map((t) => [t.id, t])), [tasksQ.data]);
  const nameById = useMemo(() => new Map((sessionsQ.data ?? []).map((s) => [s.id, s.agentName])), [sessionsQ.data]);

  // The first lane is selected until the reader picks another, as in the mockup: the lane that most needs
  // a look has its actions out without a click. A selection that leaves the list falls back the same way.
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = lanes.some((l) => l.worker.id === picked) ? picked : (lanes[0]?.worker.id ?? null);

  // The phone strip is scroll-snapped, and a snap container RE-SNAPS to the lane it was on when the order
  // changes. The order does change on load (reports arrive after the session rows and re-sort the lanes),
  // so without this the strip opened mid-way, on whichever lane happened to sort first before the events
  // landed. Re-anchor on every order change: the start of the strip, or the lane the reader picked.
  const stackRef = useRef<HTMLUListElement>(null);
  const order = lanes.map((l) => l.worker.id).join(",");
  useLayoutEffect(() => {
    const el = stackRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return; // the vertical rail: nothing snaps sideways
    const target = picked ? el.querySelector<HTMLElement>(`[data-worker-id="${CSS.escape(picked)}"]`) : null;
    el.scrollLeft = target ? target.offsetLeft - el.offsetLeft : 0;
  }, [order]); // deliberately NOT keyed on `picked`: a tap must never yank the strip back

  // Nothing to show at all: on a phone the rail would only push the terminal down for one sentence, so
  // the narrow layout hides it (global.css keys on this class); a wide node keeps the mockup's empty state.
  const empty = lanes.length === 0 && finished.length === 0;
  return (
    <Panel className={`loom-wlanes${empty ? " is-empty" : ""}`} aria-label="Workers" data-testid="worker-lane-rail" role="complementary"
      style={{ padding: 0 }}>
      <div className="loom-wlanes-head">
        <h2>Workers</h2>
        <span className="loom-wlanes-count" data-testid="worker-lane-count">{lanes.length}</span>
        <span className="loom-wlane-grow" />
        <Link to="/board" className="loom-btn loom-btn-ghost loom-wlane-act" data-testid="worker-lane-board">
          Board <span aria-hidden>↗</span>
        </Link>
      </div>
      {lanes.length > 0 ? (
        <ul ref={stackRef} className="loom-wlanes-stack" data-testid="worker-lane-stack">
          {lanes.map((l) => (
            <Lane key={l.worker.id} lane={l} task={l.worker.taskId ? taskById.get(l.worker.taskId) : undefined} now={now}
              selected={l.worker.id === selectedId} onSelect={() => setPicked(l.worker.id)} />
          ))}
        </ul>
      ) : (
        <p className="loom-wlanes-empty" data-testid="worker-lane-empty">
          {sessionsQ.isPending ? "Loading workers…"
            : "No workers running. Each worker this manager dispatches gets a lane here: its card, where it is in dispatch → review → merge, and its last report."}
        </p>
      )}
      {finished.length > 0 && (
        <div className="loom-wlanes-fin" data-testid="worker-lane-finished">
          <span>Finished this hour</span>
          {finished.map((f) => {
            const title = f.taskId ? taskById.get(f.taskId)?.title : undefined;
            const who = nameById.get(f.workerSessionId) ?? `w:${f.workerSessionId.slice(0, 8)}`;
            return (
              <span key={f.workerSessionId} className="loom-wlanes-fin-row" title={title ?? undefined}>
                <Dot tone={OUTCOME_TONE[f.outcome]} style={{ width: 6, height: 6 }} />
                <span className="loom-wlanes-fin-who">{title ?? who}</span>
                <span className="loom-wlane-meta">{f.outcome} {formatElapsed(f.ts, now) ?? ""} ago</span>
              </span>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
