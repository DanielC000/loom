import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "./components/ui";
import { AtlasShell } from "./components/AtlasShell";
import { CommandPalette } from "./components/CommandPalette";
import { SetupWizard } from "./components/SetupWizard";
import { CredentialBanner } from "./components/CredentialBanner";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { GatewayTokenBanner } from "./components/GatewayTokenBanner";
import { NewBuildNotice } from "./components/NewBuildNotice";
import { RequestModalProvider } from "./components/requests";
import { api } from "./lib/api";
import { useAttention, useNewAttention, useMutedBrowserNotifications, attentionKindLabel, attentionOpenTarget, isAnswerableRequest, type AttentionItem } from "./lib/attention";
import { useDismissable } from "./lib/useDismissable";
import { useDockClearance } from "./lib/bottomDock";
import { ActiveProjectProvider } from "./lib/activeProject";
import { color, font, radius, shadow, tone, wash, fs } from "./theme";
import { Dot } from "./components/ui";
import { errorText } from "./lib/loopbackCredential";

// Epic 2c-2 — the "Update available" banner. Unobtrusive slim bar ABOVE the page content, shown ONLY when
// the daemon reports a packaged install that is behind its channel's npm dist-tag (a from-source daemon
// reports packaged:false → this never renders). "Update & restart" POSTs the loopback /internal/update; the
// daemon then stops→installs→starts, so the connection drops mid-flight — we treat the request settling (or
// its expected network error on restart) as "update started" and show a reconnect notice. Human-dismissable
// per target version (a newer release re-shows it), so it never nags after the user defers.
function UpdateBanner() {
  const q = useQuery({ queryKey: ["updateStatus"], queryFn: ({ signal }) => api.updateStatus(signal), refetchInterval: 5 * 60_000, refetchOnWindowFocus: true });
  const [started, setStarted] = useState(false);
  const latest = q.data?.latest ?? "";
  const dismissKey = `loom.updateDismissed.${latest}`;
  const [dismissed, setDismissed] = useState(false);
  // Re-read the per-version dismissal whenever the offered version changes (a new release clears it).
  useEffect(() => { setDismissed(latest ? localStorage.getItem(`loom.updateDismissed.${latest}`) === "1" : false); }, [latest]);

  const mut = useMutation({
    meta: { inlineError: true },
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
      background: wash(color.attn, 8), borderBottom: `1px solid ${color.attn}`, fontFamily: font.mono, fontSize: fs.mono }}>
      <Dot tone="attn" glow />
      {started ? (
        <span style={{ color: color.attnText }}>
          Updating to v{q.data.latest} — the daemon is restarting. This page will reconnect shortly; reload if it doesn’t.
        </span>
      ) : (
        <>
          <span style={{ color: color.text }}>
            A new Loom release is available — <span style={{ color: color.text2 }}>v{q.data.installed}</span>{" "}
            <span aria-hidden>→</span> <span style={{ color: color.attnText }}>v{q.data.latest}</span>{" "}
            <span style={{ color: color.text3 }}>({q.data.channel})</span>
          </span>
          <span style={{ flex: 1 }} />
          {mut.isError && !started && (
            <span title={errorText(mut.error)} style={{ color: color.danger, fontSize: fs.sm }}>update failed — see daemon log</span>
          )}
          <Button variant="primary" disabled={mut.isPending} onClick={() => mut.mutate()}
            style={{ padding: "4px 12px", fontSize: fs.sm }}>
            {mut.isPending ? "Starting…" : "Update & restart"}
          </Button>
          <button onClick={dismiss} title="dismiss until the next release"
            style={{ background: "transparent", border: "none", color: color.text3, cursor: "pointer", fontFamily: font.mono, fontSize: fs.lg, lineHeight: 1, padding: "0 2px" }}>×</button>
        </>
      )}
    </div>
  );
}

// In-app surface of the "new attention item" signal: a bottom-right stack so the human notices attention
// without watching the Workspace node's Needs-you band. Shares useNewAttention with the browser
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

