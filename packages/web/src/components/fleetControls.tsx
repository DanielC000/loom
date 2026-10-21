// The four daemon-global fleet controls — clear usage hold / pause / resume / kill all — card
// 7b893d54 (Atlas build plan P2-3). ONE renderer, TWO mounts: the Workspace root's bar and the Atlas
// crumb-bar chip.
//
// @decision 7b893d54 — neither mount may hold paused-state of its own, Mission Control's own
// pause/resume/kill cluster must not be lifted into this module (a source-text test pins its literals),
// and the kill confirm counts live WORKERS because that is all the server actually stops.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UsageLimitsStatus } from "@loom/shared";
import { Badge, Button, Dot, Panel, SectionLabel } from "./ui";
import { BandFoot, PlanUsageDetail } from "./atlasHome";
import { api, orchStatusQuery } from "../lib/api";
import { plural } from "../lib/atlasHome";
import { useDismissable } from "../lib/useDismissable";
import { color, font } from "../theme";

/** Whether orchestration is paused DAEMON-WIDE — the same derivation the classic rail pill and Mission
 *  Control's own badge make, off the same shared `["orchStatus"]` entry. Exported because the Atlas
 *  frame needs it for the topbar's peripheral marker and the chip needs it for its own colour: one
 *  derivation, so the two can never render different answers on one screen. */
export function useOrchestrationPaused(): boolean {
  const status = useQuery({ ...orchStatusQuery() });
  return (status.data?.pausedScopes ?? []).includes("global");
}

/**
 * How many sessions `Kill all` would actually stop.
 *
 * 🔴 Derived to MATCH the server, not the button's name: `SessionService.killAllWorkers` stops the live
 * sessions whose role is `worker` and nothing else — a manager, the Platform Lead and a Companion all
 * survive it — and then pauses orchestration globally. So the confirm counts live WORKERS. Naming a
 * larger set would be a confirm that lies about what the next click does.
 */
function useLiveWorkerCount(): number {
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  return (sessions.data ?? []).filter((s) => s.role === "worker" && s.processState === "live").length;
}

/**
 * Global usage-hold override: drop the awareness latch (~/.loom/tmp/claude-usage.json) so new
 * worker_spawn is unblocked WITHOUT touching any session — for a transient overload with real headroom
 * (the plan-usage gauges beside it show the real account figures). HUMAN-only; mirrors the per-session
 * "clear rate limit" but global. Shows a transient "✓ hold cleared" on success.
 *
 * Lives here rather than in Mission Control so the classic page and both Atlas mounts render ONE
 * implementation of it — the four-second confirmation window included. Failures surface through the
 * app-wide MutationCache handler (main.tsx); a call-site `onError` here would show a second modal.
 */
export function ClearUsageHoldButton({ onCleared }: { onCleared: () => void }) {
  const [done, setDone] = useState(false);
  const clear = useMutation({
    mutationFn: () => api.clearUsageHold(),
    onSuccess: () => { setDone(true); onCleared(); window.setTimeout(() => setDone(false), 4000); },
  });
  return (
    <Button variant="default" disabled={clear.isPending} data-testid="fleet-clear-hold"
      title="Clear the GLOBAL usage hold (the worker_spawn block) without touching any session — for a transient overload"
      onClick={() => clear.mutate()}>
      {done ? "✓ hold cleared" : clear.isPending ? "Clearing…" : "Clear usage hold"}
    </Button>
  );
}

/**
 * THE ONE RENDERER. A state pill, the usage-hold override, a pause/resume control, and a two-step
 * `Kill all`.
 *
 * Pause and Resume are ONE control that swaps on the live state rather than two permanently-lit
 * buttons (the approved round-4 design): both actions stay reachable, each exactly when it means
 * something, and the cluster stays four items wide so it fits the crumb-bar pop-over as well as the
 * full-width bar.
 *
 * ⛔ `Kill all` arms in place — never a modal. A daemon-global hard stop deserves a brake, and Loom
 * confirms destructively-in-place everywhere else it matters (pages/Board.tsx's card delete is the
 * shape this mirrors, down to the "Confirm"/"Cancel" pair).
 */
