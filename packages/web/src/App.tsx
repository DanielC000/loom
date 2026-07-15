import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReviewPanel from "./pages/ReviewPanel";
import QuestionAnswer from "./pages/QuestionAnswer";
import SessionView from "./pages/SessionView";
import { NAV_PAGES, useVisibleNavPages, type NavGroup } from "./nav";
import { NavTab, Badge, Button } from "./components/ui";
import { Logo } from "./components/Logo";
import { CommandPalette } from "./components/CommandPalette";
import { SetupWizard } from "./components/SetupWizard";
import { RequestModalProvider, useOpenRequest } from "./components/requests";
import { api } from "./lib/api";
import { useAttention, useNewAttention, attentionOpenTarget, type AttentionItem } from "./lib/attention";
import { useDismissable } from "./lib/useDismissable";
import { ActiveProjectProvider, useActiveProject } from "./lib/activeProject";
import { color, font, radius, tone } from "./theme";
import { Dot } from "./components/ui";
import { page } from "./ui";

// Live global orchestration status (RUNNING / PAUSED), polled into the top bar.
function GlobalStatus() {
  const status = useQuery({ queryKey: ["orchStatus"], queryFn: api.orchestrationStatus, refetchInterval: 4000 });
  if (!status.data) return null;
  const globalPaused = status.data.pausedScopes.includes("global");
  return <Badge tone={globalPaused ? "red" : "phosphor"}>{globalPaused ? "paused" : "running"}</Badge>;
}