// Routes whose page ALREADY renders the full pending-Request queue, so the count pill there is pure
// duplication — suppress it and let the page be the surface. Exactly TWO nodes render it (nav.tsx ›
// ATLAS_HOMES), each a "Needs you" band plus the `needs you` KPI pop-over off the same `useAttention()`
// and shared `AttentionList`: `/home` over the unfiltered items (pages/WorkspaceHome.tsx), and `/project`
// over items filtered by `attentionItemInProject` (pages/ProjectHome.tsx) — a known trade-off there: the
// pill counts daemon-wide and the band is project-scoped. `/home` also covers the Inbox, which is its
// `?tab=inbox` (the old `/inbox` address redirects there). `/agents` and `/workspace-settings` render no
// queue and keep the pill — listed by hand, never derived from ATLAS_HOMES, since this set tracks what a
// node RENDERS, not that it is a node. The lookup is EXACT on `pathname`, never a prefix, and it covers
// every sub-tab, whose `?tab=` query `pathname` drops.
const REQUEST_PILL_SUPPRESSED_ROUTES = new Set(["/home", "/project"]);

// The toast/pill corner's stacking level — BELOW every overlay in the app, above page content.
// Dialog scrims start at 50 (board card, agent editor, shell picker, maximized terminal) and go up to
// 1600 (the setup wizard); the narrow-width tree drawer is 45 over its 44 scrim; popovers/menus are 60.
// Page content tops out at the composer's 31.
// It used to be 2000, which floated the pill over the open agent editor and its scrim (Atlas audit
// A-01, card 3094c4aa). A stacking floor rather than "detect an open dialog": several overlays carry
// no `role="dialog"` at all (command palette, shell picker, task drawer, maximized terminal), so a
// DOM query would miss exactly those — while a level under 44 is below all of them by construction.
const TOAST_CORNER_Z = 43;

// The pill's own footprint (its height + the 16px offset + a gap), published as a CSS custom property
// so `.loom-atlas-content` can reserve that much bottom padding at narrow widths (global.css). Without
// it the last button on a page — "Submit answer" on /question/:id at 390px — scrolls to rest UNDER the
// pill and can never be reached. Unset whenever the pill is not on screen, so no page pays for it then.
const PILL_RESERVE_VAR = "--loom-request-pill-reserve";
const PILL_OFFSET_PX = 16;
const PILL_GAP_PX = 8;