export function FleetControls({ variant }: { variant: "bar" | "pop" }) {
  const qc = useQueryClient();
  const paused = useOrchestrationPaused();
  const liveWorkers = useLiveWorkerCount();
  const [arming, setArming] = useState(false);

  const refreshStatus = () => qc.invalidateQueries({ queryKey: orchStatusQuery().queryKey });
  const refreshSessions = () => qc.invalidateQueries({ queryKey: ["allSessions"] });
  const pause = useMutation({ mutationFn: () => api.pauseOrchestration(), onSuccess: refreshStatus });
  const resume = useMutation({ mutationFn: () => api.resumeOrchestration(), onSuccess: refreshStatus });
  // killAllWorkers pauses globally as well as stopping the workers, so BOTH caches are invalidated —
  // the pill flips to "paused" off the same call that empties the fleet.
  const kill = useMutation({
    mutationFn: () => api.killOrchestration(),
    onSuccess: () => { setArming(false); refreshStatus(); refreshSessions(); },
  });

  return (
    <div className={`loom-fleetctl${variant === "pop" ? " is-pop" : ""}`} data-testid={`fleet-controls-${variant}`}>
      <Badge tone={paused ? "red" : "phosphor"} data-testid="fleet-orch-pill">
        {paused ? "orchestration: paused" : "orchestration: running"}
      </Badge>

      <ClearUsageHoldButton onCleared={refreshSessions} />

      {paused ? (
        <Button variant="default" disabled={resume.isPending} data-testid="fleet-resume"
          title="Resume orchestration daemon-wide" onClick={() => resume.mutate()}>
          {resume.isPending ? "Resuming…" : "Resume"}
        </Button>
      ) : (
        <Button variant="default" disabled={pause.isPending} data-testid="fleet-pause"
          title="Pause orchestration daemon-wide — no new worker is dispatched" onClick={() => pause.mutate()}>
          {pause.isPending ? "Pausing…" : "Pause"}
        </Button>
      )}

      {arming ? (
        <>
          <span className="loom-fleetctl-ask" data-testid="fleet-kill-ask">
            Kill all {plural(liveWorkers, "live worker")}?
          </span>
          <Button variant="danger" disabled={kill.isPending} data-testid="fleet-kill-confirm"
            title="Hard-stop every live worker across every project, and pause orchestration"
            onClick={() => kill.mutate()}>
            {kill.isPending ? "Killing…" : "Confirm"}
          </Button>
          <Button disabled={kill.isPending} data-testid="fleet-kill-cancel"
            onClick={() => setArming(false)}>Cancel</Button>
        </>
      ) : (
        <Button variant="danger" disabled={liveWorkers === 0} data-testid="fleet-kill"
          title={liveWorkers === 0
            ? "No live worker to stop — Pause is the control for holding the fleet"
            : "Hard-stop every live worker across every project, and pause orchestration"}
          onClick={() => setArming(true)}>Kill all</Button>
      )}
    </div>
  );
}

/** MOUNT 1 — the Workspace root's own bar, directly under the KPI deck. Full width because these are
 *  the only controls on the page that act on everything at once; a band column would read as one
 *  project's worth of scope. */
export function FleetControlsBar() {
  return (
    <Panel className="loom-bandpanel loom-fleetbar" data-testid="atlas-fleet-controls-bar">
      <div className="loom-fleetbar-row">
        <SectionLabel style={{ margin: 0, whiteSpace: "nowrap" }}>Fleet controls</SectionLabel>
        <span className="loom-fleetbar-note">daemon-global · every project</span>
        <span style={{ flex: 1 }} />
        <FleetControls variant="bar" />
      </div>
    </Panel>
  );
}

