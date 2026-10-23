import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/ui";
import { useTabHost } from "../lib/nodeTabHost";
import Profiles from "./Profiles";
import Skills from "./Skills";

// "Actors" — the consolidated definition surface for the two human-managed, daemon-global rig stores:
// Profiles (the reusable agent rigs — role + model + permission deltas + skill subset) and Skills (Loom's
// own skill store). Both already share the exact same ~300px list→editor shell, so a single Segmented
// switch sits above and swaps which list+editor mounts. The old /profiles and /skills routes redirect
// here (App.tsx); the `?tab=` query keeps a chosen tab linkable and is what those redirects target
// (/skills → /actors?tab=skills). Companion is deliberately NOT folded in — it stays its own hub.
type ActorsTab = "profiles" | "skills";

const TABS: { key: ActorsTab; label: string }[] = [
  { key: "profiles", label: "Profiles" },
  { key: "skills", label: "Skills" },
];

export default function Actors() {
  const [params] = useSearchParams();
  // `tab` standalone; the host's own key when this page is the Workspace node's Actors tab (card
  // 41eab0eb) — writing a bare `tab` there would overwrite the host's own and drop the whole node
  // back to Overview. lib/nodeTabHost.tsx carries the full reasoning.
  const host = useTabHost();
  const tab: ActorsTab = params.get(host.key) === "skills" ? "skills" : "profiles";
  // Profiles is the default/canonical tab, so its URL carries no query of its own; only Skills pins a
  // value. `replace` keeps tab switches out of the history stack (a back press leaves the page, not
  // the tab), and the merge is what preserves the host's `?tab=` where there is one.
  const setTab = (t: ActorsTab) => host.set({ [host.key]: t === "skills" ? "skills" : null });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented value={tab} onChange={setTab} items={TABS} ariaLabel="Actors — Profiles or Skills" />
      {tab === "profiles" ? <Profiles /> : <Skills />}
    </div>
  );
}