function ToastContainer() {
  const navigate = useNavigate();
  const location = useLocation();
  const { items } = useAttention();
  const muted = useMutedBrowserNotifications();
  const [toasts, setToasts] = useState<{ id: number; item: AttentionItem }[]>([]);
  const dismiss = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  // Fire the browser Notification for a new attention item here too (the old header Bell owned this;
  // with the header gone the toast surface carries it). Ask once, on mount.
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }, []);

  useNewAttention((item) => {
    // The desktop ping fires for every new item (non-occluding, off-screen), including requests — EXCEPT a
    // category the human muted in Settings → Browser notifications (card 51a80b4d). The mute governs this
    // browser Notification ONLY: the on-screen toast and the request pill below are deliberately
    // unchanged, since the owner asked about browser notifications.
    if (!muted.has(item.notify) && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Loom · ${item.kind}`, { body: item.text });
    }
    // On-screen, a pending REQUEST is carried by the collapsed count pill below — never its own toast.
    if (item.questionId) return;
    const id = nextToastId++;
    setToasts((ts) => [...ts, { id, item }]);
  });

  // The collapsed pending-Request count, level-triggered off the current attention set (NOT the edge-
  // triggered new-item signal), so it always shows the true number waiting — not a burst of arrivals.
  // Card 68f27faf round 2/3: an unread notice carries `questionId` too (it's a Request row) but needs
  // nothing from the owner, so it must never inflate "N requests need you" — its own signal is the
  // desktop Notification (fired in `useNewAttention` above, gated on mute + permission) plus Phase 2's
  // muted sidebar unread badge, never this pill. `isAnswerableRequest` (lib/attention.ts) is the single
  // source of that exclusion — AttentionRow (components/fleet.tsx) reads the SAME helper for its own
  // PENDING-chip/"Answer →" decision, so the two can never drift apart on what counts as answerable.
  const requestCount = items.filter(isAnswerableRequest).length;
  // Dismiss survives client navigation: this container mounts ONCE at the app root (outside <Routes>), so
  // in-memory state persists across route changes. We remember the count that was dismissed so a LATER,
  // larger batch re-surfaces the pill (keep the signal) while dismissing the current batch stays dismissed
  // as the user moves between pages. When the queue empties, reset so the next batch shows.
  const [dismissedAtCount, setDismissedAtCount] = useState(0);
  useEffect(() => {
    if (requestCount < dismissedAtCount) setDismissedAtCount(requestCount);
  }, [requestCount, dismissedAtCount]);
  const showPill = requestCount > dismissedAtCount && !REQUEST_PILL_SUPPRESSED_ROUTES.has(location.pathname);
  // Rise above any bottom-docked control (board bulk bar, a session composer) that sits in the corner —
  // see lib/bottomDock.ts for why this lifts rather than suppressing the pill on those routes.
  const [pillSize, setPillSize] = useState<{ width: number; height: number } | null>(null);
  const bottom = useDockClearance(showPill ? pillSize : null, PILL_OFFSET_PX, PILL_OFFSET_PX, PILL_GAP_PX);

  if (toasts.length === 0 && !showPill) return null;
  return (
    <div data-testid="toast-corner" style={{ position: "fixed", right: PILL_OFFSET_PX, bottom, transition: "bottom 160ms ease", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, zIndex: TOAST_CORNER_Z, maxWidth: 380 }}>
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
        <RequestCountPill count={requestCount} onSize={setPillSize}
          onOpen={() => navigate("/inbox")}
          onDismiss={() => setDismissedAtCount(requestCount)} />
      )}
    </div>
  );
}

// The collapsed pending-Request signal — ONE compact pill ("N requests need you → inbox") in place of the
// former per-request toast stack. Clicking the body jumps to /inbox; the × dismisses it (a larger batch
// re-surfaces it — see dismissedAtCount above). Cyan = the signed "actionable request" tone.
function RequestCountPill({ count, onOpen, onDismiss, onSize }: { count: number; onOpen: () => void; onDismiss: () => void; onSize: (s: { width: number; height: number }) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  // Publish the footprint while mounted (see PILL_RESERVE_VAR); re-measured if the pill reflows.
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    // The reserve is the BASE footprint, never the lifted offset: a lift is caused by a dock, and a
    // reserve that grew with it would push that dock up again and feed back into the lift.
    const publish = () => {
      root.style.setProperty(PILL_RESERVE_VAR, `${el.offsetHeight + PILL_OFFSET_PX + PILL_GAP_PX}px`);
      onSize({ width: el.offsetWidth, height: el.offsetHeight });
    };
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty(PILL_RESERVE_VAR); };
  }, []);
  const c = tone.attn;
  return (
    <div ref={ref} onClick={onOpen} role="button" title="open the Inbox" data-testid="request-count-pill"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: color.surface, border: `1px solid ${color.lineStrong}`, borderLeft: `3px solid ${c}`,
        borderRadius: radius.base, padding: "7px 11px", boxShadow: shadow.pop,
        cursor: "pointer", fontFamily: font.mono, fontSize: fs.mono,
        opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 160ms ease, transform 160ms ease",
      }}>
      <Dot tone="attn" glow />
      <span style={{ color: c, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      <span style={{ color: color.text2 }}>{count === 1 ? "request needs you" : "requests need you"}</span>
      <span aria-hidden style={{ color: color.text3 }}>→ inbox</span>
      <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="dismiss" aria-label="dismiss"
        style={{ background: "transparent", border: "none", color: color.text3, cursor: "pointer", fontFamily: font.mono, fontSize: fs.body, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
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
        background: color.surface, border: `1px solid ${color.lineStrong}`, borderLeft: `3px solid ${c}`,
        borderRadius: radius.base, padding: "10px 12px", boxShadow: shadow.pop,
        cursor: openable ? "pointer" : "default",
        opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 160ms ease, transform 160ms ease",
      }}>
      <Dot tone={item.tone} glow={item.tone === "attn" || item.tone === "danger"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: c }}>{attentionKindLabel(item.kind)}</div>
        <div style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text2, marginTop: 3, wordBreak: "break-word" }}>{item.text}</div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} title="dismiss"
        style={{ background: "transparent", border: "none", color: color.text3, cursor: "pointer", fontFamily: font.mono, fontSize: fs.body, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

// Setup Assistant E1-7 — first-run welcome. On a FRESH install (no ordinary projects) the daemon has
// already auto-launched the setup session; the web additionally presents a one-time welcome that routes
// the user into the live operator terminal (the "Platform" page, route /platform). Gated purely on the ordinary project
// list being EMPTY (api.projects excludes the reserved Getting Started + Platform homes), so it vanishes
// the moment a real project exists — and stays gone. Also human-dismissable (× / "Maybe later"), persisted
// so it doesn't nag on every reload of a still-empty install; the tree's Platform node remains the way in.
const WELCOME_DISMISSED_KEY = "loom.setupWelcomeDismissed";

function FirstRunWelcome() {
  const navigate = useNavigate();
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: ({ signal }) => api.projects(signal) });
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
      background: color.scrim, backdropFilter: "blur(2px)" }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Welcome to Loom"
        style={{ width: 480, maxWidth: "92vw", background: color.surface, border: `1px solid ${color.lineStrong}`,
          borderRadius: radius.base, padding: "26px 26px 22px", boxShadow: shadow.pop,
          borderTop: `3px solid ${color.accentFg}` }}>
        <div style={{ fontFamily: font.ui, fontSize: fs.h1, color: color.text, letterSpacing: "0.01em" }}>Welcome to Loom</div>
        <p style={{ color: color.text2, fontFamily: font.mono, fontSize: fs.body, lineHeight: 1.6, margin: "12px 0 22px" }}>
          Loom weaves real Claude Code sessions, your docs, and tasks into one workspace. Let’s stand up your first
          project — pick a workflow template, point Loom at a repo, and get a ready-to-run team in a few quick steps.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => setWizardOpen(true)} style={{ padding: "6px 14px", fontSize: fs.body }}>Start guided setup →</Button>
          <Button onClick={goSetup} style={{ padding: "6px 14px", fontSize: fs.body }} title="Hand the reins to the Platform agent instead">Open Platform</Button>
          {/*
            @decision 6cefdf25 — do not dim this label with an inline `color`: it shadows the ghost
            variant's own hover rule and leaves the button inert. The `loom-btn-muted` class does it.
          */}
          <Button variant="ghost" className="loom-btn-muted" onClick={dismiss} style={{ padding: "6px 12px", fontSize: fs.body }}>Maybe later</Button>
        </div>
      </div>
    </div>
  );
}

// The cross-cutting chrome, ONE definition each, handed to the shell as two slots (the placement rule:
// docs/plans/atlas-ui/02-architecture.md). The overlays are fixed-position or null and sit at the shell
// root; the banners are in document flow directly above the page content. Nothing here is inside a route
// table.
function ShellOverlays() {
  return (
    <>
      <CommandPalette />
      <FirstRunWelcome />
      <ToastContainer />
    </>
  );
}

function ShellBanners() {
  return (
    <>
      <CredentialBanner />
      <GatewayTokenBanner />
      <RateLimitBanner />
      <UpdateBanner />
      <NewBuildNotice />
    </>
  );
}

// Atlas is the only shell (card acbb6df6 deleted the classic one and the switch between them). A browser
// that still holds the old `loom.atlasUi` preference is unaffected: nothing reads that key any more.
export default function App() {
  return (
    <ActiveProjectProvider>
      <RequestModalProvider>
        <AtlasShell overlays={<ShellOverlays />} banners={<ShellBanners />} />
      </RequestModalProvider>
    </ActiveProjectProvider>
  );
}
