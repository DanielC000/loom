import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalControl } from "@loom/shared";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

/**
 * Live terminal pane. Attaches to /ws/term/:sessionId, fully bidirectional (the user types into the
 * real session/shell). Binary frames = pty bytes; text frames = JSON control.
 *
 * TWO geometry modes:
 *  • Claude sessions (default, resizable=false): geometry is NOT negotiated — the daemon pins the pty
 *    grid (workers often run with no viewer) and sends it once as a `geometry` frame. We honor the pin:
 *    resize the xterm GRID to exactly the pinned cols×rows, then SCALE BY FONT SIZE so it fills the
 *    tile (§12-Q6). We never fit the grid to the tile — that would desync from the pty's redraws and
 *    garble Claude's Ink TUI. No FitAddon.
 *  • Shell terminals (resizable=true): the OPPOSITE — a plain shell has no alt-screen repaint
 *    constraint, so we FIT the grid to the pane (FitAddon) and tell the daemon to resize the pty to
 *    match (a `resize` ws msg). The shell then wraps to the pane like any terminal emulator.
 *
 * `readOnly` (default false): a WATCH-ONLY attach — the pane still streams pty bytes and honors the
 * pinned geometry + attach repaint, but keyboard input is inert (xterm `disableStdin`) and onData never
 * sends a stdin frame. Used by the Companion "Terminal" view, where the companion is driven through its
 * chat surface, not raw stdin — so the terminal is purely an observation window. Copy (select + Ctrl-C)
 * still works; only writing to the session is suppressed.
 */
