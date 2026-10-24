import { useState, type CSSProperties, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Project, SessionListItem, SessionRole, Schedule } from "@loom/shared";
import { api } from "../lib/api";
import Board from "./Board";
import { PlatformSessionTile } from "../components/PlatformSessionTile";
import { AgentPromptEditor } from "../components/AgentPromptEditor";
import { RunHistory } from "../components/RunHistory";
import { CollapsibleHistory } from "../components/CollapsibleHistory";
import { Panel, Button, Input, SectionLabel, StatusPill, Badge } from "../components/ui";
import { AtlasNodeHead, NodeTabs, type NodeHeadPill } from "../components/atlasHome";
import { SetupWizard } from "../components/SetupWizard";
import { LogoMark } from "../components/Logo";
import { looksLikeCron } from "./Schedules";
import { useAtlasUi } from "../lib/atlasUi";
import { PlatformFindings } from "./PlatformFindings";
import { color, font } from "../theme";
import { errorText } from "../lib/loopbackCredential";
import { roleDisplay } from "../lib/roleDisplay";
import {
  type PlatformEdition, type PlatformSpawnRole, type AgentCardCopy, type HistoryCopy,
  operatorSpawnDisabled, auditorSpawnDisabled, resolveOperatorSpawnRole,
} from "./platformEdition";

// The UNIFIED Platform surface — ONE shell driven by an `edition` config (platformEdition.ts). The DEV
// surface is the canonical rendering, and the four genuine behavioral forks stay REAL as explicit,
// config-selected leaves:
//   1. Multi-Lead vs singleton operator      → operatorSpawnDisabled(edition, …)  (edition.operatorSingleton)
//   2. Auditor schedule data model            → auditorScheduleVariant "list" (dev) | "single-form" (enduser)
//   3. Endpoints/roles                        → homeQueryKey + operatorRole/auditorRole (static per edition)
//   4. Layout                                 → sessionLayout "grid" | "split"; historyCollapsed
//
// @decision 8adccd37 — this shell replaces the near-duplicate DeveloperPlatformView + EndUserPlatformView;
// the four forks above stay REAL and config-selected, never homogenized, because Bucket-2b (the operator's
// elevated surface) isn't shipping to end users.
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
// TWO LAYOUTS, ONE SHELL (card c07ff42a, Atlas build plan P2-4). The five sections above are rendered by
// whichever layout the Atlas-UI switch selects: `ClassicPlatformLayout` stacks all five down one column
// (today's page, unchanged), `AtlasPlatformLayout` places them on the approved round-4 node tabs
// (Home / Cadence / History / Board / Findings). The split is DELIBERATELY the last step: the edition
// resolution, the agent/session/role derivation and every leaf component above it are shared, so a layout
// receives values that are ALREADY resolved and cannot re-derive what an edition may show. Adding a
// third layout, or changing what one shows, must not mean re-deriving any of that.
//
// ⛔ Do not let a layout read the Atlas switch, the edition-preview toggle, or the home query itself. The
// switch is read HERE, once, for the sole purpose of choosing a layout; everything either layout needs
// arrives as a prop.
//
// @decision b472645a — in the dev End-user PREVIEW (`previewOnly`) every control THIS file owns must send
// NO request: both spawns, both Stops, both prompt editors, the whole cadence form, and the session tiles.
// Do not re-narrow that to the operator spawn, and do not gate it by reading the toggle anywhere below.
//
// HARD INVARIANT: the spawn role never comes from the edition-preview toggle in Platform.tsx — so that
// toggle stays a PURE CLIENT-SIDE VIEW SWITCH. This shell receives only the edition config; it never
// reads the toggle's persisted key or browser storage. So a dev previewing the End-user surface mounts
// the endUserEdition config + its setup-scoped calls and can never drive a platform spawn through the
// wrong endpoint (asserted by test/platform-edition.mjs). The OPERATOR's spawn role is a separate,
// legitimate exception to "static edition role" (f437d4e9 C5 round 2, item 1b): it tracks the operator
// agent's CURRENT bound profile (`operatorSpawnRole` below), since the end-user operator's real role can
// differ from the edition's default (a customized, not-yet-upgraded agent is still "setup"). That
// resolution reads profile data, never the toggle — the invariant above is untouched.
// The ONE wording for every preview-held control, so the tooltip and the caption can't drift apart.
// "acting", not "spawning": the gate covers the spawns, the Stops, the prompt editors, the cadence form
// and the session tiles — naming only the spawn would under-describe what is actually held.
const PREVIEW_DISABLED_TITLE = "Preview only on a dev install — acting here is disabled";
const PREVIEW_DISABLED_NOTE = "Preview only on a dev install — acting here is disabled.";

