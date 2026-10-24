import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAttention, attentionOpenTarget, isAnswerableRequest } from "../lib/attention";
import { useOpenRequest } from "./requests";
import { atlasRetirementFor, useVisibleNavPages } from "../nav";
import { useAtlasUi } from "../lib/atlasUi";
import { color, font } from "../theme";

// Ctrl/Cmd-K fuzzy launcher: jump to any page, or open the target of a pending attention item — a merge
// request opens the review panel, every other alert opens the session it concerns (attentionOpenTarget).
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  const { items: attention } = useAttention();
  // Gated nav list — the dev "Loom Platform" entry stays out for shipping users (see useVisibleNavPages).
  const allNavPages = useVisibleNavPages();
  // This palette is CROSS-CUTTING chrome: App.tsx mounts the one instance for BOTH shells. So it is the
  // one place outside the shells themselves that has to know a destination was RETIRED under Atlas
  // (card 5afd71bd) — otherwise ⌘K keeps offering "Mission Control", and picking it silently lands the
  // reader on the Workspace node, which is a worse answer than not offering it: the row promised a
  // destination that no longer exists. With the switch OFF the list is byte-identical, which is what
  // keeps the classic palette untouched for a user who never opted in.
  //
  // Read at the component's own entry, once, the way pages/Settings.tsx reads it to pick its sections —
  // not inside the row-building map, and never by a row deciding its own visibility.
  const [atlasOn] = useAtlasUi();
  const navPages = atlasOn ? allNavPages.filter((p) => !atlasRetirementFor(p.to)) : allNavPages;

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
      // Structural check (any pending/orphaned Request type, OR a self-terminal notice, carries a
      // questionId) — the kind LABEL now varies by type (DECISION/SECRET/PERMISSION/INPUT NEEDED/FYI), so
      // it can't be compared literally. This is ROUTING only (does it open the Request modal) — a notice
      // routes here too, since opening it is how a human marks it read.
      const isRequest = a.questionId != null;
      // Card 68f27faf round 3 (CR 7cbb6994, item 1): the LABEL, by contrast, must distinguish an
      // answerable ask from a notice (which needs no answer) — `isAnswerableRequest` is the one place that
      // distinction lives (AttentionRow/App.tsx read the same helper).
      const answerable = isAnswerableRequest(a);
      const verb = merge ? "Review" : answerable ? "Answer" : "Open";
      const hint = merge ? "review" : isRequest ? "question" : "session";
      // A REQUEST opens the shared in-place modal (the provider renders it, so the closing palette can't
      // race the mount); everything else navigates to its route. `go()` closes the palette after `run`.
      const run = isRequest ? () => openRequest(a.questionId!) : () => navigate(target);
      return [{ label: `${verb} · ${a.kind} ${a.text}`, hint, run }];
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