// Shell alert bell: count of attention-queue items + a browser Notification when a NEW one appears
// (seeded silently on first load so a reload doesn't replay the backlog). Click → Mission Control.
// The new-item detection lives in useNewAttention so the bell and the in-app toast stack share it.
function Bell() {
  const { count } = useAttention();
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }, []);
  useNewAttention((it) => {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Loom · ${it.kind}`, { body: it.text });
    }
  });

  return (
    <button onClick={() => navigate("/")} title="attention queue"
      style={{ fontFamily: font.mono, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase",
        color: count ? color.amber : color.textDim, border: `1px solid ${count ? color.amber : color.borderStrong}`,
        background: "transparent", borderRadius: 4, padding: "4px 10px", cursor: "pointer" }}>
      Alerts {count}
    </button>
  );
}

// Header active-project selector. Persists the one project that scopes the detail pages
// (the nav items marked with a scope dot — Overview / Board / Runs / Vault / Git / Schedules /
// Settings). Mission Control, Terminals and the other god-eye pages ignore it
// — hence the quiet tooltip rather than hiding the control per route. Lives on the LEFT, right
// after the logo, so the active scope reads before the destinations it scopes.
//
// A custom dropdown (not a native <select>) so it can MARK projects that currently have a live
// session with the design system's live Dot — projects with ≥1 live session sort to the TOP and
// carry a small phosphor dot + count; the rest follow below a hairline. Mirrors the MoreMenu
// dropdown pattern in this file (useDismissable, Panel/borderStrong/token styling, zIndex).
function ActiveProjectControl() {
  const { projectId, setProjectId, projects } = useActiveProject();
  const [open, setOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  // Reuse the fleet's shared session cache (Overview polls the same key) to know which projects have
  // a live session right now — no new API surface. Exclude companions (assistant): a lone companion
  // must never mark a project "active" (mirrors the Terminals dropdown/count exclusion, lib/sessions.ts).
  const sessionsQ = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const liveByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessionsQ.data ?? []) {
      if (s.role === "assistant") continue;
      if (s.processState !== "live" && s.processState !== "starting") continue;
      m.set(s.projectId, (m.get(s.projectId) ?? 0) + 1);
    }
    return m;
  }, [sessionsQ.data]);

  // Stable partition: projects with ≥1 live session first, the rest below. Each group keeps the
  // provider's incoming order (no activity-keyed re-sort), so the list never reshuffles on a poll.
  const { live: liveProjects, idle: idleProjects } = useMemo(() => {
    const live = projects.filter((p) => (liveByProject.get(p.id) ?? 0) > 0);
    const idle = projects.filter((p) => (liveByProject.get(p.id) ?? 0) === 0);
    return { live, idle };
  }, [projects, liveByProject]);

  const hasOptions = projects.length > 0;
  const current = projects.find((p) => p.id === projectId);
  const currentLive = current ? (liveByProject.get(current.id) ?? 0) : 0;

  const renderItem = (p: (typeof projects)[number]) => {
    const count = liveByProject.get(p.id) ?? 0;
    const selected = p.id === projectId;
    return (
      <button key={p.id} role="option" aria-selected={selected}
        onClick={() => { setProjectId(p.id); setOpen(false); }}
        onMouseEnter={() => setHoveredId(p.id)} onMouseLeave={() => setHoveredId((h) => (h === p.id ? null : h))}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
          background: hoveredId === p.id ? color.panel2 : "transparent", border: "none", cursor: "pointer",
          color: selected ? color.phosphor : color.text, fontFamily: font.mono, fontSize: 13, padding: "6px 12px" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
        {count > 0 && (
          <span title={`${count} live session${count === 1 ? "" : "s"}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none", color: color.textDim, fontSize: 11 }}>
            {count}
            <Dot tone="phosphor" glow />
          </span>
        )}
      </button>
    );
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
      <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
        <button onClick={() => hasOptions && setOpen((o) => !o)} disabled={!hasOptions}
          aria-haspopup="listbox" aria-expanded={open}
          title="Scopes the project-scoped pages (marked with a dot). God-eye pages ignore this. A live-session dot marks projects with running work."
          style={{ display: "inline-flex", alignItems: "center", gap: 7, maxWidth: 240,
            background: color.panel2, color: hasOptions ? color.text : color.textMuted,
            border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "4px 8px",
            fontFamily: font.mono, fontSize: 13, cursor: hasOptions ? "pointer" : "default" }}>
          {currentLive > 0 && <Dot tone="phosphor" glow />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {hasOptions ? (current?.name ?? "Select project") : "— none —"}
          </span>
          <span aria-hidden style={{ color: color.textMuted, fontSize: 11 }}>▾</span>
        </button>
        {open && hasOptions && (
          <div role="listbox" style={{ position: "absolute", top: "100%", left: 0, marginTop: 6, zIndex: 30, minWidth: 220, maxWidth: 320,
            background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, overflow: "hidden",
            display: "flex", flexDirection: "column", padding: "4px 0", boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
            {liveProjects.map(renderItem)}
            {liveProjects.length > 0 && idleProjects.length > 0 && (
              <div aria-hidden style={{ height: 1, background: color.border, margin: "4px 0" }} />
            )}
            {idleProjects.map(renderItem)}
          </div>
        )}
      </div>
    </span>
  );
}

// The running daemon's Loom version (Releases v1 Part 3), fetched from GET /api/version and shown as a
// quiet `v0.1.0` chip at the far right of the header. Unobtrusive: dim, monospace, never shifts layout —
// renders nothing until the version resolves, so a slow/absent endpoint just leaves the spot empty.
function VersionTag() {
  const v = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: Infinity, refetchOnWindowFocus: false });
  if (!v.data?.version) return null;
  return (
    <span title="Loom version" style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: "0.04em", color: color.textMuted }}>
      v{v.data.version}
    </span>
  );
}

