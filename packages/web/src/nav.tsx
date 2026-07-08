import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { isCompanionActive, withCompanionNavGating } from "./lib/companion";
import MissionControl from "./pages/MissionControl";
import Projects from "./pages/Projects";
import Overview from "./pages/Overview";
import Archive from "./pages/Archive";
import Terminals from "./pages/Terminals";
import DecisionInboxPage from "./pages/DecisionInboxPage";
import Board from "./pages/Board";
import Runs from "./pages/Runs";
import Vault from "./pages/Vault";
import Git from "./pages/Git";
import Skills from "./pages/Skills";
import Profiles from "./pages/Profiles";
import Companion from "./pages/Companion";
import Schedules from "./pages/Schedules";
import Usage from "./pages/Usage";
import Platform from "./pages/Platform";
import Settings from "./pages/Settings";

// The four header sections. Primary pages render as tabs; everything else is grouped under
// these labels in the header's "More ▾" menu (see App.tsx).
export type NavGroup = "operate" | "project" | "config" | "system";

export type NavPage = {
  /** Full name — used by the Command Palette. */
  label: string;
  /** Short header-tab text when it differs from `label`. */
  nav?: string;
  to: string;
  /** Exact-match active state (for the index route). */
  end?: boolean;
  element: ReactNode;
  /** Which "More ▾" section this page falls under (and a sensible bucket for primary tabs). */
  group: NavGroup;
  /** Rendered as a top-level header tab (vs. tucked into the "More ▾" menu). */
  primary?: boolean;
  /** Responds to the header's active-project picker — gets a scope-marker dot in the nav. */
  scoped?: boolean;
};

