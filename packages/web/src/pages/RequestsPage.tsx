import { useState } from "react";
import { RequestsInbox, RequestHistory } from "../components/requests";
import { color, font, radius } from "../theme";

// The REQUESTS page (card 695ebab0) — the cross-project "waiting on me" queue (Inbox) plus a searchable
// History of consumed requests. A god-eye destination like Mission Control, not project-scoped. Two tabs
// over the shared Requests surfaces in components/requests.
type Tab = "inbox" | "history";

export default function RequestsPage() {
  const [tab, setTab] = useState<Tab>("inbox");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontFamily: font.head, fontSize: 16, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text, marginRight: 12 }}>Requests</span>
        <TabButton label="Waiting on me" active={tab === "inbox"} onClick={() => setTab("inbox")} />
        <TabButton label="History" active={tab === "history"} onClick={() => setTab("history")} />
      </div>
      {tab === "inbox" ? <RequestsInbox /> : <RequestHistory />}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ background: active ? color.panel2 : "transparent", border: `1px solid ${active ? color.phosphor : color.border}`,
        borderRadius: radius.sm, padding: "4px 12px", cursor: "pointer", fontFamily: font.mono, fontSize: 12,
        color: active ? color.phosphor : color.textDim }}>
      {label}
    </button>
  );
}
