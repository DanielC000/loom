import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { QuestionAttachment } from "@loom/shared";
import { api } from "../lib/api";
import { ATTACHMENT_GLYPH, ATTACHMENT_VIEWER_MAX_BYTES, attachmentDetail, formatAttachmentSize } from "../lib/questions";
import { Button } from "./ui";
import Markdown from "./Markdown";
import { color, font, radius, fs } from "../theme";

// The in-app reader for a Request's markdown/text attachment (card c7f999f4). The owner's ask: Open must
// not download the file, it must show it in a large dialog. The bytes come through the SAME serving route
// by (questionId, attachmentId) as every other kind; nothing here ever names a host path.
//
// The content is UNTRUSTED (an agent wrote it). Markdown renders through the shared renderer, which is
// inert by default (no raw HTML, external images blocked behind click-to-load, `javascript:` links emptied); plain text is a
// React text node inside a <pre>, which can never become markup.

const EMPTY_FILES: string[] = [];
const noop = () => {};

type Load =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "too-large" }
  | { state: "error"; message: string };

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function AttachmentTextViewer({ questionId, a, remote, onClose }: {
  questionId: string; a: QuestionAttachment; remote: boolean; onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const preCapped = a.sizeBytes > ATTACHMENT_VIEWER_MAX_BYTES;
  const [load, setLoad] = useState<Load>(preCapped ? { state: "too-large" } : { state: "loading" });

  useEffect(() => {
    if (preCapped) return;
    const ctl = new AbortController();
    setLoad({ state: "loading" });
    api.questionAttachmentText(questionId, a.id, ATTACHMENT_VIEWER_MAX_BYTES, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setLoad("tooLarge" in r ? { state: "too-large" } : { state: "ready", text: r.text }); })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setLoad({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctl.abort();
  }, [questionId, a.id, preCapped]);

  // Esc closes THIS dialog only. Capture phase on window, so it runs before the Request dialog's own
  // window listener underneath, and stops there (closing both on one keypress would lose the reader's place).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Focus moves in on open (to the scrollable body, so arrow keys and PageDown read immediately) and back to
  // whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    bodyRef.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  // Tab cycles inside the dialog.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panelRef.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const kindWord = a.kind === "markdown" ? "markdown" : "plain text";

  return createPortal(
    <div data-testid="attachment-viewer-backdrop"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.62)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: "3vh 16px", boxSizing: "border-box" }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="attachment-viewer"
        data-viewer-kind={a.kind} onKeyDown={trapTab}
        style={{ width: "min(1180px, 100%)", height: "100%", maxHeight: "94vh", display: "flex", flexDirection: "column",
          background: color.surface, border: `1px solid ${color.lineStrong}`, borderRadius: radius.base,
          boxSizing: "border-box", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px 10px 16px",
          borderBottom: `1px solid ${color.line}`, flexWrap: "wrap" }}>
          <span aria-hidden style={{ fontSize: fs.body, color: color.text2, width: 16, textAlign: "center" }}>{ATTACHMENT_GLYPH[a.kind]}</span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 10 }}>
            <h2 id={titleId} style={{ margin: 0, fontFamily: font.mono, fontSize: fs.body, fontWeight: 600, color: color.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.label}>{a.label}</h2>
            <span style={{ fontSize: fs.sm, color: color.text3, whiteSpace: "nowrap" }}>
              {kindWord} · {attachmentDetail(a)}
            </span>
          </div>
          <DownloadAction questionId={questionId} a={a} remote={remote} />
          <Button onClick={onClose} title="Close (Esc)" aria-label="Close viewer" style={{ padding: "2px 9px" }}>✕</Button>
        </div>
        <div ref={bodyRef} tabIndex={0} data-testid="attachment-viewer-body" aria-label={`${a.label} contents`}
          style={{ flex: 1, minHeight: 0, overflow: "auto", outline: "none", background: color.bg }}>
          {load.state === "loading" && <ViewerNote>Loading {a.label}…</ViewerNote>}
          {load.state === "error" && <ViewerNote tone={color.danger}>Couldn’t load this file: {load.message}</ViewerNote>}
          {load.state === "too-large" && (
            <ViewerNote>
              Too large to preview. The viewer opens files up to {formatAttachmentSize(ATTACHMENT_VIEWER_MAX_BYTES)}
              {preCapped ? `; this one is ${formatAttachmentSize(a.sizeBytes)}` : ""}. Download it to read it.
            </ViewerNote>
          )}
          {load.state === "ready" && a.kind === "markdown" && (
            <div style={{ maxWidth: 860, margin: "0 auto", padding: "20px 28px 40px" }}>
              <Markdown source={load.text} files={EMPTY_FILES} onOpen={noop} />
            </div>
          )}
          {load.state === "ready" && a.kind !== "markdown" && (
            <pre data-testid="attachment-viewer-text" style={{ margin: 0, padding: "16px 20px 32px", fontFamily: font.mono,
              fontSize: fs.mono, lineHeight: 1.6, color: color.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {load.text.length === 0 ? <span style={{ color: color.text3 }}>(empty file)</span> : load.text}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ViewerNote({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <div role="status" style={{ padding: "48px 24px", textAlign: "center", fontSize: fs.sm,
      lineHeight: 1.6, color: tone ?? color.text3 }}>{children}</div>
  );
}

/** The old behaviour, kept one click away. On loopback it is a plain link to the route (which already
 *  answers with `Content-Disposition: attachment`); a remote origin cannot send its credential on a bare
 *  link, so there the bytes are fetched through the api client and saved from an object URL. */
function DownloadAction({ questionId, a, remote }: { questionId: string; a: QuestionAttachment; remote: boolean }) {
  const [busy, setBusy] = useState(false);
  const style = { padding: "2px 10px", fontSize: fs.sm, whiteSpace: "nowrap" as const };
  if (!remote) {
    return (
      <a data-testid="attachment-viewer-download" className="loom-btn loom-btn-default"
        href={api.questionAttachmentUrl(questionId, a.id)} download={a.label} rel="noopener noreferrer"
        style={{ ...style, display: "inline-block", textDecoration: "none", borderRadius: radius.base, fontFamily: font.ui }}>
        Download
      </a>
    );
  }
  return (
    <Button data-testid="attachment-viewer-download" disabled={busy} style={style}
      onClick={() => {
        setBusy(true);
        void api.questionAttachmentBlob(questionId, a.id)
          .then(({ blob }) => {
            const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = a.label;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          })
          .catch(() => { /* the button re-enables; the inbox poll surfaces a gone file as unavailable */ })
          .finally(() => setBusy(false));
      }}>
      {busy ? "Downloading…" : "Download"}
    </Button>
  );
}