export function PlatformView({ edition, previewOnly = false }: { edition: PlatformEdition; previewOnly?: boolean }) {
  // Which LAYOUT renders the resolved sections — nothing else. Read before any early return so the hook
  // order is identical in both, and read here rather than in a layout so the two layouts stay pure
  // presentation (see the TWO LAYOUTS note above). This is the Atlas display switch (lib/atlasUi.ts), a
  // different thing entirely from the edition-preview toggle in Platform.tsx: it cannot influence which
  // EDITION mounts, and the edition — which does decide roles and endpoints — never reaches it.
  const [atlasOn] = useAtlasUi();
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
  // `!home.data.project` (card 8d82be67: platformHome's `project` is now `Project | null`, never 404)
  // covers the SAME "no home to render" case the old `home.isError` check used to catch for a dev-edition
  // mount that somehow lost its reserved home — setupHome's `project` is never null, so this never fires
  // on the end-user path.
  if (home.isError || !home.data || !home.data.project) {
    return <p style={{ color: color.red, fontFamily: font.mono }}>{edition.copy.errorText}</p>;
  }
  const { project, agents, resolvedLead } = home.data;

  const roleOf = (a: Agent): SessionRole | null => profiles.data?.find((p) => p.id === a.profileId)?.role ?? null;
  // Card b2b69ec8 (M3): when the server resolved an authoritative Lead (`resolvedLead.agentId` — the
  // SAME `resolveHomeLeadAgent` helper `startPlatformLead`/`resume()`/`migrateSetupHomeToLead` resolve
  // through), consume it DIRECTLY by id rather than re-deriving "the Lead" by list order/name — those two
  // can disagree the moment a second human-bound platform agent exists in the home (a stray agent sorted
  // first would be picked here, then refused server-side on spawn). `resolvedLead` is only ever present
  // on the setupHome response (undefined on platformHome — the dev multi-Lead edition has no single
  // "the Lead" to resolve this way), so the dev edition is untouched and keeps the role/name fallback.
  const operator = resolvedLead?.agentId
    ? agents.find((a) => a.id === resolvedLead.agentId)
    : agents.find((a) => roleOf(a) === edition.operatorRole) ?? agents.find((a) => a.name === edition.operatorName);
  const auditor = agents.find((a) => roleOf(a) === edition.auditorRole) ?? agents.find((a) => a.name === edition.auditorName);
  // f437d4e9 C5 round 2, item 1(b) / round 3 M2+M4(d): the operator's SPAWN role tracks its CURRENT
  // bound profile role, never the edition's static default — mirrors first-run.ts's own resolution
  // (profile role "platform" ⇒ "platform", else "setup"). A customized, not-yet-upgraded end-user agent
  // is still role "setup" even though endUserEdition.operatorRole says "platform"; spawning it as
  // "platform" would be refused server-side (it isn't the sanctioned Lead) and should never have been
  // attempted in the first place. `resolvedLead.role` (card b2b69ec8) already carries this server-
  // computed, independent of the `profiles` query — when present, there's no "unknown while profiles
  // load" window to hold the spawn button for at all. Only when `resolvedLead` carries no role (the dev
  // edition, or no operator resolved) does this fall back to the profiles-query-dependent resolution,
  // which DOES have that window: `operatorRoleUnknown` disables the spawn button for it (AgentControl below).
  const { role: operatorSpawnRole, spawnDisabled: operatorRoleUnknown } = resolvedLead?.role
    ? { role: resolvedLead.role, spawnDisabled: false }
    : resolveOperatorSpawnRole({
        hasOperator: !!operator,
        profilesLoaded: profiles.data !== undefined,
        operatorProfileRole: operator ? roleOf(operator) : null,
        fallbackRole: edition.operatorRole,
      });

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

  // Everything either layout renders, resolved once here and spread into whichever one the switch
  // selected — so the two can never disagree about what this edition resolved to.
  const surface: PlatformSurface = {
    edition, previewOnly, project, operator, auditor, operatorSpawnRole, operatorRoleUnknown,
    homeSessions, operatorLive, auditorLive, liveCountFor, wizardOpen, setWizardOpen,
  };
  return atlasOn ? <AtlasPlatformLayout {...surface} /> : <ClassicPlatformLayout {...surface} />;
}

/** Everything a layout renders, resolved by the shell above. A layout derives nothing of its own. */
interface PlatformSurface {
  edition: PlatformEdition;
  previewOnly: boolean;
  project: Project;
  operator?: Agent;
  auditor?: Agent;
  operatorSpawnRole: PlatformSpawnRole;
  operatorRoleUnknown: boolean;
  homeSessions: SessionListItem[];
  operatorLive?: SessionListItem;
  auditorLive?: SessionListItem;
  liveCountFor: (agentId?: string) => number;
  wizardOpen: boolean;
  setWizardOpen: (open: boolean) => void;
}

