import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAttention, attentionOpenTarget } from "../lib/attention";
import { useVisibleNavPages } from "../nav";
import { color, font } from "../theme";

// Ctrl/Cmd-K fuzzy launcher: jump to any page, or open the target of a pending attention item — a merge
// request opens the review panel, every other alert opens the session it concerns (attentionOpenTarget).
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const { items: attention } = useAttention();
  // Gated nav list — the dev "Loom Platform" entry stays out for shipping users (see useVisibleNavPages).
  const navPages = useVisibleNavPages();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); setQ(""); }
      else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const commands = [
    ...navPages.map((p) => ({ label: p.label, hint: "page", run: () => navigate(p.to) })),
    ...attention.flatMap((a) => {
      const target = attentionOpenTarget(a);
      if (!target) return [];
      const merge = a.kind === "MERGE REQUEST";
      const decision = a.kind === "DECISION NEEDED";
      const verb = merge ? "Review" : decision ? "Answer" : "Open";
      const hint = merge ? "review" : decision ? "question" : "session";
      return [{ label: `${verb} · ${a.kind} ${a.text}`, hint, run: () => navigate(target) }];
    }),
  ].filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  const go = (run: () => void) => { run(); setOpen(false); setQ(""); };

  return (
    <div onClick={() => setOpen(false)}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: "90vw", background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: 4 }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && commands[0]) go(commands[0].run); }}
          placeholder="Jump to…  (Esc to close)"
          style={{ width: "100%", boxSizing: "border-box", background: color.panel2, color: color.text, border: "none", borderBottom: `1px solid ${color.border}`, padding: "10px 12px", fontFamily: font.mono, fontSize: 14, outline: "none" }} />
        <div style={{ maxHeight: "50vh", overflow: "auto" }}>
          {commands.length === 0 && <div style={{ padding: 12, color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No matches.</div>}
          {commands.map((c, i) => (
            <button key={i} onClick={() => go(c.run)}
              style={{ display: "flex", width: "100%", textAlign: "left", justifyContent: "space-between", gap: 8, background: "transparent", border: "none", borderBottom: `1px solid ${color.border}`, color: color.text, padding: "8px 12px", fontFamily: font.mono, fontSize: 13, cursor: "pointer" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
              <span style={{ color: color.textMuted, fontSize: 11 }}>{c.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