export function TerminalPane({ sessionId, resizable = false, readOnly = false, heightBudget }: { sessionId: string; resizable?: boolean; readOnly?: boolean; heightBudget?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // Kept in a ref so a budget change is picked up on the next resize WITHOUT re-running the effect
  // (which would tear down + re-attach the websocket). It's constant per page in practice.
  const budgetRef = useRef(heightBudget);
  budgetRef.current = heightBudget;

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const term = new XTerm({
      fontSize: 13,
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      theme: { background: "#0b0b0c" },
    });
    const fit = resizable ? new FitAddon() : null;
    if (fit) term.loadAddon(fit);
    term.open(el);

    // Scroll-hijack gate: a terminal must consume wheel scroll ONLY when it's "clicked in".
    // xterm focus lives on its hidden textarea (focused on click, blurred when you click away), so
    // mirror that onto the viewport's overflow: scroll when focused, hidden otherwise — an unfocused
    // terminal lets the wheel bubble to the page, a focused one scrolls its own scrollback.
    //
    // We gate the viewport's overflow IMPERATIVELY via an inline style rather than a CSS class. A
    // stylesheet rule can't win here: @xterm/xterm's own xterm.css ships
    // `.xterm .xterm-viewport { overflow-y: scroll }` (specificity 0,2,0), which out-specifies any
    // plain `.xterm-viewport` gate we'd write (0,1,0) — so the viewport stayed `scroll` in every
    // state and the hijack was never actually fixed. An inline style beats every stylesheet rule, so
    // the toggle is robust regardless of specificity. xterm can (re)create the viewport on open/
    // resize, so we re-query the CURRENT `.xterm-viewport` each time instead of caching it.
    // Listeners (not xterm's onFocus/onBlur, which @xterm/xterm doesn't expose) attach to the
    // textarea, which exists after term.open().
    const setViewportScroll = (focused: boolean) => {
      const viewport = el.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport) viewport.style.overflowY = focused ? "scroll" : "hidden";
    };
    const onFocus = () => { el.classList.add("term-focused"); setViewportScroll(true); };
    const onBlur = () => { el.classList.remove("term-focused"); setViewportScroll(false); };
    const textarea = term.textarea;
    textarea?.addEventListener("focus", onFocus);
    textarea?.addEventListener("blur", onBlur);
    if (textarea && document.activeElement === textarea) onFocus(); // already focused at mount
    else setViewportScroll(false); // default to hidden (non-scrolling) at mount

    // Clipboard: xterm sends raw control bytes for Ctrl+V/Ctrl+C by default (so Ctrl+V emits 0x16
    // instead of pasting). Wire real clipboard behavior the way Windows Terminal / VS Code do:
    //  • Ctrl/Cmd+V → swallow the raw 0x16 and let xterm's OWN native paste handler do the paste
    //    (exactly once; it honors bracketed-paste mode for Claude's TUI). Returning false skips
    //    xterm's keystroke WITHOUT preventDefault, so the browser still fires its native paste —
    //    we must NOT also paste manually here or it pastes TWICE (the double-paste bug).
    //  • Ctrl/Cmd+C → SMART: copies when there's a selection (and clears it); with nothing
    //    selected it falls through as the SIGINT/interrupt byte. So you get copy AND interrupt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "v") return false; // swallow the raw 0x16; xterm's native paste does the actual paste (once)
      if (mod && key === "c") {
        if (term.hasSelection()) {
          navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
          return false; // copied — don't also send SIGINT
        }
        return true; // nothing selected → pass through as interrupt (\x03)
      }
      return true;
    });

    // The pinned grid, learned from the daemon's `geometry` frame (Claude mode only). Held in closure
    // so both the frame handler and the ResizeObserver can recompute the fontSize against it.
    let cols = 0;
    let rows = 0;
    // Pending one-shot repaint timer (Claude attach), cleared on unmount so it can't fire late.
    let repaintTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Claude mode: scale fontSize so the pinned cols×rows grid just fills the container without
     * overflow. Cell size is linear in fontSize for a monospace font, so we read the renderer's current
     * cell dimensions, derive the per-pixel cell ratio, and solve for the largest fontSize that fits
     * both axes. Single pass is exact; the floor + clamp keep it from overflowing.
     */
    const applyFontSize = () => {
      if (!cols || !rows) return;
      const cw = el.clientWidth;
      // HUG mode (heightBudget set): scale against a FIXED budget rather than the element's own height,
      // then size the element to the rendered grid below. Using the budget (not clientHeight) keeps the
      // fit responsive to width WITHOUT locking onto the shrunk height we're about to apply.
      const budget = budgetRef.current;
      const ch = budget != null ? budget : el.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const curFont = term.options.fontSize ?? 13;
      // Prefer the renderer's measured cell size; fall back to typical monospace ratios if the
      // render service isn't ready yet (e.g. very first frame before a paint).
      const cell = (term as unknown as {
        _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
      })._core?._renderService?.dimensions?.css?.cell;
      const cellWPerPx = cell?.width ? cell.width / curFont : 0.6;
      const cellHPerPx = cell?.height ? cell.height / curFont : 1.2;

      const fitW = cw / (cols * cellWPerPx);
      const fitH = ch / (rows * cellHPerPx);
      // Largest font that fits both axes; 1-decimal floor so we never round up into overflow.
      const next = Math.max(6, Math.floor(Math.min(fitW, fitH) * 10) / 10);
      if (next !== curFont) term.options.fontSize = next;

      // HUG mode: shrink the pane to the grid it actually renders, so a stacked composer sits FLUSH
      // beneath it instead of below a letterbox band (a width-bound 120×40 grid is shorter than the
      // pane). Height is derived from the (now current) font — never exceeds the budget — so the tile
      // hugs the terminal on narrow/width-bound layouts and is a no-op when it already fills height.
      if (budget != null) {
        const gridH = Math.min(budget, Math.ceil(rows * cellHPerPx * (term.options.fontSize ?? next)));
        el.style.height = `${gridH}px`;
      }
    };

    const decoder = new TextDecoder();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/term/${sessionId}`);
    ws.binaryType = "arraybuffer";

    /**
     * Shell mode: fit the grid to the pane, then tell the daemon to resize the pty to match so the
     * shell wraps to the visible width. No-op until the ws is open and the element has a size.
     */
    const fitAndReport = () => {
      if (!fit || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try { fit.fit(); } catch { return; }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => { if (resizable) fitAndReport(); };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        let msg: TerminalControl;
        try { msg = JSON.parse(e.data); } catch { term.write(e.data); return; }
        if (msg.type === "reset") term.reset();
        else if (msg.type === "geometry") {
          if (resizable) {
            // Shell: the daemon's initial grid is just a seed — we drive the size, so fit instead.
            fitAndReport();
          } else {
            // Claude: honor the pinned grid, then scale the font to fill the tile.
            cols = msg.cols;
            rows = msg.rows;
            term.resize(cols, rows);
            applyFontSize();
            // Force a clean repaint on attach: Claude runs main-screen (no alt-screen), so the daemon's
            // bounded ring replay can start mid-stream on a long session — xterm shows an incoherent
            // screen until the session next emits. A Ctrl-L (here via the `repaint` control) makes Claude
            // redraw the full TUI immediately. Sent AFTER the pinned-grid resize lands (a short debounce
            // lets the resize settle and the ring replay finish) so it can't race the grid. Safe to fire
            // anytime: ALT_SCREEN_FULL_REPAINT makes Ctrl-L a full repaint, the same mitigation already
            // used during streaming — so a busy/mid-turn session redraws cleanly rather than garbling.
            clearTimeout(repaintTimer);
            repaintTimer = setTimeout(() => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "repaint" }));
            }, 80);
          }
        }
        // (sessionId/exit/dead control frames handled by parent state in the full UI)
      } else {
        term.write(decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true }));
      }
    };
    const onData = term.onData((d) => {
      if (readOnly) return; // watch-only attach — never write to the session
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "stdin", data: d }));
    });

    // On a tile resize: shells re-fit (and tell the pty); Claude re-scales the font (never the grid).
    const ro = new ResizeObserver(() => { if (resizable) fitAndReport(); else applyFontSize(); });
    ro.observe(el);

    return () => {
      onData.dispose();
      ro.disconnect();
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
      clearTimeout(repaintTimer);
      // Don't act on a socket the pane abandoned mid-handshake. Closing one that's still CONNECTING
      // logs "WebSocket is closed before the connection is established" — it fires on Terminals/Workspace
      // re-render churn (effect cleanup before the open completes). Detach handlers so no late frame
      // writes to the disposed terminal, then close once the socket actually opens (or immediately if
      // it already has).
      ws.onmessage = null;
      ws.onopen = null;
      if (ws.readyState === ws.CONNECTING) ws.onopen = () => ws.close();
      else ws.close();
      term.dispose();
    };
  }, [sessionId, resizable, readOnly]);

  // overflow:hidden so the xterm canvas is clipped to this box — a font rescale (applyFontSize, fired
  // on container resize) can briefly overshoot the cell math; this stops the canvas painting outside.
  // HUG mode seeds the height to the budget so the pane isn't collapsed before the first geometry frame
  // (its parent is content-sized); applyFontSize then trims it to the actual grid height.
  return <div ref={ref} style={{ height: heightBudget != null ? heightBudget : "100%", width: "100%", overflow: "hidden" }} />;
}