// ── LAYOUT A — today's page. All five sections stacked down one column, in this order. The sections are
// the shared components below, so this layout and the Atlas one can only differ in PLACEMENT. ──
function ClassicPlatformLayout({
  edition, previewOnly, project, operator, auditor, operatorSpawnRole, operatorRoleUnknown,
  homeSessions, operatorLive, auditorLive, liveCountFor, wizardOpen, setWizardOpen,
}: PlatformSurface) {
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

      <GuidedSetupLauncher onStart={() => setWizardOpen(true)} />
      <SetupWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {/* --- 1. Agent go-live controls (operator + auditor) --- */}
      <PlatformAgentsSection edition={edition} previewOnly={previewOnly} operator={operator} auditor={auditor}
        operatorSpawnRole={operatorSpawnRole} operatorRoleUnknown={operatorRoleUnknown}
        operatorLive={operatorLive} auditorLive={auditorLive} liveCountFor={liveCountFor}
        // CLASSIC PLACEMENT: the end-user single-cadence form rides in the auditor card's footer. The
        // Atlas layout puts it on its own Cadence tab instead (the approved round-4 placement), which is
        // why the footer is a prop rather than something the section decides for itself.
        auditorFooter={edition.auditorScheduleVariant === "single-form" && auditor ? <AuditorScheduleInline agent={auditor} previewOnly={previewOnly} /> : undefined} />

      {/* --- 2. Live sessions — the dev GRID of all live, or the end-user's two SINGLE-session wrappers --- */}
      <PlatformSessionsSection edition={edition} previewOnly={previewOnly} homeSessions={homeSessions}
        operatorLive={operatorLive} auditorLive={auditorLive} />

      {/* --- 3. Auditor cadence — the DEV multi-row LIST variant (a separate section). The end-user
              single-form variant lives INSIDE the auditor card (footer, above). --- */}
      {edition.auditorScheduleVariant === "list" && (
        <AuditorCadenceListSection edition={edition} auditor={auditor} />
      )}

      {/* --- 4. Run history for each role — dev collapses (CollapsibleHistory), end-user expands. --- */}
      <PlatformHistorySections edition={edition} previewOnly={previewOnly} project={project} homeSessions={homeSessions} />

      {/* --- 5. The reserved-home board (reused Board component) --- */}
      <PlatformBoardSection edition={edition} project={project} />
    </div>
  );
}

// ── LAYOUT B — the Atlas Platform node (card c07ff42a). The SAME five sections, placed on the approved
// round-4 tabs instead of stacked. Nothing is rebuilt: each tab renders the shared section components
// above, so a section's behavior is identical to the classic page by construction.
//
// Two placements genuinely move, both per the approved design:
//   • The end-user single-cadence form leaves the auditor card's footer for the Cadence tab, so BOTH
//     cadence variants live in the same place and the tab is never empty in one edition.
//   • Findings become a tab of their own (PlatformFindings) — in the classic page the auditor's findings
//     are reachable only as chips on an individual expanded run row, and its pending preset suggestions
//     only through a live session's composer popover.
//
// The "View as" edition toggle is NOT here: it lives one level up in Platform.tsx, above whichever layout
// mounts, which is exactly the "segmented control at the top of the node" the design calls for — and
// keeping it there is what keeps it unable to reach a spawn/role path (see Platform.tsx's HARD INVARIANT).
type PlatformTab = "home" | "cadence" | "history" | "board" | "findings";

// Tab LABELS stay the same words in both editions, deliberately, even where the section heading inside
// does not ("Board" vs "Your board"): a navigation vocabulary that shifts under you as the view changes
// costs more than it explains. The edition's own wording lives on the heading inside each tab.
const PLATFORM_TABS: { key: PlatformTab; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "cadence", label: "Cadence" },
  { key: "history", label: "History" },
  { key: "board", label: "Board" },
  { key: "findings", label: "Findings" },
];

const PLATFORM_TAB_KEYS = new Set<string>(PLATFORM_TABS.map((t) => t.key));

/** Home is the canonical tab, so its address carries no query — the same shape the project and
 *  workspace nodes give their own Overview tab. Built fresh rather than from the current params, so a
 *  consumed `?task=` deep link is dropped instead of riding onto a tab with no board to open it on. */
const platformTabHref = (key: string) => (key === "home" ? "/platform" : `/platform?tab=${key}`);

