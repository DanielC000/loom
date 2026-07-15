import { useSearchParams } from "react-router-dom";
import { Segmented } from "../components/ui";
import Schedules from "./Schedules";
import EventTriggers from "./EventTriggers";

// "Automation" — the consolidated trigger surface for Loom's two structural twins: cron Schedules (the
// TIME trigger — fire an agent on a clock boundary) and Event Triggers (the EVENTS counterpart — fire on
// an internal orchestration event). Both are god-eye (their tables span every project) and share the same
// table + create/edit-modal shell, so a single Segmented switch sits above and swaps which body mounts.
// Each body keeps its own builder scope: the Time builder's target-agent picker stays limited to the
// active project (see Schedules.tsx), while the Events target may be any project's session/agent. The old
// /schedules and /event-triggers routes redirect here (App.tsx); the `?tab=` query keeps a chosen tab
// linkable and is what those redirects target (/event-triggers → /automation?tab=events).
type AutomationTab = "time" | "events";

const TABS: { key: AutomationTab; label: string }[] = [
  { key: "time", label: "Time (cron)" },
  { key: "events", label: "Events" },
];

export default function Automation() {
  const [params, setParams] = useSearchParams();
  const tab: AutomationTab = params.get("tab") === "events" ? "events" : "time";
  // Time is the default/canonical tab, so its URL carries no query; only Events pins `?tab=events`.
  // `replace` keeps tab switches out of the history stack (a back press leaves the page, not the tab).
  const setTab = (t: AutomationTab) => setParams(t === "events" ? { tab: "events" } : {}, { replace: true });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Segmented value={tab} onChange={setTab} items={TABS} ariaLabel="Automation — Time or Events triggers" />
      {tab === "time" ? <Schedules /> : <EventTriggers />}
    </div>
  );
}
