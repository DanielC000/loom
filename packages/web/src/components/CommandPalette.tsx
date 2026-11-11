import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAttention, attentionKindLabel, attentionOpenTarget, isAnswerableRequest } from "../lib/attention";
import { useOpenRequest } from "./requests";
import {
  ATLAS_HOMES, PROJECT_NODE_PATH, PROJECT_NODE_TABS, isRehomedProjectTab, projectTabPath,
  useVisibleNavPages, type NavPage,
} from "../nav";
import { useActiveProject } from "../lib/activeProject";
import { useAllAgents } from "../lib/useAllAgents";
import { api } from "../lib/api";
import { isLiveSession } from "../lib/atlasHome";
import { rankPaletteRows, stepActive, type PaletteRow } from "../lib/paletteCommands";
import { color, font, radius, fs } from "../theme";

// Ctrl/Cmd-K launcher: jump to any page, project, agent or live session, or open the target of a
// pending attention item — a merge request opens the review panel, every other alert opens the
// session it concerns (attentionOpenTarget). Filtering and ranking live in lib/paletteCommands.ts
// (card bafbca40) so they are unit-tested; this file only builds the rows and drives the keyboard.

/** Opens the palette from anywhere — the crumb bar's ⌘K button calls this. */
export const COMMAND_PALETTE_OPEN_EVENT = "loom:command-palette-open";
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}
/** The accelerator as this platform spells it. Both modifiers work everywhere; this is only the label. */
export const PALETTE_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

type Row = PaletteRow & { run: () => void };

