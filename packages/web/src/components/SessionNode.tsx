import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api, workerDiffQuery } from "../lib/api";
import { useAtlasNodeHeadSlot } from "../lib/atlasNodeHead";
import { plural } from "../lib/atlasHome";
import { harnessOf } from "../lib/harnessFields";
import { sessionNodeTabHref, sessionNodeTabsFor, type SessionNodeTab } from "../lib/sessionNodeTabs";
import { useStopSession, useForkSession, useEndSession } from "../lib/useSessionActions";
import { EndSessionButton, canEndSession } from "./SessionActions";
import { HeadPill } from "./atlasHome";
import { TerminalCard, type TerminalTabs } from "./TerminalCard";
import { ReviewSurface } from "./ReviewSurface";
import { EventRow } from "./fleet";
import { HarnessTag } from "./HarnessPicker";
import { Meter, Panel, StatusPill } from "./ui";
import { color, font } from "../theme";

// The ATLAS session node — card 525c8ad9 (Atlas P2-7), owner decision "B · Inline" (request 36787441).
// Design source: the vault's `Mockups/2026-10-21 Atlas session node/` (B-inline.html + README).
// What is deliberate here, and what must not be undone: docs/decisions/525c8ad9-atlas-session-node.md.
//
// It is a thin BINDING over the shared <TerminalCard> base, exactly as TerminalTile is the classic
// one: the base keeps the terminal, the composer, the queue ledger and the wakes strip, and this file
// supplies only the node's own wiring — which tabs a role gets, where each tab's address is, the
// state cluster that rides the frame's `<h1>`, and the lifecycle mutations.

/**
 * What this node needs off a session row. Narrowed the same way (and for the same reason) as
 * `TerminalCardSession`: `/review/:workerId` must be able to draw its node before `["allSessions"]` has
 * resolved — and after a merge archives the row out of it — so everything except the id is optional,
 * and the node degrades honestly rather than inventing values for what it does not know.
 */
export type SessionNodeRow = Pick<SessionListItem, "id"> &
  Partial<Pick<SessionListItem,
    "role" | "busy" | "harness" | "projectId" | "projectName" | "agentName" | "taskId" | "model" | "ctxInputTokens" | "ctxTurns" | "gen" | "processState">>;

/**
 * Live-or-starting: the states in which this session still has a pty to reach. Everything the node
 * offers that WRITES to a session — Stop, Fork, the turn composer — is gated on it, in one place, so
 * a caller cannot forget: `/review/:workerId` deliberately renders the node for an ENDED worker (the
 * review outcome has to outlive the merge), and before this gate existed that surface handed the
 * reader controls that could only fail.
 */
function isLiveish(s: SessionNodeRow): boolean {
  return s.processState === "live" || s.processState === "starting";
}

/** The context readout, shared by both state renderings — it is as true of an ended session as a live one. */
function ctxReadout(s: SessionNodeRow) {
  const ctx = s.ctxInputTokens ?? 0;
  if (ctx <= 0) return null;
  const window = contextWindowForModel(s.model);
  const pct = window > 0 ? Math.round((ctx / window) * 100) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Meter value={ctx} max={window} tone={ctx > window * CONTEXT_WARN_RATIO ? "amber" : "phosphor"} width={60} />
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
        {(ctx / 1000).toFixed(1)}k ctx · {pct}%
      </span>
    </span>
  );
}

/**
 * The GENERATION pill the round-4 mockup puts on a session node head (`gen 412 · 318 turns`) — card
 * 5968d7e0, the one reading of its three that this head did not already carry.
 *
 * It is the pair `ctxReadout` beside it deliberately does NOT repeat: that one owns the `%`, so the
 * mockup's `gen · turns · ctx%` arrives as two clusters rather than one of them stating the occupancy
 * twice. `gen` alone (no turns yet) and turns alone (gen 0 on a first generation) are both real, so
 * each half is conditional and the pill is omitted only when neither has anything to say.
 */
function genReadout(s: SessionNodeRow) {
  const parts = [s.gen ? `gen ${s.gen}` : null, s.ctxTurns ? plural(s.ctxTurns, "turn") : null].filter(Boolean);
  if (parts.length === 0) return null;
  // The SHARED pill, not a hand-rolled `.loom-atlas-headpill` span: this reading grows with the
  // session (`gen 1412 · 1318 turns`) and the node head it rides is the narrowest of the three, so
  // it needs the same ellipsis the project node's branch pill does rather than its own copy of it.
  return <HeadPill testId="session-node-gen">{parts.join(" · ")}</HeadPill>;
}

/**
 * The live state the frame's node head carries beside the `<h1>` — busy, harness, generation, context.
 *
 * Deliberately NOT the short id, although the mockup places one here: the heading already reads
 * `agent · role · <short id>`, so repeating it would restore a duplicate one row below the one this
 * card exists to remove.
 */
function SessionNodeState({ s }: { s: SessionNodeRow }) {
  // `processState` is the field a REAL row always carries and a not-yet-resolved one never does, so it
  // is the honest test for "is there anything to report". Rendering the cluster anyway would show an
  // `idle` pill for a session whose state is simply unknown — a claim, not a blank.
  if (!s.processState) return <span data-testid="session-node-state" />;

  // An ENDED session reports the state it ended in, not busy/idle — which describe a session that is
  // still running and would otherwise stick forever on a worker that merged half an hour ago. Same
  // pill and same label SessionView's own ended-session panel uses, so the two read identically.
  if (!isLiveish(s)) {
    return (
      <span data-testid="session-node-state" style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <StatusPill tone="muted" label={s.processState} />
        {genReadout(s)}
        {ctxReadout(s)}
      </span>
    );
  }
  return (
    <span data-testid="session-node-state"
      style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
      <StatusPill tone={s.busy ? "amber" : "phosphor"} glow={s.busy} label={s.busy ? "busy" : "idle"} />
      <HarnessTag harness={harnessOf(s.harness)} />
      {genReadout(s)}
      {ctxReadout(s)}
    </span>
  );
}