function AtlasPlatformLayout({
  edition, previewOnly, project, operator, auditor, operatorSpawnRole, operatorRoleUnknown,
  homeSessions, operatorLive, auditorLive, liveCountFor, wizardOpen, setWizardOpen,
}: PlatformSurface) {
  // `?tab=` keeps a chosen tab linkable and survives a reload, the same mechanism Actors / Repository /
  // Automation already use for their own sub-tabs. Home is the canonical tab, so its URL carries no
  // query; an unknown value falls back to Home rather than rendering nothing.
  const [params] = useSearchParams();
  const raw = params.get("tab") ?? "";
  const tab: PlatformTab = PLATFORM_TAB_KEYS.has(raw) ? (raw as PlatformTab) : "home";

  // A `?task=<id>` card deep link arriving WITHOUT `tab=board` normalizes the address onto the Board
  // tab, which is the only tab that can show the dialog it asks for. The alternative — honour the tab
  // the URL named and leave the param sitting there — looks tidier and is a dead link: nothing on any
  // other tab ever opens it. So the more specific intent wins, and it wins over an EXPLICIT
  // `tab=<other>` too, because a URL carrying both is self-contradictory and only one half of it can
  // be served.
  //
  // @decision 260fb29a — rewrite the ADDRESS, never just derive the tab: Board clears the param it
  // consumes, and a tab derived from a param that is about to vanish re-hides the dialog it opened.
  const taskParam = params.get("task");
  let normalized: string | null = null;
  if (taskParam && tab !== "board") {
    // `tab` first, then every other incoming key, so the interim address reads `?tab=board&task=<id>`
    // rather than depending on where a stale `tab=` happened to sit in the query.
    const next = new URLSearchParams([["tab", "board"]]);
    for (const [key, value] of params) if (key !== "tab") next.append(key, value);
    normalized = `/platform?${next.toString()}`;
  }

  // @decision f76b89b9 — the identity this node states lives in the node head and NOWHERE below it.
  // Re-adding a title/description strip under the tab row is the duplication this card removed.
  //
  // Both readings the old strip carried, as node-level pills: WHICH reserved home resolved (the dev and
  // end-user editions resolve different ones, so the frame's own "Platform" heading cannot stand in for
  // it) and WHAT that home is. Constant across tabs, like every other node's pills (card 5968d7e0) —
  // the scope phrase is identity, not a per-tab reading, so it must not move when a tab does.
  const headPills: NodeHeadPill[] = [
    { key: "home", text: project.name, tone: "cyan", title: "The reserved home this node resolved to" },
    // The PILL phrasing, never the classic page's full caption: MEASURED at 420px the full span is
    // 462px of text in a 388px box, and `.loom-atlas-headpill` is `inline-flex`, so its own
    // `text-overflow: ellipsis` never fires on a bare text child — it was chopped mid-word. The caption
    // rides on the title instead, where the clause the pill drops stays reachable.
    { key: "scope", text: edition.copy.header.scopePill, title: edition.copy.header.mutedSpan },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Rendered BESIDE the panels, never instead of them: returning this on its own would unmount all
          five and take a half-written prompt or cron with them, which is the one thing this node's panel
          rule exists to prevent. <Navigate> renders nothing, so the cost is an element that no reader
          ever sees — and it unmounts itself on the next render, once the address it asked for has landed. */}
      {normalized && <Navigate to={normalized} replace />}
      {/* The frame states this node's identity once — crumbs, the one <h1>, these pills and the tab row —
          so the page starts on its content, exactly as every other re-homed surface does (card a7f23a2f).
          The edition's explainer PARAGRAPH does not come up here (a node head is a row); it renders at
          the top of the HOME tab's body instead — see its own note at that call site. */}
      <AtlasNodeHead pills={headPills} />

      {/* The SAME underlined row the project and workspace nodes wear — one tab affordance for every
          node, not a boxed segmented control here and an underlined row everywhere else. Its tabs are
          real `<Link>`s, so a tab is linkable, survives a reload, and leaves the back button meaning
          what it means on the other nodes (back returns to the tab you came from, where the old
          `replace` left the node entirely). */}
      <NodeTabs tabs={PLATFORM_TABS} active={tab} hrefFor={platformTabHref} />

      {/* ⛔ EVERY PANEL STAYS MOUNTED; the inactive ones are HIDDEN, never unmounted.
          Unmounting a tab destroys the local React state inside it with no warning and no undo — a
          half-written agent startup prompt (AgentPromptEditor's own useState), a typed-but-unsaved cron
          expression, a composer draft on a live session tile. The owner's standing rule is that a user's
          unfinished input is never destroyed, and a tab click is not consent to discard it.
          `hidden` (not a `display:none` style) is what keeps the hidden panels out of BOTH the
          accessibility tree and the tab order, so a keyboard or screen-reader user never reaches a
          control on a panel they are not looking at. ⛔ Don't give these wrappers an inline `display` —
          an author `display` out-specifies the UA's `[hidden]` rule and would silently un-hide them.
          Cost, stated: all five panels' queries poll at once. That is exactly what the CLASSIC layout
          already does (it renders all five sections in one column), so this is the status quo, not a
          new cost — and it is the reason the classic page never had this bug to begin with. */}
      <Panels tab={tab}>
        {{
          home: (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* The edition's explainer, kept inside the frame rather than dropped with the identity
                  strip it used to sit in. It is the ONLY place this surface says what Platform is — the
                  agent cards below carry no prose of their own — so losing it would cost a new end user
                  the one explanation they have, which no amount of tab-affordance tidying is worth.
                  ⛔ HOME ONLY, and exactly once on the node. All five panels stay mounted (see the note
                  at the Panels call site), so a copy on a second tab would be a second live match in the
                  DOM, not an alternative placement. Muted body copy, NOT a heading: the node head above
                  owns the identity, this only explains it. */}
              <p data-testid="platform-explainer"
                style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5, maxWidth: 760 }}>
                {edition.copy.header.paragraph}
              </p>
              <GuidedSetupLauncher onStart={() => setWizardOpen(true)} />
              <SetupWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
              <PlatformAgentsSection edition={edition} previewOnly={previewOnly} operator={operator} auditor={auditor}
                operatorSpawnRole={operatorSpawnRole} operatorRoleUnknown={operatorRoleUnknown}
                operatorLive={operatorLive} auditorLive={auditorLive} liveCountFor={liveCountFor}
                auditorFooter={undefined} />
              <PlatformSessionsSection edition={edition} previewOnly={previewOnly} homeSessions={homeSessions}
                operatorLive={operatorLive} auditorLive={auditorLive} />
            </div>
          ),
          // BOTH cadence variants, in one place. Which one renders is still the edition's own
          // `auditorScheduleVariant` fork — the tab changed where it lives, not what it is.
          cadence: edition.auditorScheduleVariant === "list"
            ? <AuditorCadenceListSection edition={edition} auditor={auditor} />
            : <AuditorCadenceFormSection edition={edition} previewOnly={previewOnly} auditor={auditor} />,
          history: <PlatformHistorySections edition={edition} previewOnly={previewOnly} project={project} homeSessions={homeSessions} />,
          // `deepLinks` only while this panel is the VISIBLE one: it stays mounted on every other tab,
          // and a mounted-but-hidden board that consumed `?task=` would open its dialog where nobody
          // can see it and clear the param on the way (card 260fb29a).
          board: <PlatformBoardSection edition={edition} project={project} deepLinks={tab === "board"} />,
          findings: <PlatformFindings edition={edition} projectId={project.id} />,
        }}
      </Panels>
    </div>
  );
}