const LISTBOX_ID = "loom-palette-list";
const optionId = (key: string) => `loom-palette-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** The workspace tier's own name for a row's context — the same word the Atlas crumb trail roots at. */
const WORKSPACE = "Workspace";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  const { items: attention } = useAttention();
  const { projectId, setProjectId, projects } = useActiveProject();
  const navPages = useVisibleNavPages();

  // Both lists are caches other surfaces already fill (ActiveProjectProvider and the tree read
  // `["allSessions"]`; Settings and the schedule pickers read `["allAgents"]`). Fetched only while the
  // palette is open, so a closed palette costs nothing.
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal), enabled: open });
  const agentsQ = useAllAgents({ enabled: open });

  useEffect(() => {
    const show = () => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true); setQ(""); setActive(0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => { if (!o) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; return !o; });
        setQ(""); setActive(0);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, show);
    };
  }, []);

  // Give focus back to whatever had it, so a keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (open) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }, [open]);

  const projectName = projects.find((p) => p.id === projectId)?.name;
  const knownProject = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);

  const rows: Row[] = useMemo(() => {
    if (!open) return [];
    const go = (to: string) => () => navigate(to);
    // Scope first, then go — the page it lands on reads the ACTIVE project, exactly as the tree's
    // own rows do. A reserved home (not in `projects`) is never written as the active project.
    const scopeAndGo = (id: string, to: string) => () => {
      if (knownProject.has(id)) setProjectId(id);
      navigate(to);
    };
    const pageRow = (key: string, label: string, to: string, context: string | undefined): Row =>
      ({ key: `page:${key}`, kind: "page", label, context, run: go(to) });

    // ── Pages ──────────────────────────────────────────────────────────────────────────────────────
    // Each carries the tier it lives on, which is what tells apart the rows that share a label (the
    // project's Settings tab and the workspace's Settings node; the two Homes).
    const pages: Row[] = [];
    const projectTabFor = (to: string) =>
      PROJECT_NODE_TABS.find((t) => isRehomedProjectTab(t) && projectTabPath(t) === to);
    const atProjectDepth = (p: NavPage) => !!p.scoped || !!projectTabFor(p.to);
    const home = (key: string) => ATLAS_HOMES.find((h) => h.key === key);
    const ws = home("workspace");
    if (ws) pages.push(pageRow(ws.to, ws.label, ws.to, WORKSPACE));
    for (const p of navPages.filter((p) => !atProjectDepth(p))) pages.push(pageRow(p.to, p.label, p.to, WORKSPACE));
    for (const key of ["workspace-terminals", "workspace-settings"]) {
      const h = home(key);
      if (h) pages.push(pageRow(h.to, h.label, h.to, WORKSPACE));
    }
    pages.push(pageRow("skills", "Skills", "/actors?tab=skills", WORKSPACE));
    // The project tier, under the ACTIVE project's name. Listed with no project too (no context
    // then): each of these pages has its own "no project yet" state, and hiding them would make the
    // palette's page list depend on whether a project exists.
    pages.push(pageRow(PROJECT_NODE_PATH, "Home", PROJECT_NODE_PATH, projectName));
    // The node's tabs in its own order and under its own names ("Sessions", not "Terminals").
    for (const t of PROJECT_NODE_TABS.filter((t) => t.to !== PROJECT_NODE_PATH)) {
      pages.push(pageRow(t.to, t.label, t.to, projectName));
    }

    // ── Projects, live sessions, agents ───────────────────────────────────────────────────────────
    const projectRows: Row[] = projects.map((p) => ({
      key: `project:${p.id}`, kind: "project", label: p.name,
      run: scopeAndGo(p.id, PROJECT_NODE_PATH),
    }));
    const sessionRows: Row[] = (sessionsQ.data ?? []).filter(isLiveSession).map((s) => ({
      key: `session:${s.id}`, kind: "session", label: s.agentName, context: s.projectName,
      tooltip: `${s.agentName}${s.role ? ` · ${s.role}` : ""} · ${s.projectName} · ${s.id.slice(0, 8)}`,
      run: scopeAndGo(s.projectId, `/session/${s.id}`),
    }));
    // An agent opens its own editor on the Agents node.
    const agentRows: Row[] = (agentsQ.data ?? []).filter((a) => knownProject.has(a.projectId)).map((a) => ({
      key: `agent:${a.id}`, kind: "agent", label: a.name, context: a.projectName,
      run: scopeAndGo(a.projectId, `/agents?agent=${encodeURIComponent(a.id)}`),
    }));

    // ── What needs you ─────────────────────────────────────────────────────────────────────────────
    const attentionRows: Row[] = attention.flatMap((a, i) => {
      const target = attentionOpenTarget(a);
      if (!target) return [];
      const merge = a.kind === "MERGE REQUEST";
      // Structural check (any pending/orphaned Request type, OR a self-terminal notice, carries a
      // questionId) — the kind LABEL varies by type (DECISION/SECRET/PERMISSION/INPUT NEEDED/FYI), so
      // it can't be compared literally. This is ROUTING only (does it open the Request modal) — a notice
      // routes here too, since opening it is how a human marks it read.
      const isRequest = a.questionId != null;
      // Card 68f27faf round 3 (CR 7cbb6994, item 1): the LABEL, by contrast, must distinguish an
      // answerable ask from a notice (which needs no answer) — `isAnswerableRequest` is the one place that
      // distinction lives (AttentionRow/App.tsx read the same helper).
      const answerable = isAnswerableRequest(a);
      const verb = merge ? "Review" : answerable ? "Answer" : "Open";
      // A REQUEST opens the shared in-place modal (the provider renders it, so the closing palette can't
      // race the mount); everything else navigates to its route.
      const run = isRequest ? () => openRequest(a.questionId!) : () => navigate(target);
      const label = `${verb} · ${attentionKindLabel(a.kind)} ${a.text}`;
      // Card 104a31a4 — `text` leads with the ask; anything a kind keeps OFF the line (a Request's
      // routing target) is in `hoverText`, so the long label stays reachable on hover here too.
      const tooltip = a.hoverText ? `${verb} · ${attentionKindLabel(a.kind)} ${a.hoverText}` : label;
      const kind = merge ? "review" : isRequest ? "request" : "session";
      return [{ key: `attn:${a.questionId ?? target}:${i}`, kind, label, tooltip, run } satisfies Row];
    });

    return [...pages, ...projectRows, ...sessionRows, ...agentRows, ...attentionRows];
  }, [open, navPages, projects, projectName, knownProject, sessionsQ.data, agentsQ.data, attention,
    navigate, openRequest, setProjectId]);

  const commands = useMemo(() => rankPaletteRows(rows, q), [rows, q]);
  const activeIndex = commands.length === 0 ? -1 : Math.min(active, commands.length - 1);
  const activeRow = activeIndex >= 0 ? commands[activeIndex] : undefined;

  // Keep the highlighted row on screen as the arrows walk past the list's fold.
  useEffect(() => {
    if (!activeRow) return;
    document.getElementById(optionId(activeRow.key))?.scrollIntoView({ block: "nearest" });
  }, [activeRow]);

  if (!open) return null;

  const run = (row: Row) => { row.run(); setOpen(false); setQ(""); };
  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(stepActive(activeIndex, commands.length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) run(activeRow);
    }
  };

  return (
    <div onClick={() => setOpen(false)}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", zIndex: 1000 }}>
      <div role="dialog" aria-modal="true" aria-label="Jump to" data-testid="command-palette" onClick={(e) => e.stopPropagation()}
        style={{ width: 600, maxWidth: "calc(100vw - 24px)", background: color.surface, border: `1px solid ${color.lineStrong}`, borderRadius: radius.sm, overflow: "hidden" }}>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onInputKey}
          role="combobox" aria-expanded="true" aria-controls={LISTBOX_ID} aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(activeRow.key) : undefined}
          aria-label="Jump to a page, project, agent or session"
          placeholder="Jump to a page, project, agent or session…"
          style={{ width: "100%", boxSizing: "border-box", background: color.inset, color: color.text, border: "none", borderBottom: `1px solid ${color.line}`, padding: "12px 14px", fontFamily: font.ui, fontSize: fs.body, outline: "none" }} />
        <div id={LISTBOX_ID} role="listbox" aria-label="Results" style={{ maxHeight: "50vh", overflow: "auto" }}>
          {commands.length === 0 && <div role="presentation" style={{ padding: "12px 14px", color: color.text3, fontSize: fs.sm }}>No matches.</div>}
          {commands.map((c, i) => {
            const selected = i === activeIndex;
            return (
              <div key={c.key} id={optionId(c.key)} role="option" aria-selected={selected}
                data-kind={c.kind} data-label={c.label} data-context={c.context ?? ""}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => { if (!selected) setActive(i); }}
                onClick={() => run(c)}
                style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: `1px solid ${color.line}`,
                  background: selected ? color.selected : "transparent",
                  boxShadow: selected ? `inset 2px 0 0 ${color.accent}` : undefined,
                  color: color.text, padding: "8px 14px", fontFamily: font.ui, fontSize: fs.body, cursor: "pointer" }}>
                <span title={c.tooltip ?? c.label}
                  style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                {c.context && (
                  <span style={{ flex: "0 1 auto", minWidth: 0, color: color.text3, fontSize: fs.sm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.context}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ flex: "none", color: selected ? color.text2 : color.text3, fontFamily: font.mono, fontSize: fs.sm }}>{c.kind}</span>
              </div>
            );
          })}
        </div>
        <div aria-hidden style={{ display: "flex", gap: 16, padding: "6px 14px", borderTop: `1px solid ${color.line}`, color: color.text3, fontFamily: font.mono, fontSize: fs.sm }}>
          <span>↑↓ move</span><span>Enter open</span><span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
