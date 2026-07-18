import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, SessionListItem, SessionRole, Schedule } from "@loom/shared";
import { api } from "../lib/api";
import Board from "./Board";
import { PlatformSessionTile } from "../components/PlatformSessionTile";
import { AgentPromptEditor } from "../components/AgentPromptEditor";
import { RunHistory } from "../components/RunHistory";
import { CollapsibleHistory } from "../components/CollapsibleHistory";
import { Panel, Button, Input, SectionLabel, StatusPill, Badge } from "../components/ui";
import { SetupWizard } from "../components/SetupWizard";
import { LogoMark } from "../components/Logo";
import { looksLikeCron } from "./Schedules";
import { color, font } from "../theme";
import { roleDisplay } from "../lib/roleDisplay";
import {
  type PlatformEdition, type PlatformSpawnRole, type AgentCardCopy, type HistoryCopy,
  operatorSpawnDisabled, auditorSpawnDisabled,
} from "./platformEdition";

// The UNIFIED Platform surface — ONE shell driven by an `edition` config (platformEdition.ts). It replaces
// the near-duplicate DeveloperPlatformView + EndUserPlatformView (card 8adccd37, the "unify up" tail): the
// DEV surface is the canonical rendering, and the four genuine behavioral forks stay REAL as explicit,
// config-selected leaves — NOT homogenized (Bucket-2b isn't shipping):
//   1. Multi-Lead vs singleton operator      → operatorSpawnDisabled(edition, …)  (edition.operatorSingleton)
//   2. Auditor schedule data model            → auditorScheduleVariant "list" (dev) | "single-form" (enduser)
//   3. Endpoints/roles                        → homeQueryKey + operatorRole/auditorRole (static per edition)
//   4. Layout                                 → sessionLayout "grid" | "split"; historyCollapsed
//
// It shows + controls, for whichever edition mounts:
//   1. the operator + auditor agents, with human spawn/stop controls + live status,
//   2. the live sessions (grid of all, or two single-session wrappers),
//   3. the auditor's cadence (a multi-row list, or a single edit-cron form),
//   4. run history for each role (collapsed disclosures, or expanded sections),
//   5. the reserved-home board (findings + escalations / setup checklist + suggestions).
// Everything reuses EXISTING REST: discovery is read-only (api.platformHome / api.setupHome); spawn =
// startSession(edition role), stop = stopSession, cadence = createSchedule. No new write/elevated surface.
//
// HARD INVARIANT: the spawn role comes from the STATIC `edition` prop, never from the edition-preview
// toggle in Platform.tsx — so that toggle stays a PURE CLIENT-SIDE VIEW SWITCH. This shell receives only
// the edition config; it never reads the toggle's persisted key or browser storage. So a dev previewing
// the End-user surface mounts the endUserEdition config + its setup-scoped calls and can never drive a
// platform spawn through the wrong endpoint (asserted by test/platform-edition.mjs).
export function PlatformView({ edition }: { edition: PlatformEdition }) {
  // Map the edition's home key → the real (api-free config stays clean) read-only discovery fn. Same query
  // key as useVisibleNavPages / Platform.tsx → one shared, cached fetch.
  const load = edition.homeQueryKey === "platformHome" ? api.platformHome : api.setupHome;
  const home = useQuery({ queryKey: [edition.homeQueryKey], queryFn: load });
  // Profiles resolve each agent's role (operator/auditor) — the human spawn role + chip.
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  // Entry A — the guided-onboarding wizard, launched from the band below. Human-only; stands up a new
  // project + a templated team over the existing setup REST (nothing here spawns an agent).
  const [wizardOpen, setWizardOpen] = useState(false);

  if (home.isLoading) return <p style={{ color: color.textMuted }}>Loading the Platform home…</p>;
  if (home.isError || !home.data) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>{edition.copy.errorText}</p>;
  }
  const { project, agents } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // Classify by the bound profile's role, falling back to the seeded name if a profile is missing. The
  // reserved home holds TWO agents (operator + auditor), so resolve by role/name — never an index (agents[0]
  // may be the auditor), leaving the record undefined rather than mis-picking the other agent.
  const operator = agents.find((a) => roleOf(a) === edition.operatorRole) ?? agents.find((a) => a.name === edition.operatorName);
  const auditor = agents.find((a) => roleOf(a) === edition.auditorRole) ?? agents.find((a) => a.name === edition.auditorName);

  // Sessions belonging to the reserved home, newest first.
  const homeSessions = (sessions.data ?? [])
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const liveFor = (agentId?: string) =>
    agentId ? homeSessions.find((s) => s.agentId === agentId && s.processState === "live") : undefined;
  const liveCountFor = (agentId?: string) =>
    agentId ? homeSessions.filter((s) => s.agentId === agentId && s.processState === "live").length : 0;
  const operatorLive = liveFor(operator?.id);
  const auditorLive = liveFor(auditor?.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Platform
          <Badge tone="cyan">{project.name}</Badge>
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            {edition.copy.header.mutedSpan}
          </span>
        </SectionLabel>
        <p style={{ color: color.textMuted, fontSize: 11, margin: "4px 0 0", fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
          {edition.copy.header.paragraph}
        </p>
      </div>

      {/* --- Guided setup launcher (onboarding Entry A): stand up a NEW project + a templated team in a few
             guided steps. A peer to handing the operator agent the reins above — this is the do-it-yourself
             fast path. Opens the SetupWizard overlay; it spawns no agent. --- */}
      <Panel style={{
        display: "flex", alignItems: "center", gap: 16, padding: "16px 18px",
        background: `radial-gradient(560px 180px at 12% -40%, ${color.phosphorDim}, transparent 70%), ${color.panel}`,
      }}>
        <span style={{ color: color.phosphor, display: "inline-flex", flexShrink: 0 }}><LogoMark size={26} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: font.head, fontSize: 14, color: color.text }}>New project from a template</div>
          <div style={{ fontFamily: font.mono, fontSize: 11.5, color: color.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Pick a workflow template, point Loom at a repo, and get a ready-to-run team plus a starter board card — in four quick steps.
          </div>
        </div>
        <Button variant="primary" onClick={() => setWizardOpen(true)} style={{ padding: "6px 14px", fontSize: 13, flexShrink: 0 }}>
          Start guided setup →
        </Button>
      </Panel>
      <SetupWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {/* --- 1. Agent go-live controls (operator + auditor) --- */}
      <section>
        <SectionLabel>{edition.copy.agentsLabel}</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
          <AgentControl edition={edition} agent={operator} role={edition.operatorRole} card={edition.copy.operatorCard}
            session={operatorLive} liveCount={liveCountFor(operator?.id)} showLiveCount={!edition.operatorSingleton}
            gate={operatorSpawnDisabled} />
          <AgentControl edition={edition} agent={auditor} role={edition.auditorRole} card={edition.copy.auditorCard}
            session={auditorLive} liveCount={liveCountFor(auditor?.id)} showLiveCount={false}
            gate={auditorSpawnDisabled}
            footer={edition.auditorScheduleVariant === "single-form" && auditor ? <AuditorScheduleInline agent={auditor} /> : undefined} />
        </div>
      </section>

      {/* --- 2. Live sessions — the dev GRID of all live, or the end-user's two SINGLE-session wrappers --- */}
      {edition.sessionLayout === "grid" ? (
        <section>
          <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {edition.copy.sessionsLabel}
            <span style={{ color: color.textMuted, fontWeight: 400 }}>({homeSessions.filter((s) => s.processState === "live").length} live)</span>
          </SectionLabel>
          <PlatformSessions sessions={homeSessions} emptyLabel={edition.copy.sessionsEmpty} />
        </section>
      ) : (
        <>
          <section>
            <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {edition.copy.operatorSessionLabel}
              {operatorLive && <StatusPill tone={operatorLive.busy ? "amber" : "phosphor"} glow={operatorLive.busy} label={operatorLive.busy ? "busy" : "idle"} />}
            </SectionLabel>
            <SingleSession session={operatorLive} empty={edition.copy.operatorSessionEmpty} />
          </section>
          <section>
            <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {edition.copy.auditorSessionLabel}
              {auditorLive && <StatusPill tone={auditorLive.busy ? "amber" : "phosphor"} glow={auditorLive.busy} label={auditorLive.busy ? "busy" : "idle"} />}
            </SectionLabel>
            <SingleSession session={auditorLive} empty={edition.copy.auditorSessionEmpty} stopTitle={edition.copy.auditorCard.stopTitle} />
          </section>
        </>
      )}

      {/* --- 3. Auditor cadence — the DEV multi-row LIST variant (a separate section). The end-user
              single-form variant lives INSIDE the auditor card (footer, above). --- */}
      {edition.auditorScheduleVariant === "list" && (
        <section>
          <SectionLabel>{edition.copy.auditorScheduleLabel}</SectionLabel>
          <AuditorScheduleList auditorId={auditor?.id} />
        </section>
      )}

      {/* --- 4. Run history for each role — dev collapses (CollapsibleHistory), end-user expands. --- */}
      <HistorySection collapsed={edition.historyCollapsed} copy={edition.copy.operatorHistory}>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role={edition.operatorRole}
          emptyLabel={edition.copy.operatorHistory.empty} />
      </HistorySection>
      <HistorySection collapsed={edition.historyCollapsed} copy={edition.copy.auditorHistory}>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role={edition.auditorRole}
          emptyLabel={edition.copy.auditorHistory.empty} showFindings={edition.auditorHistoryShowFindings} />
      </HistorySection>

      {/* --- 5. The reserved-home board (reused Board component) --- */}
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {edition.copy.board.label}
          <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
            {edition.copy.board.hint}
          </span>
        </SectionLabel>
        <Board projectId={project.id} />
      </section>
    </div>
  );
}

// One agent's go-live card — SHARED across editions. Live status + a spawn button and a stop button
// (graceful, when live). The spawn ROLE is the edition's static `role` (operator or auditor) — NEVER
// derived from the ViewAs toggle. The spawn-disabled decision is the edition's pure `gate` fn
// (operatorSpawnDisabled / auditorSpawnDisabled) so the singleton-vs-multi + create-only gating stays
// exactly as each edition intends. Badge TONE reads from the ONE role display map (roleDisplay(role).tone)
// so it agrees with the picker + every badge; the badge LABEL + button copy come from the edition's copy
// pack. `footer` carries the end-user auditor's inline schedule form (dev has none — it uses the list
// section). Spawn/stop are HUMAN-only REST (startSession / stopSession) — no agent MCP path mints these.
function AgentControl({ edition, agent, role, card, session, liveCount, showLiveCount, gate, footer }: {
  edition: PlatformEdition; agent?: Agent; role: PlatformSpawnRole; card: AgentCardCopy;
  session?: SessionListItem; liveCount: number; showLiveCount: boolean;
  gate: (edition: PlatformEdition, s: { live: boolean; pending: boolean }) => boolean;
  footer?: ReactNode;
}) {
  const qc = useQueryClient();
  const spawn = useMutation({
    // inlineError (end-user): surface a spawn failure on the card, not the global blocking alert (which
    // wedges automation / first-run). Dev keeps the global alert (meta omitted).
    meta: card.inlineError ? { inlineError: true } : undefined,
    mutationFn: () => api.startSession(agent!.id, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const tone = roleDisplay(role).tone;

  if (!agent) {
    return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>{card.missingLabel}</span></Panel>;
  }
  const live = session?.processState === "live";
  const spawnDisabled = gate(edition, { live, pending: spawn.isPending });
  const spawnLabel = spawn.isPending ? card.spawn.pending : live ? card.spawn.live : card.spawn.idle;
  const spawnTitle = live ? card.title.live : card.title.idle;
  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={tone}>{card.badgeLabel}</Badge>
        <strong style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{agent.name}</strong>
        <span style={{ flex: 1 }} />
        {showLiveCount && liveCount > 0 && (
          <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 11 }}>{liveCount} live</span>
        )}
        {live
          ? <StatusPill tone={session!.busy ? "amber" : "phosphor"} glow={session!.busy} label={session!.busy ? "busy" : "idle"} />
          : <StatusPill tone="muted" label="offline" />}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" disabled={spawnDisabled} title={spawnTitle} onClick={() => spawn.mutate()}>
          {spawnLabel}
        </Button>
        {live && (
          <Button variant="danger" disabled={stop.isPending} title={card.stopTitle}
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(spawn.error as Error).message}</span>}
      {/* View / edit this reserved-home agent's startup prompt (the spawn kickoff). */}
      <AgentPromptEditor key={`prompt-${agent.id}`} agent={agent} homeKey={[edition.homeQueryKey]} />
      {footer}
    </Panel>
  );
}

// The DEV live-session GRID (Lead/Auditor terminals), tiled with a graceful-stop + maximize control.
// Dead/exited rows are dropped (the live set only) — mirrors the Terminals grid, scoped to the reserved
// project. Each tile is the shared PlatformSessionTile (status + PresetPrompts + Stop + maximize, NO Fork —
// forking would mint a second ELEVATED session off-screen; spawn fresh from the Agents controls instead).
function PlatformSessions({ sessions, emptyLabel }: { sessions: SessionListItem[]; emptyLabel: string }) {
  const live = sessions.filter((s) => s.processState === "live");
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>{emptyLabel}</p>;
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12, alignItems: "start" };
  return (
    <div style={grid}>
      {live.map((s) => <PlatformSessionTile key={s.id} session={s} height={440} />)}
    </div>
  );
}

