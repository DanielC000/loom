import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import ReviewPanel from "./pages/ReviewPanel";
import QuestionAnswer from "./pages/QuestionAnswer";
import SessionView from "./pages/SessionView";
import { NAV_PAGES } from "./nav";
import { Button } from "./components/ui";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { SetupWizard } from "./components/SetupWizard";
import { RequestModalProvider } from "./components/requests";
import { api } from "./lib/api";
import { useAttention, useNewAttention, attentionOpenTarget, type AttentionItem } from "./lib/attention";
import { useDismissable } from "./lib/useDismissable";
import { ActiveProjectProvider } from "./lib/activeProject";
import { color, font, radius, tone } from "./theme";
import { Dot } from "./components/ui";
import { page } from "./ui";

// Epic 2c-2 — the "Update available" banner. Unobtrusive slim bar ABOVE the page content, shown ONLY when
// the daemon reports a packaged install that is behind its channel's npm dist-tag (a from-source daemon
// reports packaged:false → this never renders). "Update & restart" POSTs the loopback /internal/update; the
// daemon then stops→installs→starts, so the connection drops mid-flight — we treat the request settling (or
// its expected network error on restart) as "update started" and show a reconnect notice. Human-dismissable
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

// In-app surface of the same "new attention item" signal the rail's Alerts row counts: a bottom-right
// stack so the human notices attention without watching the rail. Shares useNewAttention with the browser
// Notification, so each new item pings once per surface — never twice on one surface.
//
// Two lanes, deliberately different (card 0d27f20c — N requests used to stack N persistent toasts over the
// bottom-right of every page, occluding primary actions and triple-announcing state already in the sidebar
// badge + Mission Control queue + /inbox):
//   • OPERATIONAL alerts (merge request / rate-limit / stuck-busy / idle-escalation) — a transient toast
//     each, auto-dismissing (~6s), edge-triggered off useNewAttention. These are the toast surface's real
//     job (no other always-on surface carries them) and are rarely numerous, so they don't stack up.
//   • Pending REQUESTS (decision/input/permission/credential — anything carrying a questionId) — collapsed
//     into ONE compact count pill, level-triggered off the current count. They're already shown by the
//     sidebar badge, the Mission Control / Overview attention queues, and the /inbox page, so N requests
//     no longer stack N toasts; the pill returns the screen while keeping the signal (+ its deep-link).
const TOAST_TTL_MS = 6000;
let nextToastId = 0;

// Routes whose page ALREADY renders the full pending-Request queue: Mission Control ("/") and the project
// Overview both show the attention queue, and /inbox IS the queue. On those the count pill is pure
// duplication — suppress it there and let the page be the surface. (The sidebar badge is everywhere and is
// only a bare count, so the pill's "→ inbox" affordance still earns its place on every OTHER route.)
const REQUEST_PILL_SUPPRESSED_ROUTES = new Set(["/", "/overview", "/inbox"]);

