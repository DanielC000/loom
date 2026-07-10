import { useParams, useNavigate } from "react-router-dom";
import { Button } from "../components/ui";
import { RequestDetail } from "../components/requests";
import { color, font } from "../theme";

// The deep-link REQUEST page (/question/:id) — the same detail/response content the inbox opens as a modal,
// rendered as a standalone route so a bookmark, the attention toast, or a fleet affordance still resolves.
// The PRIMARY interaction is the in-place modal (see components/requests → RequestModal); this is the
// durable URL for the same content. Keyed by id so pick/note/result never carry across a navigation.
export default function QuestionAnswer() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button onClick={() => navigate(-1)}>← back</Button>
        <span style={{ fontFamily: font.head, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>Request</span>
      </div>
      <RequestDetail key={id} id={id} />
    </div>
  );
}