// The END-USER single live-session wrapper (operator OR auditor). Uses the shared PlatformSessionTile — NO
// Fork (forking would mint a second setup/auditor session). Empty state prompts the go-live control above.
function SingleSession({ session, empty, stopTitle }: { session?: SessionListItem; empty: string; stopTitle?: string }) {
  if (!session) return <p style={{ color: color.textMuted, marginTop: 0 }}>{empty}</p>;
  return <PlatformSessionTile session={session} height={480} maxWidth={920} stopTitle={stopTitle} />;
}

// One role's run history — collapsed behind a disclosure (dev) or an always-expanded section (end-user).
// The body (RunHistory) is passed in; this only chooses the collapsed-vs-expanded chrome from config.
function HistorySection({ collapsed, copy, children }: { collapsed: boolean; copy: HistoryCopy; children: ReactNode }) {
  if (collapsed) return <CollapsibleHistory title={copy.title} hint={copy.hint}>{children}</CollapsibleHistory>;
  return (
    <section>
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {copy.title}
        <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
          {copy.hint}
        </span>
      </SectionLabel>
      {children}
    </section>
  );
}

function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

// ── Auditor schedule — VARIANT LEAF A (dev, kind:"auditor"): a multi-row LIST. List its schedules
// (enable/disable + delete) and add a new one. A fired auditor schedule boots the Platform Auditor
// (startAuditor, role locked server-side). Reuses the existing schedule REST — createSchedule passes
// kind:"auditor" so the Scheduler routes it right. ──
function AuditorScheduleList({ auditorId }: { auditorId?: string }) {
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const [cron, setCron] = useState("0 9 * * *");

  const create = useMutation({
    mutationFn: () => api.createSchedule({ agentId: auditorId!, cron: cron.trim(), enabled: true, kind: "auditor", name: "Platform Auditor" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.updateSchedule(v.id, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
  });

  if (!auditorId) return <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>No Auditor agent — cannot schedule.</span></Panel>;
  // Surface schedules targeting the Auditor agent (any kind), so an existing cadence is always visible.
  const mine = (schedules.data ?? []).filter((s) => s.agentId === auditorId);
  const cronValid = looksLikeCron(cron);

  return (
    <Panel style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Put the Auditor on a cadence — each fire boots the read-and-file-only Auditor to scan recent transcripts
        and file findings to the board. Reading many transcripts costs tokens, so favour a sparse cadence.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {mine.map((s) => <AuditorScheduleRow key={s.id} s={s} onToggle={(enabled) => toggle.mutate({ id: s.id, enabled })}
          onRemove={() => remove.mutate(s.id)} busy={toggle.isPending || remove.isPending} />)}
        {mine.length === 0 && <span style={{ color: color.textMuted, fontSize: 12 }}>No auditor schedule yet.</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 160 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Adding…" : "Add cadence"}
        </Button>
        {create.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{(create.error as Error).message.includes("400") ? "Daemon rejected the cron expression." : (create.error as Error).message}</span>}
      </div>
    </Panel>
  );
}

function AuditorScheduleRow({ s, onToggle, onRemove, busy }:
  { s: Schedule; onToggle: (enabled: boolean) => void; onRemove: () => void; busy: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim,
      border: `1px solid ${color.border}`, borderRadius: 4, padding: "6px 8px" }}>
      <span style={{ color: color.cyan }}>{s.cron}</span>
      <span style={{ fontSize: 10, color: s.kind === "auditor" ? color.phosphor : color.amber }}>kind:{s.kind}</span>
      <span style={{ flex: 1 }}>next · {fmt(s.nextFireAt)}</span>
      <span style={{ fontSize: 9, color: s.enabled ? color.phosphor : color.textMuted }}>{s.enabled ? "ON" : "OFF"}</span>
      <Button style={{ padding: "0 8px" }} disabled={busy} onClick={() => onToggle(!s.enabled)}>{s.enabled ? "Disable" : "Enable"}</Button>
      <Button variant="danger" style={{ padding: "0 8px" }} disabled={busy} onClick={onRemove}>Delete</Button>
    </div>
  );
}

// ── Auditor schedule — VARIANT LEAF B (end-user, kind:"workspace-auditor"): a SINGLE edit-cron form,
// co-located INSIDE the auditor card (the reserved home is hidden from the Schedules-page picker, so the
// Auditor can't be targeted there). Looks up THIS agent's existing kind:"workspace-auditor" schedule and
// lets the user create / edit-cron / enable-disable / remove a SINGLE cadence. A fired schedule boots a
// fresh suggest-only Auditor run via startWorkspaceAuditor (role locked server-side) — human-only REST. ──
function AuditorScheduleInline({ agent }: { agent: Agent }) {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const existing = (schedules.data ?? []).find((s) => s.agentId === agent.id && s.kind === "workspace-auditor");
  return <AuditorScheduleInlineForm key={existing?.id ?? "new"} agentId={agent.id} existing={existing} />;
}

function AuditorScheduleInlineForm({ agentId, existing }: { agentId: string; existing?: Schedule }) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(existing?.cron ?? "0 9 * * *");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const create = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.createSchedule({ agentId, cron: cron.trim(), enabled: true, kind: "workspace-auditor", name: "Workspace Auditor" }), onSuccess: invalidate });
  const save = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.updateSchedule(existing!.id, { cron: cron.trim() }), onSuccess: invalidate });
  const toggle = useMutation({ mutationFn: () => api.updateSchedule(existing!.id, { enabled: !existing!.enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteSchedule(existing!.id), onSuccess: invalidate });

  const cronValid = looksLikeCron(cron);
  const dirty = !!existing && cron.trim() !== existing.cron;
  const err = (create.error ?? save.error) as Error | null;

  return (
    <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, fontWeight: 700, color: color.textDim }}>Run automatically</span>
        {existing && <Badge tone={existing.enabled ? "phosphor" : "muted"}>{existing.enabled ? "on" : "paused"}</Badge>}
      </div>
      <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
        Review your workspace on a schedule, not just on demand — each fire spawns a fresh read-only run.
        Reading transcripts costs tokens, so favour a sparse cadence. Schedules run only while the
        scheduler is enabled (Settings › Scheduler).
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 150 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        {existing ? (
          <>
            <Button variant="primary" disabled={!cronValid || !dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
            <Button disabled={toggle.isPending} onClick={() => toggle.mutate()} title={existing.enabled ? "Pause this cadence (stops firing)" : "Resume this cadence"}>{existing.enabled ? "Disable" : "Enable"}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
          </>
        ) : (
          <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>{create.isPending ? "Scheduling…" : "Schedule"}</Button>
        )}
      </div>
      {!cronValid && cron.trim().length > 0 && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
      {existing && <span style={{ color: color.textDim, fontFamily: font.mono, fontSize: 11 }}>next · {fmt(existing.nextFireAt)}</span>}
      {err && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{err.message.includes("400") ? "Daemon rejected the cron expression." : err.message}</span>}
    </div>
  );
}