// The five node panels, all mounted, all but one `hidden` — see the note at the call site for why
// unmounting is not an option here.
//
// Deliberately NO `role="tabpanel"`: the shared `NodeTabs` row emits no `id` on its tabs, so there is
// nothing for a panel to be `aria-labelledby`/`aria-controls`-associated with, and neither do the other
// nodes that wear that same row. A tabpanel role with no association is a worse answer than none — it
// promises a relationship to AT that isn't there. Wiring it properly means giving `NodeTabs` ids, which
// is a shared-primitive change (every node wears it) and its own card.
function Panels({ tab, children }: { tab: PlatformTab; children: Record<PlatformTab, ReactNode> }) {
  return (
    <>
      {PLATFORM_TABS.map((t) => (
        <div key={t.key} hidden={t.key !== tab} data-testid={`platform-panel-${t.key}`}>
          {children[t.key]}
        </div>
      ))}
    </>
  );
}

// ── The shared sections. Each is rendered by BOTH layouts, so a change here lands on the classic page
// and the Atlas node together and the two cannot drift. None of them reads a query of its own beyond the
// leaf components they already wrap; every value they render arrives as a prop. ──

// Guided setup launcher (onboarding Entry A): stand up a NEW project + a templated team in a few guided
// steps. A peer to handing the operator agent the reins — this is the do-it-yourself fast path. The
// SetupWizard overlay itself is mounted by the layout (it is an overlay, not part of this panel); this is
// only its trigger, and it spawns no agent.
function GuidedSetupLauncher({ onStart }: { onStart: () => void }) {
  return (
    <Panel style={{
      // Wraps rather than squeezes: below ~560px the three-across row crushed the copy column to a few
      // characters per line while the button kept its width, so the panel's own words broke before its
      // call to action did. `minWidth` on the copy is what forces the button onto the next line first.
      display: "flex", alignItems: "center", gap: 16, padding: "16px 18px", flexWrap: "wrap",
      background: `radial-gradient(560px 180px at 12% -40%, ${color.phosphorDim}, transparent 70%), ${color.panel}`,
    }}>
      <span style={{ color: color.phosphor, display: "inline-flex", flexShrink: 0 }}><LogoMark size={26} /></span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontFamily: font.head, fontSize: 14, color: color.text }}>New project from a template</div>
        <div style={{ fontFamily: font.mono, fontSize: 11.5, color: color.textMuted, marginTop: 3, lineHeight: 1.5 }}>
          Pick a workflow template, point Loom at a repo, and get a ready-to-run team plus a starter board card — in four quick steps.
        </div>
      </div>
      <Button variant="primary" onClick={onStart} style={{ padding: "6px 14px", fontSize: 13, flexShrink: 0 }}>
        Start guided setup →
      </Button>
    </Panel>
  );
}

// The operator + auditor go-live cards. Every gating prop is passed through from the resolved surface —
// the section itself decides nothing about who may spawn what.
function PlatformAgentsSection({
  edition, previewOnly, operator, auditor, operatorSpawnRole, operatorRoleUnknown,
  operatorLive, auditorLive, liveCountFor, auditorFooter,
}: Pick<PlatformSurface, "edition" | "previewOnly" | "operator" | "auditor" | "operatorSpawnRole"
  | "operatorRoleUnknown" | "operatorLive" | "auditorLive" | "liveCountFor"> & { auditorFooter?: ReactNode }) {
  return (
    <section>
      <SectionLabel>{edition.copy.agentsLabel}</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
        <AgentControl edition={edition} agent={operator} role={operatorSpawnRole} card={edition.copy.operatorCard}
          session={operatorLive} liveCount={liveCountFor(operator?.id)} showLiveCount={!edition.operatorSingleton}
          gate={operatorSpawnDisabled} previewDisabled={previewOnly} roleUnknown={operatorRoleUnknown} />
        {/* The auditor card takes previewDisabled too. It was the hole this card closed: `auditorCreateOnly`
            makes auditorSpawnDisabled() ignore `live` entirely, so without this the preview's "Review my
            workspace" was enabled unconditionally and really spawned against the previewed home's auditor. */}
        <AgentControl edition={edition} agent={auditor} role={edition.auditorRole} card={edition.copy.auditorCard}
          session={auditorLive} liveCount={liveCountFor(auditor?.id)} showLiveCount={false}
          gate={auditorSpawnDisabled} previewDisabled={previewOnly} footer={auditorFooter} />
      </div>
    </section>
  );
}