// Epic 2c-2 — the "Update available" banner. Unobtrusive slim bar UNDER the header, shown ONLY when the
// daemon reports a packaged install that is behind its channel's npm dist-tag (a from-source daemon reports
// packaged:false → this never renders). "Update & restart" POSTs the loopback /internal/update; the daemon
// then stops→installs→starts, so the connection drops mid-flight — we treat the request settling (or its
// expected network error on restart) as "update started" and show a reconnect notice. Human-dismissable
// per target version (a newer release re-shows it), so it never nags after the user defers.
function UpdateBanner() {
  const q = useQuery({ queryKey: ["updateStatus"], queryFn: api.updateStatus, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true });
  const [started, setStarted] = useState(false);
  const latest = q.data?.latest ?? "";
  const dismissKey = `loom.updateDismissed.${latest}`;
  const [dismissed, setDismissed] = useState(false);
  // Re-read the per-version dismissal whenever the offered version changes (a new release clears it).
  useEffect(() => { setDismissed(latest ? localStorage.getItem(`loom.updateDismissed.${latest}`) === "1" : false); }, [latest]);

  const mut = useMutation({
    mutationFn: api.triggerUpdate,
    // A 202 ack (the daemon defers the spawn 50ms, so the response flushes first) means the update is
    // underway → show the reconnect notice. A genuine failure (e.g. 409 on a source daemon, or a 5xx)
    // rejects → leave the banner up and surface the error rather than a false "restarting" message.
    onSuccess: () => setStarted(true),
  });

  if (!q.data?.packaged || !q.data.updateAvailable || dismissed) return null;
  const dismiss = () => { localStorage.setItem(dismissKey, "1"); setDismissed(true); };

  return (
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 20px",
      background: "rgba(232,168,68,0.08)", borderBottom: `1px solid ${color.amber}`, fontFamily: font.mono, fontSize: 12.5 }}>
      <Dot tone="amber" glow />
      {started ? (
        <span style={{ color: color.amber }}>
          Updating to v{q.data.latest} — the daemon is restarting. This page will reconnect shortly; reload if it doesn’t.
        </span>
      ) : (
        <>
          <span style={{ color: color.text }}>
            A new Loom release is available — <span style={{ color: color.textDim }}>v{q.data.installed}</span>{" "}
            <span aria-hidden>→</span> <span style={{ color: color.amber }}>v{q.data.latest}</span>{" "}
            <span style={{ color: color.textMuted }}>({q.data.channel})</span>
          </span>
          <span style={{ flex: 1 }} />
          {mut.isError && !started && (
            <span title={(mut.error as Error)?.message} style={{ color: color.red, fontSize: 11 }}>update failed — see daemon log</span>
          )}
          <Button variant="primary" disabled={mut.isPending} onClick={() => mut.mutate()}
            style={{ padding: "4px 12px", fontSize: 12 }}>
            {mut.isPending ? "Starting…" : "Update & restart"}
          </Button>
          <button onClick={dismiss} title="dismiss until the next release"
            style={{ background: "transparent", border: "none", color: color.textMuted, cursor: "pointer", fontFamily: font.mono, fontSize: 15, lineHeight: 1, padding: "0 2px" }}>×</button>
        </>
      )}
    </div>
  );
}

// A subtle marker on nav items that respond to the active-project picker (see ActiveProjectControl).
function ScopeDot() {
  return (
    <span title="scoped to the active project"
      style={{ width: 4, height: 4, borderRadius: 4, background: color.cyan, opacity: 0.85, display: "inline-block", marginLeft: 5, flex: "none", verticalAlign: "middle" }} />
  );
}

// Thin vertical hairline used to separate the header's left-cluster groups.
function HeaderDivider() {
  return <span aria-hidden style={{ width: 1, height: 20, background: color.border, flex: "none" }} />;
}

