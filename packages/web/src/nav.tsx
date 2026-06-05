import type { ReactNode } from "react";
import MissionControl from "./pages/MissionControl";
import Workspace from "./pages/Workspace";
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
import Settings from "./pages/Settings";

export type NavPage = {
  /** Full name — used by the Command Palette. */
  label: string;
  /** Short header-tab text when it differs from `label`. */
  nav?: string;
  to: string;
  /** Exact-match active state (for the index route). */
  end?: boolean;
  element: ReactNode;
};

// Single source of truth for the primary nav destinations. The header tabs and the route
// table (App.tsx) plus the Command Palette page list (CommandPalette.tsx) all derive from
// this array, so they can never drift out of sync. Add a new top-level page here only.
// (The /review/:workerId route is parameterized and not a nav destination, so it stays
// declared directly in App.tsx.)
export const NAV_PAGES: NavPage[] = [
  { label: "Mission Control", nav: "Mission", to: "/", end: true, element: <MissionControl /> },
  { label: "Workspace", to: "/workspace", element: <Workspace /> },
  { label: "Archive", to: "/archive", element: <Archive /> },
  { label: "Terminals", to: "/terminals", element: <Terminals /> },
  { label: "Board", to: "/board", element: <Board /> },
  { label: "Runs", to: "/runs", element: <Runs /> },
  { label: "Orchestration", to: "/orchestration", element: <Orchestration /> },
  { label: "Vault", to: "/vault", element: <Vault /> },
  { label: "Git", to: "/git", element: <Git /> },
  { label: "Skills", to: "/skills", element: <Skills /> },
  { label: "Profiles", to: "/profiles", element: <Profiles /> },
  { label: "Schedules", to: "/schedules", element: <Schedules /> },
  { label: "Usage", to: "/usage", element: <Usage /> },
  // The Platform section — the reserved "Loom Platform" home (Lead/Auditor + findings board), a
  // top-level surface SEPARATE from the project picker (the reserved project stays out of that list).
  { label: "Platform", to: "/platform", element: <Platform /> },
  { label: "Settings", to: "/settings", element: <Settings /> },
];
