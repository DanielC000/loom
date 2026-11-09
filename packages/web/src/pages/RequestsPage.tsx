import { useState } from "react";
import { RequestsInbox, RequestHistory } from "../components/requests";
import { useFrameOwnsNodeIdentity } from "../lib/atlasNodeHead";
import { Segmented } from "../components/ui";
import { color, font, fs } from "../theme";

// The INBOX page (card 695ebab0; renamed from "Requests" by card 59fa6403) — the cross-project
// "waiting on me" + FYI queue plus a searchable History of consumed requests. A god-eye destination like
// Mission Control, not project-scoped. Two tabs over the shared Requests surfaces in components/requests —
// the file/component names stay as-is (see docs/decisions/59fa6403-requests-to-inbox.md §(f)); only the
// user-facing label changed.
type Tab = "inbox" | "history";

export default function RequestsPage() {
  const [tab, setTab] = useState<Tab>("inbox");
  // The page's name leads its own tab row under the classic shell; inside the Atlas frame the crumbs,
  // the node head and the Workspace tab row all already say "Inbox", so it goes (card a7f23a2f) and
  // the two tabs start at the content column's left edge.
  const ownIdentity = !useFrameOwnsNodeIdentity();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {ownIdentity && (
          <span data-testid="page-identity" style={{ fontFamily: font.ui, fontSize: fs.lg, color: color.text, marginRight: 12 }}>Inbox</span>
        )}
        {/* The kit Segmented, the same sub-tab control Automation and Actors use (audit A-24), in place
            of the page's own bordered pill buttons. */}
        <Segmented<Tab> ariaLabel="Inbox view" value={tab} onChange={setTab}
          items={[{ key: "inbox", label: "Waiting on me" }, { key: "history", label: "History" }]} />
      </div>
      {tab === "inbox" ? <RequestsInbox /> : <RequestHistory />}
    </div>
  );
}