// Single source of truth for the nav destinations. The header (primary tabs + the grouped
// "More ▾" menu), the route table (App.tsx), and the Command Palette page list
// (CommandPalette.tsx) all derive from this array, so they can never drift out of sync.
// Add a new top-level page here only — tag it with a `group`, and `primary`/`scoped` as needed.
// (The /review/:workerId route is parameterized and not a nav destination, so it stays
// declared directly in App.tsx.)
//
// Ordered primary-first (in tab order), then by group so the derived "More ▾" sections read
// top-to-bottom: Operate · Project · Config · System.
//
// `scoped` was determined from `git grep -l useActiveProject packages/web/src/pages` and then
// VERIFIED per page (does switching the active project actually rescope it?): Overview, Board,
// Runs, Vault, Git, Schedules (per-project agents), Settings (edits the active project's config
// override). Archive imports nothing scoped (its `projectId` fields are its own grouping type),
// and Projects has its OWN project rail (which writes the active project) — both intentionally NOT scoped.
export const NAV_PAGES: NavPage[] = [
  // ── Primary tabs (header), in display order ──────────────────────────────────
  { label: "Mission Control", nav: "Mission", to: "/", end: true, element: <MissionControl />, group: "system", primary: true },
  // The project-scoped Overview — the analog of the Platform page for the header's active project
  // (identity + fleet + go-live + board + schedules + attention/activity + archive count, all rescoped
  // when you switch the active project). Composes the shared fleet widgets off existing endpoints.
  { label: "Overview", to: "/overview", element: <Overview />, group: "project", primary: true, scoped: true },
  // The single "Platform" section — ONE tab, ONE /platform route. The page itself picks which surface to
  // render by EDITION (the reserved "Loom Platform" home existing): dev gets the Loom Platform home
  // (Lead/Auditor + findings board) plus a client-only "View as" toggle previewing the end-user surface;
  // shipping gets the end-user "Platform" operator + Workspace Auditor only. A top-level surface
  // SEPARATE from the project picker (both reserved homes stay out of the ordinary list). Deliberately
  // `scoped` OFF. The edition logic lives IN Platform.tsx, so there is no nav-level gating anymore.
  // /setup redirects to /platform (App.tsx) for any lingering links.
  { label: "Platform", to: "/platform", element: <Platform />, group: "system", primary: true },
  { label: "Terminals", to: "/terminals", element: <Terminals />, group: "operate", primary: true },
  { label: "Board", to: "/board", element: <Board />, group: "project", primary: true, scoped: true },
  // ── More ▾ · Operate ─────────────────────────────────────────────────────────
  // The GLOBAL manager→human decision inbox (card 8701bdbb) — a cross-project "waiting on me" queue, a
  // god-eye destination like Mission Control (deliberately NOT project-scoped). The bell/toast/⌘K + the
  // Mission Control attention queue are the primary surfacing; this is the fuller "see them all, filter
  // by project" view.
  { label: "Decisions", to: "/inbox", element: <DecisionInboxPage />, group: "operate" },
  { label: "Runs", to: "/runs", element: <Runs />, group: "operate", scoped: true },
  { label: "Archive", to: "/archive", element: <Archive />, group: "operate" },
  // ── More ▾ · Project ─────────────────────────────────────────────────────────
  { label: "Vault", to: "/vault", element: <Vault />, group: "project", scoped: true },
  { label: "Git", to: "/git", element: <Git />, group: "project", scoped: true },
  // ── More ▾ · Config ──────────────────────────────────────────────────────────
  // Projects — the definition/config layer: create/manage projects + define their agents (assign a
  // Profile, edit the startup prompt). Renamed + repositioned from the old "Workspace" page (card
  // 274f9ba9): it's config, not operate — it touches NO live sessions — so it sits with the other
  // "define your actors" surfaces (Profiles, Skills). Its own project rail writes the active project,
  // so it is deliberately NOT `scoped`. /workspace redirects here (App.tsx) for lingering links.
  { label: "Projects", to: "/projects", element: <Projects />, group: "config" },
  { label: "Skills", to: "/skills", element: <Skills />, group: "config" },
  { label: "Profiles", to: "/profiles", element: <Profiles />, group: "config" },
  // Companion management is daemon-GLOBAL (one companion config store, not project-scoped) — deliberately
  // not `scoped`. Declared here under Config alongside Profiles (the companion's restricted-tools toggle is
  // there); `useVisibleNavPages` promotes it to a primary header tab at runtime when a companion is ACTIVE
  // (UI-audit finding #4) — see `withCompanionNavGating`/`isCompanionActive` in lib/companion.ts. Inactive,
  // it stays right here under More ▾ · Config.
  { label: "Companion", to: "/companion", element: <Companion />, group: "config" },
  { label: "Schedules", to: "/schedules", element: <Schedules />, group: "config", scoped: true },
  // The standalone Orchestration page (its manager→worker→diff drill-down) was REMOVED (card bde7957f):
  // its two unique views — the per-manager orchestration_events timeline + the worker branch-diff — now
  // live as role-scoped tabs in the Overview fleet-card expansion (FleetAccordion → SessionCockpit), so
  // the drill-down is reached from the fleet card rather than a duplicate top-level destination.
  // ── More ▾ · System ──────────────────────────────────────────────────────────
  { label: "Usage", to: "/usage", element: <Usage />, group: "system" },
  { label: "Settings", to: "/settings", element: <Settings />, group: "system", scoped: true },
];

// The source of truth for what the header tabs, the "More ▾" menu, and the Command Palette LIST show
// (App.tsx + CommandPalette.tsx all call this). Every nav page is always LISTED (the dev-vs-shipping
// edition split that used to hide a second "Platform" tab now lives INSIDE the single Platform page, which
// picks its surface by edition) — the one runtime gate is Companion's `primary` flag, promoted to a header
// tab only while a companion is ACTIVE (see `withCompanionNavGating`). Reuses the existing companion-config
// + sessions reads (same query keys pages/Companion.tsx already uses), so this never fires an extra request
// beyond react-query's normal cache/refetch behavior.
export function useVisibleNavPages(): NavPage[] {
  const configs = useQuery({ queryKey: ["companionConfigs"], queryFn: api.companionConfigs });
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions });
  return withCompanionNavGating(NAV_PAGES, isCompanionActive(configs.data, sessions.data));
}