// The dev GRID of every live platform session, or the end-user's two single-session sections.
function PlatformSessionsSection({ edition, previewOnly, homeSessions, operatorLive, auditorLive }:
  Pick<PlatformSurface, "edition" | "previewOnly" | "homeSessions" | "operatorLive" | "auditorLive">) {
  if (edition.sessionLayout === "grid") {
    return (
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {edition.copy.sessionsLabel}
          <span style={{ color: color.textMuted, fontWeight: 400 }}>({homeSessions.filter((s) => s.processState === "live").length} live)</span>
        </SectionLabel>
        <PlatformSessions sessions={homeSessions} emptyLabel={edition.copy.sessionsEmpty} previewOnly={previewOnly} />
      </section>
    );
  }
  return (
    <>
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {edition.copy.operatorSessionLabel}
          {operatorLive && <StatusPill tone={operatorLive.busy ? "amber" : "phosphor"} glow={operatorLive.busy} label={operatorLive.busy ? "busy" : "idle"} />}
        </SectionLabel>
        <SingleSession session={operatorLive} empty={edition.copy.operatorSessionEmpty} previewOnly={previewOnly} />
      </section>
      <section>
        <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {edition.copy.auditorSessionLabel}
          {auditorLive && <StatusPill tone={auditorLive.busy ? "amber" : "phosphor"} glow={auditorLive.busy} label={auditorLive.busy ? "busy" : "idle"} />}
        </SectionLabel>
        <SingleSession session={auditorLive} empty={edition.copy.auditorSessionEmpty}
          stopTitle={edition.copy.auditorCard.stopTitle} previewOnly={previewOnly} />
      </section>
    </>
  );
}

// Auditor cadence, VARIANT LIST (dev) as its own section — both layouts render it in this shape.
//
// Takes NO previewOnly, deliberately: `previewOnly` is passed on the END-USER mount only (pinned by
// test/platform-edition.mjs), and that edition's variant is "single-form" — so this leaf is unreachable
// in a preview and a gate here would be dead code no test could ever exercise.
function AuditorCadenceListSection({ edition, auditor }: Pick<PlatformSurface, "edition" | "auditor">) {
  return (
    <section>
      <SectionLabel>{edition.copy.auditorScheduleLabel}</SectionLabel>
      <AuditorScheduleList auditorId={auditor?.id} />
    </section>
  );
}

// Auditor cadence, VARIANT SINGLE-FORM (end-user) as its own section — the Atlas Cadence tab only. The
// classic layout renders the same form inside the auditor card's footer instead, so this wrapper exists
// purely to give that variant a section heading of its own once it is no longer inside a card. The
// missing-agent state mirrors AuditorScheduleList's, so an unseeded auditor reads the same either way.
function AuditorCadenceFormSection({ edition, previewOnly, auditor }:
  Pick<PlatformSurface, "edition" | "previewOnly" | "auditor">) {
  return (
    <section>
      <SectionLabel>{edition.copy.auditorScheduleLabel}</SectionLabel>
      {auditor
        ? <Panel style={{ padding: 12, maxWidth: 620 }}><AuditorScheduleInline agent={auditor} previewOnly={previewOnly} /></Panel>
        : <Panel style={{ padding: 12 }}><span style={{ color: color.amber, fontFamily: font.mono, fontSize: 12 }}>No Auditor agent — cannot schedule.</span></Panel>}
    </section>
  );
}

// Run history for each role — dev collapses (CollapsibleHistory), end-user expands.
//
// Each run row carries a RESUME button, which un-archives and respawns that run — a write against the
// previewed home's own session, and the end-user edition renders these sections EXPANDED, so it is
// reachable without even a disclosure click. Both mounts take the gate.
function PlatformHistorySections({ edition, previewOnly, project, homeSessions }:
  Pick<PlatformSurface, "edition" | "previewOnly" | "project" | "homeSessions">) {
  return (
    <>
      <HistorySection collapsed={edition.historyCollapsed} copy={edition.copy.operatorHistory}>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role={edition.operatorRole}
          emptyLabel={edition.copy.operatorHistory.empty} previewOnly={previewOnly} />
      </HistorySection>
      <HistorySection collapsed={edition.historyCollapsed} copy={edition.copy.auditorHistory}>
        <RunHistory reservedProjectId={project.id} sessions={homeSessions} role={edition.auditorRole}
          emptyLabel={edition.copy.auditorHistory.empty} showFindings={edition.auditorHistoryShowFindings}
          previewOnly={previewOnly} />
      </HistorySection>
    </>
  );
}