function ToastContainer() {
  const navigate = useNavigate();
  const location = useLocation();
  const { items } = useAttention();
  const [toasts, setToasts] = useState<{ id: number; item: AttentionItem }[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  // Fire the browser Notification for a new attention item here too (the old header Bell owned this;
  // with the header gone the toast surface carries it). Ask once, on mount.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }, []);

  useNewAttention((item) => {
    // The desktop ping still fires for EVERY new item (non-occluding, off-screen), including requests.
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Loom · ${item.kind}`, { body: item.text });
    }
    // On-screen, a pending REQUEST is carried by the collapsed count pill below — never its own toast.
    if (item.questionId) return;
    const id = nextToastId++;
    setToasts((ts) => [...ts, { id, item }]);
  });

  // The collapsed pending-Request count, level-triggered off the current attention set (NOT the edge-
  // triggered new-item signal), so it always shows the true number waiting — not a burst of arrivals.
  const requestCount = items.filter((it) => it.questionId).length;
  // Dismiss survives client navigation: this container mounts ONCE at the app root (outside <Routes>), so
  // in-memory state persists across route changes. We remember the count that was dismissed so a LATER,
  // larger batch re-surfaces the pill (keep the signal) while dismissing the current batch stays dismissed
  // as the user moves between pages. When the queue empties, reset so the next batch shows.
  const [dismissedAtCount, setDismissedAtCount] = useState(0);
  useEffect(() => {
    if (requestCount < dismissedAtCount) setDismissedAtCount(requestCount);
  }, [requestCount, dismissedAtCount]);
  const showPill = requestCount > dismissedAtCount && !REQUEST_PILL_SUPPRESSED_ROUTES.has(location.pathname);

  if (toasts.length === 0 && !showPill) return null;
  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, zIndex: 2000, maxWidth: 380 }}>
      {toasts.map(({ id, item }) => (
        <Toast key={id} item={item}
          onDismiss={() => dismiss(id)}
          onOpen={() => {
            // Only operational alerts reach this lane: a MERGE REQUEST → review panel; every other openable
            // kind → its session view (requests are the pill, never a toast, so no questionId branch here).
            const target = attentionOpenTarget(item);
            if (target) navigate(target);
            dismiss(id);
          }} />
      ))}
      {showPill && (
        <RequestCountPill count={requestCount}
          onOpen={() => navigate("/inbox")}
          onDismiss={() => setDismissedAtCount(requestCount)} />
      )}
    </div>
  );
}

// The collapsed pending-Request signal — ONE compact pill ("N requests need you → inbox") in place of the
// former per-request toast stack. Clicking the body jumps to /inbox; the × dismisses it (a larger batch
// re-surfaces it — see dismissedAtCount above). Cyan = the signed "actionable request" tone.
function RequestCountPill({ count, onOpen, onDismiss }: { count: number; onOpen: () => void; onDismiss: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const c = tone.cyan;
  return (
    <div onClick={onOpen} role="button" title="open the Requests inbox" data-testid="request-count-pill"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: color.panel, border: `1px solid ${color.borderStrong}`, borderLeft: `3px solid ${c}`,
        borderRadius: radius.base, padding: "7px 11px", boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        cursor: "pointer", fontFamily: font.mono, fontSize: 12,
        opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 160ms ease, transform 160ms ease",
      }}>
      <Dot tone="cyan" glow />
      <span style={{ color: c, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      <span style={{ color: color.textDim }}>{count === 1 ? "request needs you" : "requests need you"}</span>
      <span aria-hidden style={{ color: color.textMuted }}>→ inbox</span>
      <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="dismiss" aria-label="dismiss"
        style={{ background: "transparent", border: "none", color: color.textMuted, cursor: "pointer", fontFamily: font.mono, fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
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
  return (
    <ActiveProjectProvider>
      <RequestModalProvider>
      {/* Shell layout: the fixed Instrument Rail + its 60px flow gutter on the left, the page column on
          the right. The route table below maps EVERY NAV_PAGES route (a companion-gated page stays
          reachable by URL) plus the legacy redirects. */}
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <CommandPalette />
        <FirstRunWelcome />
        <ToastContainer />
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
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
              {/* /schedules + /event-triggers were consolidated into the single /automation page (IA merge #2) —
                  redirect any lingering links/bookmarks to the right tab (/event-triggers → the Events tab). */}
              <Route path="/schedules" element={<Navigate to="/automation" replace />} />
              <Route path="/event-triggers" element={<Navigate to="/automation?tab=events" replace />} />
              {/* /vault + /git were consolidated into the single /repository page (IA merge #3) — redirect any
                  lingering links/bookmarks to the right tab (/git → the Git tab via ?tab=git). */}
              <Route path="/vault" element={<Navigate to="/repository" replace />} />
              <Route path="/git" element={<Navigate to="/repository?tab=git" replace />} />
              <Route path="/review/:workerId" element={<ReviewPanel />} />
              <Route path="/question/:id" element={<QuestionAnswer />} />
              <Route path="/session/:id" element={<SessionView />} />
            </Routes>
          </main>
        </div>
      </div>
      </RequestModalProvider>
    </ActiveProjectProvider>
  );
}