const ORCH_POP_ID = "atlas-orch-pop";

/** MOUNT 2 — the always-present chip in the Atlas crumb bar. Its JOB is the peripheral read: paused is
 *  a state you must not be able to miss from any node, so the chip turns red (and the frame takes a
 *  red inset, see AtlasShell) wherever you are. Clicking it opens the same cluster over the plan-usage
 *  gauges, which are the context that makes "clear usage hold" a judgement rather than a guess. */
export function OrchestrationChip() {
  const [open, setOpen] = useState(false);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  const paused = useOrchestrationPaused();
  // Gated on `open`: the chip itself costs nothing (the two entries it reads are already shell-wide in
  // BOTH shells — the classic rail reads `["orchStatus"]` and `["allSessions"]` on every page), but a
  // shell-wide usage subscription would be a poll neither shell makes today. Same `["usageLimits"]`
  // entry the Workspace node and the classic PlanUsageStrip fill, so an open pop-over reuses whatever
  // is already cached rather than issuing its own read.
  const usageQ = useQuery<UsageLimitsStatus>({
    queryKey: ["usageLimits"], queryFn: api.usageLimits, enabled: open,
  });
  const usage = usageQ.data?.available ? usageQ.data : null;

  return (
    <div className="loom-orch-slot" ref={ref}>
      <button type="button" className={`loom-orchchip${paused ? " is-paused" : ""}`}
        data-testid="atlas-orch-chip" aria-expanded={open} aria-controls={open ? ORCH_POP_ID : undefined}
        title={paused
          ? "Orchestration is PAUSED daemon-wide — no new worker is dispatched. Open the fleet controls."
          : "Orchestration is running. Open the fleet controls (usage hold, pause, kill all)."}
        onClick={() => setOpen((o) => !o)}>
        <Dot tone={paused ? "red" : "phosphor"} />
        {paused ? "paused" : "running"}
      </button>

      {open && (
        // ⛔ The right-edge anchoring is CSS, not an inline style: the narrow-viewport rule has to be
        // able to override it (an inline `right` wins over a media query and strands the panel against
        // the viewport edge). See `.loom-orch-pop` in styles/global.css.
        <div id={ORCH_POP_ID} className="loom-kpi-pop loom-orch-pop" data-testid="atlas-orch-pop">
          <div className="loom-kpi-pophead">
            <SectionLabel style={{ margin: 0 }}>Fleet controls</SectionLabel>
            <span className="loom-bandcount">daemon-global</span>
            <span style={{ flex: 1 }} />
            <Link to="/home" className="loom-btn loom-btn-default loom-bandlink"
              title="Open the Workspace root" onClick={() => setOpen(false)}>
              Workspace <span aria-hidden>↗</span>
            </Link>
            <Button variant="ghost" data-testid="atlas-orch-close" aria-label="Close the fleet controls"
              title="Close" onClick={() => setOpen(false)} style={{ padding: "0 6px", lineHeight: 1.2 }}>×</Button>
          </div>
          <div className="loom-kpi-popbody">
            <SectionLabel style={{ margin: "0 0 6px", color: color.textMuted }}>Plan usage</SectionLabel>
            <PlanUsageDetail usage={usage} />
            <FleetControls variant="pop" />
            {/* The scope question the round-4 mockup explicitly left open, answered from the daemon:
                sessions/service.ts › killAllWorkers filters role==="worker" && live, then pauses
                "global". Stated here because a destructive control that overstates its reach is
                exactly as misleading as one that understates it. */}
            <BandFoot>
              Clearing the hold drops the global <code style={{ color: color.cyan, fontFamily: font.mono }}>worker_spawn</code> latch
              without touching a session. <b style={{ color: color.textDim }}>Kill all</b> hard-stops every live
              WORKER across every project and pauses orchestration — a manager, the Platform Lead and a
              Companion are left running.
            </BandFoot>
          </div>
        </div>
      )}
    </div>
  );
}
