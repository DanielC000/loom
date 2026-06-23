import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import MissionControl from "./pages/MissionControl";
import Workspace from "./pages/Workspace";
import Overview from "./pages/Overview";
import Archive from "./pages/Archive";
import Terminals from "./pages/Terminals";
import Board from "./pages/Board";
import Runs from "./pages/Runs";
import Orchestration from "./pages/Orchestration";
import Vault from "./pages/Vault";
import Git from "./pages/Git";
import Skills from "./pages/Skills";
import Profiles from "./pages/Profiles";
import Schedules from "./pages/Schedules";
import Usage from "./pages/Usage";
import Platform from "./pages/Platform";
import Setup from "./pages/Setup";
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
  /** Gate this nav entry (header tab + Command Palette listing) on the dev "Loom Platform" home
   *  existing — its `/api/platform/home` only resolves under LOOM_DEV. The ROUTE stays registered
   *  regardless (App.tsx maps every NAV_PAGES route). Keeps shipping users to exactly ONE "Platform"
   *  tab (the end-user operator at /setup) with no empty dev Platform page. See useVisibleNavPages. */
  requiresPlatformHome?: boolean;
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
// Runs, Orchestration, Vault, Git, Schedules (per-project agents), Settings (edits the active
// project's config override). Archive imports nothing scoped (its `projectId` fields are its own
// grouping type), and Workspace has its OWN project picker — both intentionally NOT scoped.
export const NAV_PAGES: NavPage[] = [
  // ── Primary tabs (header), in display order ──────────────────────────────────
  { label: "Mission Control", nav: "Mission", to: "/", end: true, element: <MissionControl />, group: "system", primary: true },
  // The project-scoped Overview — the analog of the Platform page for the header's active project
  // (identity + fleet + go-live + board + schedules + attention/activity + archive count, all rescoped
  // when you switch the active project). Composes the shared fleet widgets off existing endpoints.
  { label: "Overview", to: "/overview", element: <Overview />, group: "project", primary: true, scoped: true },
  // The dev "Loom Platform" section — the reserved "Loom Platform" home (Lead/Auditor + findings board),
  // a top-level surface SEPARATE from the project picker (the reserved project stays out of that list).
  // LOOM_DEV-only: its /api/platform/home 404s for shipping users, so the nav entry is GATED on that home
  // existing (requiresPlatformHome) — otherwise the end-user "Platform" tab (/setup, below) and this tab
  // would BOTH read "Platform". Relabeled "Loom Platform" so the two never collide under LOOM_DEV. The
  // route stays /platform. Deliberately stays `scoped` OFF (separate from the picker).
  { label: "Loom Platform", to: "/platform", element: <Platform />, group: "system", primary: true, requiresPlatformHome: true },
  // The end-user Platform section — the reserved "Getting Started" home's operator ("Platform") agent
  // (Start/Resume + live terminal). Always-available top-level surface, SEPARATE from the project picker
  // (the reserved home stays out of that list). Unscoped (it has no per-project meaning); the only way in.
  // The ROUTE stays /setup (an internal anchor — NOT renamed to /platform, which is the dev tab's route).
  { label: "Platform", to: "/setup", element: <Setup />, group: "system", primary: true },
  { label: "Terminals", to: "/terminals", element: <Terminals />, group: "operate", primary: true },
  { label: "Board", to: "/board", element: <Board />, group: "project", primary: true, scoped: true },
  { label: "Runs", to: "/runs", element: <Runs />, group: "operate", primary: true, scoped: true },
  // ── More ▾ · Operate ─────────────────────────────────────────────────────────
  { label: "Workspace", to: "/workspace", element: <Workspace />, group: "operate" },
  { label: "Archive", to: "/archive", element: <Archive />, group: "operate" },
  // ── More ▾ · Project ─────────────────────────────────────────────────────────
  { label: "Orchestration", to: "/orchestration", element: <Orchestration />, group: "project", scoped: true },
  { label: "Vault", to: "/vault", element: <Vault />, group: "project", scoped: true },
  { label: "Git", to: "/git", element: <Git />, group: "project", scoped: true },
  // ── More ▾ · Config ──────────────────────────────────────────────────────────
  { label: "Skills", to: "/skills", element: <Skills />, group: "config" },
  { label: "Profiles", to: "/profiles", element: <Profiles />, group: "config" },
  { label: "Schedules", to: "/schedules", element: <Schedules />, group: "config", scoped: true },
  // ── More ▾ · System ──────────────────────────────────────────────────────────
  { label: "Usage", to: "/usage", element: <Usage />, group: "system" },
  { label: "Settings", to: "/settings", element: <Settings />, group: "system", scoped: true },
];

// NAV_PAGES filtered by runtime gates — the source of truth for what the header tabs, the "More ▾" menu,
// and the Command Palette LIST (App.tsx + CommandPalette.tsx all call this). Routes are NOT gated here:
// App.tsx maps every NAV_PAGES route so a gated page is still reachable by URL. Today the only gate is
// `requiresPlatformHome`: the dev "Loom Platform" tab is hidden until its /api/platform/home resolves
// (it 404s for shipping users — LOOM_DEV-only), leaving shipping users exactly one "Platform" tab.
export function useVisibleNavPages(): NavPage[] {
  // retry:false — a shipping user's expected 404 must not spin through the default 3 retries before the
  // tab settles to hidden. Until success the gated tab stays hidden (the safe default), so a slow/absent
  // home never flashes the dev tab. Same query key as the Platform page → one shared, cached fetch.
  const platformHome = useQuery({ queryKey: ["platformHome"], queryFn: api.platformHome, retry: false });
  const hasPlatformHome = platformHome.isSuccess && !!platformHome.data?.project;
  return NAV_PAGES.filter((p) => (p.requiresPlatformHome ? hasPlatformHome : true));
}