// The "More ▾" overflow menu: the non-primary nav pages, grouped by section. Mirrors the
// SpawnControls dropdown pattern (position:relative wrapper, useDismissable click-outside/Escape
// close, Panel/borderStrong/token styling, zIndex). The button shows the active (phosphor) state
// when the current route is one of its items, so a nested page still reads as "selected" from the
// collapsed header.
const MORE_GROUPS: { key: NavGroup; label: string }[] = [
  { key: "operate", label: "Operate" },
  { key: "project", label: "Project" },
  { key: "config", label: "Config" },
  { key: "system", label: "System" },
];

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const items = useVisibleNavPages().filter((p) => !p.primary);
  const isActive = items.some((p) => p.to === location.pathname);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={() => setOpen((o) => !o)} className={`loom-navtab${isActive ? " is-active" : ""}`}
        style={{ background: "transparent", border: "none", borderBottom: `2px solid ${isActive ? color.phosphor : "transparent"}`, cursor: "pointer" }}>
        More ▾
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 6, zIndex: 30, minWidth: 200,
          background: color.panel, border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, overflow: "hidden",
          display: "flex", flexDirection: "column", padding: "4px 0", boxShadow: "0 6px 20px rgba(0,0,0,0.45)" }}>
          {MORE_GROUPS.map((g) => {
            const groupItems = items.filter((p) => p.group === g.key);
            if (groupItems.length === 0) return null;
            return (
              <div key={g.key}>
                <div style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, padding: "6px 12px 2px" }}>{g.label}</div>
                {groupItems.map((p) => {
                  const active = location.pathname === p.to;
                  return (
                    <button key={p.to} className="loom-btn loom-btn-ghost"
                      onClick={() => { setOpen(false); navigate(p.to); }}
                      style={{ display: "inline-flex", alignItems: "center", textAlign: "left", background: "transparent", border: "none",
                        color: active ? color.phosphor : color.text, fontFamily: font.mono, fontSize: 12, padding: "6px 12px", cursor: "pointer" }}>
                      {p.label}{p.scoped && <ScopeDot />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// In-app surface of the same "new attention item" signal the bell uses: a transient toast stack so
// the human notices a merge-request / rate-limit / stuck-busy / idle-escalation without watching the
// bell. Shares useNewAttention with the bell, so each new item pings once per surface — never twice
// on one surface. Each toast auto-dismisses (~6s), has a manual ×, and clicks through to the item.
const TOAST_TTL_MS = 6000;
let nextToastId = 0;

function ToastContainer() {
  const navigate = useNavigate();
  const openRequest = useOpenRequest();
  const [toasts, setToasts] = useState<{ id: number; item: AttentionItem }[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  useNewAttention((item) => {
    const id = nextToastId++;
    setToasts((ts) => [...ts, { id, item }]);
  });

  if (toasts.length === 0) return null;
  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 2000, maxWidth: 380 }}>
      {toasts.map(({ id, item }) => (
        <Toast key={id} item={item}
          onDismiss={() => dismiss(id)}
          onOpen={() => {
            // A pending REQUEST (any type — it carries a questionId) opens the shared in-place modal;
            // a MERGE REQUEST → review panel; every other openable kind → its session view.
            if (item.questionId) openRequest(item.questionId);
            else { const target = attentionOpenTarget(item); if (target) navigate(target); }
            dismiss(id);
          }} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss, onOpen }: { item: AttentionItem; onDismiss: () => void; onOpen: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true)); // mount → slide/fade in
    const ttl = setTimeout(onDismiss, TOAST_TTL_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(ttl); };
  }, []); // run once: a re-rendered onDismiss closure must not reset the timer
  const c = tone[item.tone];
  const openable = attentionOpenTarget(item) !== null;
  return (
    <div onClick={openable ? onOpen : undefined} title={openable ? "open" : undefined}
      style={{
        display: "flex", alignItems: "flex-start", gap: 10, width: 360,
        background: color.panel, border: `1px solid ${color.borderStrong}`, borderLeft: `3px solid ${c}`,
        borderRadius: radius.base, padding: "10px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        cursor: openable ? "pointer" : "default",
        opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 160ms ease, transform 160ms ease",
      }}>
      <Dot tone={item.tone} glow={item.tone === "amber" || item.tone === "red"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: font.mono, fontSize: 11, color: c, textTransform: "uppercase", letterSpacing: "0.06em" }}>{item.kind}</div>
        <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, marginTop: 3, wordBreak: "break-word" }}>{item.text}</div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="dismiss"
        style={{ background: "transparent", border: "none", color: color.textMuted, cursor: "pointer", fontFamily: font.mono, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

// Setup Assistant E1-7 — first-run welcome. On a FRESH install (no ordinary projects) the daemon has
// already auto-launched the setup session; the web additionally presents a one-time welcome that routes
// the user into the live operator terminal (the "Platform" page, route /platform). Gated purely on the ordinary project
// list being EMPTY (api.projects excludes the reserved Getting Started + Platform homes), so it vanishes
// the moment a real project exists — and stays gone. Also human-dismissable (× / "Maybe later"), persisted
// so it doesn't nag on every reload of a still-empty install; the "Platform" nav entry remains the way in.
const WELCOME_DISMISSED_KEY = "loom.setupWelcomeDismissed";

function FirstRunWelcome() {
  const navigate = useNavigate();
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [dismissed, setDismissed] = useState<boolean>(() => localStorage.getItem(WELCOME_DISMISSED_KEY) === "1");
  // Entry B — the first-run welcome opens the guided-setup WIZARD directly (the fast path to a
  // ready-to-run workspace), a peer of "Open Platform" (hand the operator agent the reins instead).
  const [wizardOpen, setWizardOpen] = useState(false);
  const dismiss = () => { localStorage.setItem(WELCOME_DISMISSED_KEY, "1"); setDismissed(true); };
  const ref = useDismissable<HTMLDivElement>(!dismissed && !wizardOpen, dismiss);

  // While the wizard is open it fully takes over the viewport (its own overlay), so render ONLY it — this
  // also keeps a single Escape handler in play (the welcome's dismiss-on-Escape stays disarmed above).
  if (wizardOpen) return <SetupWizard open onClose={() => setWizardOpen(false)} />;

  // Only once projects have actually loaded + resolved EMPTY (no flash on a populated install). The
  // context's `projects` is already archived-filtered + reserved-excluded — read it via the same cache.
  const ordinary = (projectsQ.data ?? []).filter((p) => !p.archivedAt);
  if (!projectsQ.isSuccess || ordinary.length > 0 || dismissed) return null;

  const goSetup = () => { navigate("/platform"); dismiss(); };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1500, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Welcome to Loom"
        style={{ width: 480, maxWidth: "92vw", background: color.panel, border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.base, padding: "26px 26px 22px", boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
          borderTop: `3px solid ${color.phosphor}` }}>
        <div style={{ fontFamily: font.head, fontSize: 20, color: color.text, letterSpacing: "0.01em" }}>Welcome to Loom</div>
        <p style={{ color: color.textDim, fontFamily: font.mono, fontSize: 13, lineHeight: 1.6, margin: "12px 0 22px" }}>
          Loom weaves real Claude Code sessions, your docs, and tasks into one workspace. Let’s stand up your first
          project — pick a workflow template, point Loom at a repo, and get a ready-to-run team in a few quick steps.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => setWizardOpen(true)} style={{ padding: "6px 14px", fontSize: 13 }}>Start guided setup →</Button>
          <Button onClick={goSetup} style={{ padding: "6px 14px", fontSize: 13 }} title="Hand the reins to the Platform operator instead">Open Platform</Button>
          <Button variant="ghost" onClick={dismiss} style={{ padding: "6px 12px", fontSize: 13, color: color.textMuted }}>Maybe later</Button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // Gated nav: the dev "Loom Platform" tab only renders once its home resolves (see useVisibleNavPages).
  // The route table below still maps EVERY NAV_PAGES route, so a gated page stays reachable by URL.
  const visiblePages = useVisibleNavPages();
  return (
    <ActiveProjectProvider>
      <RequestModalProvider>
      <div style={{ minHeight: "100vh" }}>
        <CommandPalette />
        <FirstRunWelcome />
        <ToastContainer />
        <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 20px", borderBottom: `1px solid ${color.border}` }}>
          <Logo />
          <HeaderDivider />
          <ActiveProjectControl />
          <HeaderDivider />
          <nav style={{ display: "flex", gap: 18, alignItems: "center" }}>
            {visiblePages.filter((p) => p.primary).map((p) => (
              <NavTab key={p.to} to={p.to} end={p.end}>
                {p.nav ?? p.label}{p.scoped && <ScopeDot />}
              </NavTab>
            ))}
            <MoreMenu />
          </nav>
          <span style={{ flex: 1 }} />
          <Bell />
          <GlobalStatus />
          <VersionTag />
        </header>
        <UpdateBanner />
        <main style={page}>
          <Routes>
            {NAV_PAGES.map((p) => (
              <Route key={p.to} path={p.to} element={p.element} />
            ))}
            {/* /setup was the old end-user Platform route — now consolidated into /platform. Redirect any
                lingering links/bookmarks (and the first-run welcome's historical target). */}
            <Route path="/setup" element={<Navigate to="/platform" replace />} />
            {/* /workspace was renamed + repositioned to /projects (card 274f9ba9) — redirect lingering links. */}
            <Route path="/workspace" element={<Navigate to="/projects" replace />} />
            {/* /profiles + /skills were consolidated into the single /actors page (IA merge #1) — redirect any
                lingering links/bookmarks to the right tab (/skills → the Skills tab via ?tab=skills). */}
            <Route path="/profiles" element={<Navigate to="/actors" replace />} />
            <Route path="/skills" element={<Navigate to="/actors?tab=skills" replace />} />
            <Route path="/review/:workerId" element={<ReviewPanel />} />
            <Route path="/question/:id" element={<QuestionAnswer />} />
            <Route path="/session/:id" element={<SessionView />} />
          </Routes>
        </main>
      </div>
      </RequestModalProvider>
    </ActiveProjectProvider>
  );
}
