import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalControl } from "@loom/shared";
import "@xterm/xterm/css/xterm.css";

/**
 * Live terminal pane. Attaches to /ws/term/:sessionId, fully bidirectional (the user types
 * into the real session). Binary frames = pty bytes; text frames = JSON control.
 * Geometry is NOT negotiated — the daemon pins the pty; we scale by font size (§12-Q6).
 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      fontSize: 13,
      convertEol: true,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0b0b0c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    const decoder = new TextDecoder();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/term/${sessionId}`);
    ws.binaryType = "arraybuffer";

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        let msg: TerminalControl;
        try { msg = JSON.parse(e.data); } catch { term.write(e.data); return; }
        if (msg.type === "reset") term.reset();
        // (sessionId/exit/dead control frames handled by parent state in the full UI)
      } else {
        term.write(decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true }));
      }
    };
    const onData = term.onData((d) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "stdin", data: d }));
    });

    return () => { onData.dispose(); ws.close(); term.dispose(); };
  }, [sessionId]);

  return <div ref={ref} style={{ height: "100%", width: "100%" }} />;
}
