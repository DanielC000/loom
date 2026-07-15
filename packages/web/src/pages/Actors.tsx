import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/ui";
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
  const [params, setParams] = useSearchParams();
  const tab: ActorsTab = params.get("tab") === "skills" ? "skills" : "profiles";
  // Profiles is the default/canonical tab, so its URL carries no query; only Skills pins `?tab=skills`.
  // `replace` keeps tab switches out of the history stack (a back press leaves the page, not the tab).
  const setTab = (t: ActorsTab) => setParams(t === "skills" ? { tab: "skills" } : {}, { replace: true });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented value={tab} onChange={setTab} items={TABS} ariaLabel="Actors — Profiles or Skills" />
      {tab === "profiles" ? <Profiles /> : <Skills />}
    </div>
  );
}
