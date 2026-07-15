import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/ui";
import Vault from "./Vault";
import Git from "./Git";

// "Repository" — the consolidated project-scoped repo surface for the two adjacent per-project views:
// Files (the vault browser + type-aware viewer/editor) and Git (branches + commit-log + human-only
// checkout/branch/commit/push writers). Both are project-scoped (enabled:!!projectId, "No project
// selected" guard) and rescope on the header's active-project picker, so a single Segmented switch sits
// above and swaps which body mounts — the two internal layouts do NOT fuse; each pane is lifted verbatim.
// The label stays GENERIC ("Repository"), not "Vault", so neither sub-surface feels demoted. The old
// /vault and /git routes redirect here (App.tsx); the `?tab=` query keeps a chosen tab linkable and is
// what those redirects target (/git → /repository?tab=git).
type RepositoryTab = "files" | "git";

const TABS: { key: RepositoryTab; label: string }[] = [
  { key: "files", label: "Files" },
  { key: "git", label: "Git" },
];

export default function Repository() {
  const [params, setParams] = useSearchParams();
  const tab: RepositoryTab = params.get("tab") === "git" ? "git" : "files";
  // Files is the default/canonical tab, so its URL carries no query; only Git pins `?tab=git`.
  // `replace` keeps tab switches out of the history stack (a back press leaves the page, not the tab).
  const setTab = (t: RepositoryTab) => setParams(t === "git" ? { tab: "git" } : {}, { replace: true });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented value={tab} onChange={setTab} items={TABS} ariaLabel="Repository — Files or Git" />
      {tab === "files" ? <Vault /> : <Git />}
    </div>
  );
}
