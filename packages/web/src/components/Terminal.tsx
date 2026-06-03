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
 */
export function TerminalPane({ sessionId, resizable = false }: { sessionId: string; resizable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const term = new XTerm({
      fontSize: 13,
      convertEol: true,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0b0b0c" },
    });
    const fit = resizable ? new FitAddon() : null;
    if (fit) term.loadAddon(fit);
    term.open(el);

    // Clipboard: xterm sends raw control bytes for Ctrl+V/Ctrl+C by default (so Ctrl+V emits 0x16
    // instead of pasting). Wire real clipboard behavior the way Windows Terminal / VS Code do:
    //  • Ctrl/Cmd+V → paste (term.paste handles bracketed-paste mode for Claude's TUI)
    //  • Ctrl/Cmd+C → SMART: copies when there's a selection (and clears it); with nothing
    //    selected it falls through as the SIGINT/interrupt byte. So you get copy AND interrupt.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "v") {
        navigator.clipboard?.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
        return false; // swallow so the raw 0x16 isn't sent to the pty
      }
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

    /**
     * Claude mode: scale fontSize so the pinned cols×rows grid just fills the container without
     * overflow. Cell size is linear in fontSize for a monospace font, so we read the renderer's current
     * cell dimensions, derive the per-pixel cell ratio, and solve for the largest fontSize that fits
     * both axes. Single pass is exact; the floor + clamp keep it from overflowing.
     */
    const applyFontSize = () => {
      if (!cols || !rows) return;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
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
          }
        }
        // (sessionId/exit/dead control frames handled by parent state in the full UI)
      } else {
        term.write(decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true }));
      }
    };
    const onData = term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "stdin", data: d }));
    });

    // On a tile resize: shells re-fit (and tell the pty); Claude re-scales the font (never the grid).
    const ro = new ResizeObserver(() => { if (resizable) fitAndReport(); else applyFontSize(); });
    ro.observe(el);

    return () => {
      onData.dispose();
      ro.disconnect();
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
  }, [sessionId, resizable]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}