// The reserved home's OWN board (the reused Board component, pointed at this project by id — never the
// header's active project, which is what makes a Platform board show platform cards).
//
// Takes NO previewOnly, by decision (b472645a), on this ground: card CRUD writes TASKS, and a task is
// not one of the previewed home's agents/schedules/sessions, which is the criterion the gate draws its
// line on. ⛔ NOT because the board is reachable elsewhere — a RESERVED home is not selectable in the
// project picker (`db.ts` listProjects filters `reserved = 0`), so on a dev install this preview is the
// ONLY UI route to it. That reachability argument was wrong and has been removed; don't reintroduce it.
//
// ⚠️ NAMED RESIDUAL: Board's subtree includes `components/requests.tsx`, whose answer/dismiss/credential
// actions and NudgeMgr `sendInput` WOULD act on a session. Unreachable today only because no role the
// setup home hosts on a dev install registers `question_ask` — see the record for the verified check and
// the follow-up trigger. PlatformFindings' Adopt/Dismiss (daemon-GLOBAL suggestion store, not
// home-scoped) and GuidedSetupLauncher (edition-agnostic; creates a NEW project) are separate decisions.
function PlatformBoardSection({ edition, project, deepLinks }:
  Pick<PlatformSurface, "edition" | "project"> & { deepLinks?: boolean }) {
  return (
    <section>
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {edition.copy.board.label}
        <span style={{ color: color.textMuted, fontWeight: 400, fontFamily: font.mono, fontSize: 11 }}>
          {edition.copy.board.hint}
        </span>
      </SectionLabel>
      <Board projectId={project.id} deepLinks={deepLinks} />
    </section>
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
function AgentControl({ edition, agent, role, card, session, liveCount, showLiveCount, gate, footer, previewDisabled, roleUnknown }: {
  edition: PlatformEdition; agent?: Agent; role: PlatformSpawnRole; card: AgentCardCopy;
  session?: SessionListItem; liveCount: number; showLiveCount: boolean;
  gate: (edition: PlatformEdition, s: { live: boolean; pending: boolean }) => boolean;
  footer?: ReactNode;
  // f437d4e9 C5: true only for a DEV install's "View as: End-user" preview (Platform.tsx) — the
  // underlying agent there is never upgraded to the Lead (§1c), so the spawn button is disabled rather
  // than minting a stray role:"platform" session against it.
  //
  // @decision b472645a — this flag now holds EVERY write on the card (spawn, Stop, the prompt editor),
  // not just the spawn: the preview reaches a DIFFERENT home than the Developer view, so it is the only
  // Platform-page route to these agents. Never re-narrow it to the spawn button alone.
  previewDisabled?: boolean;
  // f437d4e9 C5 round 3 (M2): true only for the OPERATOR card, while `role` is still a genuinely
  // unresolved guess (profiles not loaded yet) — resolveOperatorSpawnRole's own `spawnDisabled`. Holds
  // the spawn button so a click can never mint the wrong role on the real Lead agent.
  roleUnknown?: boolean;
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
  const spawnDisabled = !!previewDisabled || !!roleUnknown || gate(edition, { live, pending: spawn.isPending });
  const spawnLabel = spawn.isPending ? card.spawn.pending : live ? card.spawn.live : card.spawn.idle;
  const spawnTitle = previewDisabled ? PREVIEW_DISABLED_TITLE
    : roleUnknown ? "Loading agent profile — please wait"
    : live ? card.title.live : card.title.idle;
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
          <Button variant="danger" disabled={!!previewDisabled || stop.isPending}
            title={previewDisabled ? PREVIEW_DISABLED_TITLE : card.stopTitle}
            onClick={() => stop.mutate(session!.id)}>{stop.isPending ? "Stopping…" : "Stop"}</Button>
        )}
      </div>
      {previewDisabled && <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono }}>{PREVIEW_DISABLED_NOTE}</span>}
      {spawn.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{errorText(spawn.error)}</span>}
      {/* View / edit this reserved-home agent's startup prompt (the spawn kickoff). Readable in a preview,
          never writable — the editor's own Ctrl/Cmd+Enter is a save trigger the buttons don't cover. */}
      <AgentPromptEditor key={`prompt-${agent.id}`} agent={agent} homeKey={[edition.homeQueryKey]}
        readOnly={!!previewDisabled} />
      {footer}
    </Panel>
  );
}

// The DEV live-session GRID (Lead/Auditor terminals), tiled with a graceful-stop + maximize control.
// Dead/exited rows are dropped (the live set only) — mirrors the Terminals grid, scoped to the reserved
// project. Each tile is the shared PlatformSessionTile (status + PresetPrompts + Stop + maximize, NO Fork —
// forking would mint a second ELEVATED session off-screen; spawn fresh from the Agents controls instead).
function PlatformSessions({ sessions, emptyLabel, previewOnly }:
  { sessions: SessionListItem[]; emptyLabel: string; previewOnly: boolean }) {
  const live = sessions.filter((s) => s.processState === "live");
  if (live.length === 0) return <p style={{ color: color.textMuted, marginTop: 0 }}>{emptyLabel}</p>;
  const grid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12, alignItems: "start" };
  return (
    <div style={grid}>
      {live.map((s) => <PlatformSessionTile key={s.id} session={s} height={440} previewOnly={previewOnly} />)}
    </div>
  );
}