// A manager's own orchestration_events timeline — the Timeline tab's panel. It MOVED here from
// pages/Overview.tsx (where the classic SessionCockpit still mounts it) so both surfaces read one
// definition: a component importing it from a page would have made a page↔component cycle. Polls so it
// stays live while the manager drills its workers; mounted only while the Timeline tab is active, so it
// never fans out a query per manager.
export function ManagerTimeline({ managerId }: { managerId: string }) {
  const events = useQuery({ queryKey: ["orchEvents", managerId], queryFn: () => api.orchestrationEvents(managerId), refetchInterval: 2000, placeholderData: keepPreviousData });
  const list = events.data ?? [];
  return (
    <Panel grid style={{ maxHeight: 440, overflow: "auto" }}>
      {list.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No events yet.</span>}
      {list.map((e) => <EventRow key={e.id} e={e} />)}
    </Panel>
  );
}

/** The Diff tab's file count, read from the SHARED diff cache entry so it costs no extra request. */
function useDiffCount(sessionId: string, enabled: boolean): number | undefined {
  const diff = useQuery({ ...workerDiffQuery(sessionId), enabled });
  return diff.data?.filesChanged;
}

export function SessionNode({ session, tab = "terminal" }: {
  session: SessionNodeRow;
  /** The tab this ADDRESS lands on — `?tab=` on /session/:id, or "diff" for /review/:workerId. */
  tab?: SessionNodeTab;
}) {
  const headerSlot = useAtlasNodeHeadSlot();
  const stop = useStopSession();
  const fork = useForkSession();
  const end = useEndSession();

  // ONE declaration of the role→tab-set rule, shared with the frame's crumb trail
  // (lib/sessionNodeTabs.ts). Asking the list which tabs this role gets — rather than re-spelling the
  // `manager`/`worker` checks here — is what stops the tab ROW and the crumb from ever disagreeing
  // about which tabs a node has.
  const nodeTabs = sessionNodeTabsFor(session.role);
  const hasDiff = nodeTabs.includes("diff");
  const diffCount = useDiffCount(session.id, hasDiff);

  // `tabs` is always an object — even an empty one — so a plain session still gets the two-tab row
  // rather than TerminalCard's no-tabs body.
  const tabs: TerminalTabs = {
    ...(nodeTabs.includes("timeline") ? { timeline: <ManagerTimeline managerId={session.id} /> } : null),
    // Keyed on the id for the same reason /review/:workerId keys it: result / note / openFiles must
    // never carry across a session switch (card 496fe90e).
    ...(hasDiff ? { diff: <ReviewSurface key={session.id} workerId={session.id} embedded /> } : null),
  };

  // EVERY write surface is gated on the session still being reachable, here rather than at the call
  // site: `/review/:workerId` renders this node for a worker that the merge it is reporting has just
  // ENDED, so Stop, Fork and the composer would each be a control whose only possible outcome is a
  // failed call against a dead session. `readOnly` is the composer's gate because withholding it is
  // TerminalCard's own job (it is a separate inbound surface from the pty), and it carries the
  // terminal pane with it for free. The REVIEW SURFACE itself stays fully usable — approving, the
  // result banner and the request-changes note are all still meaningful once the worker is gone.
  const liveish = isLiveish(session);

  // END SESSION (card 102bc915) — the one action that had no Atlas home before this card. Its only
  // mount was the classic Overview's fleet accordion, so retiring /overview took it out of the product
  // entirely; Fork, Stop, Resume and Clear-rate-limit each already had a tab. It rides the base's
  // EXISTING `actionsExtra` slot (Terminals.tsx's kill cluster is its other user), so TerminalCard is
  // untouched, and it renders the SHARED button under the SHARED predicate — never a second copy of
  // "live and not a worker" (canEndSession carries that anchor). `undefined` rather than a hidden
  // button, so a worker's node and an ended session's node render byte-identically to before.
  //
  // `canEndSession`, not `liveish`: the two differ on purpose. `liveish` admits `starting`, which is
  // right for Stop and the composer and wrong here — a session still booting has no turn to wrap up.
  const endAction = canEndSession(session)
    ? <EndSessionButton s={session} onEnd={() => end.mutate(session.id)} ending={end.isPending}
        style={{ padding: "0 8px" }} />
    : undefined;

  return (
    <TerminalCard
      session={session}
      height="auto"
      offerFork={liveish}
      onFork={() => fork.mutate(session.id)}
      forkPending={fork.isPending}
      lifecycle={liveish ? "stop" : "none"}
      onStop={() => stop.mutate(session.id)}
      stopPending={stop.isPending}
      actionsExtra={endAction}
      readOnly={!liveish}
      maximizable
      showProject={false}
      title={<SessionNodeState s={session} />}
      subPanels={{ queue: true, wakes: true, taskCard: true }}
      tabs={tabs}
      atlasNode={{
        headerSlot,
        tab,
        hrefFor: (t) => sessionNodeTabHref(session.id, t),
        tabCount: { diff: diffCount },
      }}
    />
  );
}
