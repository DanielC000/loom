import { DecisionInbox } from "../components/decisions";

// The DECISIONS page (card 8701bdbb, child B · surface 3 · A — GLOBAL). The cross-project "waiting on
// me" queue with a per-project facet — a god-eye destination like Mission Control, not project-scoped.
// Thin page wrapper; the queue itself lives in components/decisions so the same surface can be reused.
export default function DecisionInboxPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DecisionInbox />
    </div>
  );
}