// The END-USER single live-session wrapper (operator OR auditor). Uses the shared PlatformSessionTile — NO
// Fork (forking would mint a second setup/auditor session). Empty state prompts the go-live control above.
function SingleSession({ session, empty, stopTitle, previewOnly }:
  { session?: SessionListItem; empty: string; stopTitle?: string; previewOnly: boolean }) {
  if (!session) return <p style={{ color: color.textMuted, marginTop: 0 }}>{empty}</p>;
  return <PlatformSessionTile session={session} height={480} maxWidth={920} stopTitle={stopTitle}
    previewOnly={previewOnly} />;
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
    meta: { inlineError: true },
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
      {/* Wraps at a phone width — unwrapped, the cron field and the field-order hint squeezed the button
          until its label clipped to "Add", which is the one control in the row that must stay readable.
          (The single-form variant's own row already wraps; this matches it.) */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false} style={{ width: 160 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        <Button variant="primary" disabled={!cronValid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Adding…" : "Add cadence"}
        </Button>
        {create.isError && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{errorText(create.error).includes("400") ? "Daemon rejected the cron expression." : errorText(create.error)}</span>}
      </div>
    </Panel>
  );
}

function AuditorScheduleRow({ s, onToggle, onRemove, busy }:
  { s: Schedule; onToggle: (enabled: boolean) => void; onRemove: () => void; busy: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: font.mono, fontSize: 12, color: color.textDim,
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
function AuditorScheduleInline({ agent, previewOnly }: { agent: Agent; previewOnly: boolean }) {
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: api.schedules });
  const existing = (schedules.data ?? []).find((s) => s.agentId === agent.id && s.kind === "workspace-auditor");
  return <AuditorScheduleInlineForm key={existing?.id ?? "new"} agentId={agent.id} existing={existing}
    previewOnly={previewOnly} />;
}

// @decision b472645a — gate the COMPONENT, never the one visible button: Schedule/Save/Enable/Disable/
// Remove are five mutations whose rendering is conditional, so whichever ones a given home happens not to
// show today are exactly the ones a button-by-button gate silently misses.
function AuditorScheduleInlineForm({ agentId, existing, previewOnly }:
  { agentId: string; existing?: Schedule; previewOnly: boolean }) {
  const qc = useQueryClient();
  const [cron, setCron] = useState(existing?.cron ?? "0 9 * * *");
  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules"] });
  const create = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.createSchedule({ agentId, cron: cron.trim(), enabled: true, kind: "workspace-auditor", name: "Workspace Auditor" }), onSuccess: invalidate });
  const save = useMutation({ meta: { inlineError: true },
    mutationFn: () => api.updateSchedule(existing!.id, { cron: cron.trim() }), onSuccess: invalidate });
  const toggle = useMutation({ mutationFn: () => api.updateSchedule(existing!.id, { enabled: !existing!.enabled }), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteSchedule(existing!.id), onSuccess: invalidate });

  // `held` is read by each control AND by the <fieldset> that wraps them (below). The fieldset is what
  // makes the inheritance claim true, and the claim is specifically this: a FORM CONTROL added there
  // later is inert, because a disabled fieldset disables the form controls it contains. It does NOT
  // cover a non-form-control write — a plain `<div onClick>`, an anchor, a drag handler — so a new write
  // of that shape still has to read `held` itself. The per-control `disabled={held || …}` flags stay on
  // top, deliberately: they are what the structural pin can read, and they keep each control's own
  // reason for being disabled visible at the call site. `dirty` folds it in too, so Save can never light
  // up on a field that cannot be edited.
  const held = previewOnly;
  const cronValid = looksLikeCron(cron);
  const dirty = !held && !!existing && cron.trim() !== existing.cron;
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
      {/* A DISABLED FIELDSET, not just disabled buttons: it disables every form control it contains, so a
          control added here later is inert in a preview even if whoever adds it never reads `held`. The
          per-control flags stay on top (see `held`'s own note). `border:none`/`padding:0`/`margin:0` keep
          the UA's default fieldset chrome from changing this row's appearance at all. */}
      <fieldset disabled={held} style={{ border: "none", padding: 0, margin: 0, minInlineSize: 0,
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" spellCheck={false}
          readOnly={held} disabled={held} style={{ width: 150 }} />
        <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>min hour dom mon dow</span>
        {existing ? (
          <>
            <Button variant="primary" disabled={held || !cronValid || !dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</Button>
            <Button disabled={held || toggle.isPending} onClick={() => toggle.mutate()} title={held ? PREVIEW_DISABLED_TITLE : existing.enabled ? "Pause this cadence (stops firing)" : "Resume this cadence"}>{existing.enabled ? "Disable" : "Enable"}</Button>
            <Button variant="danger" disabled={held || remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
          </>
        ) : (
          <Button variant="primary" disabled={held || !cronValid || create.isPending} title={held ? PREVIEW_DISABLED_TITLE : undefined} onClick={() => create.mutate()}>{create.isPending ? "Scheduling…" : "Schedule"}</Button>
        )}
      </fieldset>
      {held && <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono }}>{PREVIEW_DISABLED_NOTE}</span>}
      {!cronValid && cron.trim().length > 0 && <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>Expected 5 whitespace-separated fields.</span>}
      {existing && <span style={{ color: color.textDim, fontFamily: font.mono, fontSize: 11 }}>next · {fmt(existing.nextFireAt)}</span>}
      {err && <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono }}>{err.message.includes("400") ? "Daemon rejected the cron expression." : err.message}</span>}
    </div>
  );
}
