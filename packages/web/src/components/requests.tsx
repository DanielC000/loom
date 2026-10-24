import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuestionAttachment, QuestionInboxItem, QuestionType, PermissionScope } from "@loom/shared";
import { PERMISSION_SCOPES } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { isRemoteOrigin } from "../lib/gatewayCredential";
import { usePreviewOnly } from "../lib/previewOnly";
import { viewBlobType } from "../lib/vaultAsset";
import { Panel, Button, Dot, SectionLabel, Badge, Select } from "./ui";
import { DecisionStateChip } from "./decisions";
import { color, font, radius, tone, type Tone } from "../theme";
import {
  isDecisionWatchdog, isUnread, relativeAge,
  REQUEST_TYPE_TONE, REQUEST_TYPE_ORDER,
  requestActionLabel, requestNeedsChip, requestAnswerBadge, requestHint, requestOutcome,
  requestProvenanceText,
  ATTACHMENT_CHIP_GLYPH, ATTACHMENT_GLYPH, attachmentCountChip, attachmentDetail, attachmentOpenRefusal,
  attachmentPreviewMode, attachmentStateChip,
} from "../lib/questions";
import {
  EMPTY_REQUEST_DRAFT, clearRequestDraft, getRequestDraft, isRequestDraftDirty, setRequestDraft,
} from "../lib/requestDrafts";

// The REQUESTS INBOX (card 695ebab0 — the durable Requests object generalized from the decision inbox).
// A manager/orchestrator asks the human NON-BLOCKING for one of four kinds of Request — decision · input ·
// permission · credential — each answered asynchronously here. Direction A "signal rows": one durable
// record per row, its left edge signed by the type's color. Native to the terminal-cockpit kit — reuses
// Panel/Button/Dot/Badge/Select + the `theme` tokens; the four type colors map onto the EXISTING signal
// palette (decision=cyan · input=phosphor · permission=red · credential=amber), no new color system.

// ── RequestTypeTag ──────────────────────────────────────────────────────────────
// A bordered pill in the type's signal tone (Badge uppercases the label). One place a type reads as a tag.
export function RequestTypeTag({ type }: { type: QuestionType }) {
  return <Badge tone={REQUEST_TYPE_TONE[type]}>{type}</Badge>;
}

// ── RequestNeedsChip ──────────────────────────────────────────────────────────────
// A pending row's short "what's needed" chip ("needs pick"/"needs answer"/"needs auth"/"needs secret"),
// tinted by the type tone. Distinct from the lifecycle DecisionStateChip (which drives answered/consumed).
function RequestNeedsChip({ type }: { type: QuestionType }) {
  const c = tone[REQUEST_TYPE_TONE[type]];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono, fontSize: 11,
      textTransform: "uppercase", letterSpacing: "0.06em", color: c, border: `1px solid ${c}`, borderRadius: radius.sm, padding: "1px 8px" }}>
      <Dot tone={REQUEST_TYPE_TONE[type]} />
      {requestNeedsChip(type)}
    </span>
  );
}

// ── RequestProvenance — the immutable FILER and the current ROUTING TARGET, side by side ──────────
//
// @decision 5b22b262 — sessionId is the mutable routing target, never provenance; show BOTH the
// immutable filer and the current routing target, visibly distinguished.
//
// A legacy row whose `filedBySessionId` is permanently null reads
// "filer unknown"; it must NEVER fall back to `sessionId`, which is precisely the bug.
// Distinction is carried by the label words (inherited muted meta color) with the ids a shade brighter —
// no new color system, no new component; it drops into the existing meta line as one inline run. ONE
// component so the four surfaces that render this can't drift apart.
// TWO densities, same two facts — never a different SET of facts, only a shorter spelling of them:
//   default  "filed by 3f2a · now routed to 9b1c"  — the roomy, wrapping meta lines (inbox row, modal header)
//   compact  "3f2a → 9b1c"                          — a single ellipsized cell (history table, board rail)
// The compact form drops the WORDS, never an id: an ellipsis that ate the routing id would silently
// re-create the one-id rendering this card removes, so density is bought with the arrow, not with a field.
// Both spell the full owner-form text into `title` + `aria-label`, so the words are always one hover away
// and the arrow is never the only carrier of meaning for assistive tech.
export function RequestProvenance({ q, compact }: { q: Pick<QuestionInboxItem, "sessionId" | "filedBySessionId">; compact?: boolean }) {
  const full = requestProvenanceText(q);
  const routed = <span style={{ color: color.textDim }}>{q.sessionId.slice(0, 8)}</span>;
  return (
    <span title={full} aria-label={full} style={{ minWidth: 0 }}>
      {compact
        ? <>
            {q.filedBySessionId
              ? <span style={{ color: color.textDim }}>{q.filedBySessionId.slice(0, 8)}</span>
              : <>unknown</>}
            <span aria-hidden> → </span>
            {routed}
          </>
        : <>
            {q.filedBySessionId
              ? <>filed by <span style={{ color: color.textDim }}>{q.filedBySessionId.slice(0, 8)}</span></>
              : <>filer unknown</>}
            {" · now routed to "}
            {routed}
          </>}
    </span>
  );
}

// ── Nudge mgr (watchdog action) ─────────────────────────────────────────────────
// Re-poke a manager sitting on an answered-but-unpulled request. Reuses the EXISTING human-only turn
// injector (POST /input) — NOT a new answer path. Disabled when the asking session isn't live.
function NudgeMgrButton({ q }: { q: QuestionInboxItem }) {
  const [done, setDone] = useState(false);
  const nudge = useMutation({
    mutationFn: () => api.sendInput(q.sessionId, `[loom] Reminder: your request "${q.title}" was answered — pull it (question_pull) at that decision point.`),
    onSuccess: () => { setDone(true); window.setTimeout(() => setDone(false), 4000); },
  });
  return (
    <Button variant="default" disabled={!q.sessionLive || nudge.isPending}
      title={q.sessionLive ? "Re-nudge the manager to pull this answered request" : "The asking session isn't live — nothing to nudge"}
      onClick={() => nudge.mutate()}>
      {done ? "✓ nudged" : nudge.isPending ? "Nudging…" : "Nudge mgr"}
    </Button>
  );
}

// ── Dismiss (question_cancel + dismiss — the human-side exit for a moot/superseded PENDING request) ────
// A CONFIRMED action (window.confirm, mirroring Archive.tsx's Delete) — NOT a bare mirror of
// PresetPrompts.tsx's unconfirmed preset-suggestion Dismiss: a preset suggestion is advisory, but a
// Request is a LIVE agent blocked on this exact answer, and nothing reverts cancelled→pending (there is
// no re-ask path — only an agent asks). One misclick on an unconfirmed button would permanently and
// silently destroy that agent's ask, so match the STAKES (Archive's irreversible-delete precedent), not
// just PresetPrompts' shape. A quiet inline alert on failure (a 409 means the row raced to answered/
// cancelled elsewhere — invalidating still refetches it into its now-current state either way). Only ever
// rendered for a pending row.
function DismissButton({ q }: { q: QuestionInboxItem }) {
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissQuestion(q.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["openQuestions"] }),
  });
  return (
    <Button variant="ghost" disabled={dismiss.isPending}
      title="Dismiss — moot or superseded; retained in history, never answered"
      onClick={() => {
        if (window.confirm(`Dismiss "${q.title}"? It will never be answered — this cannot be undone.`)) dismiss.mutate();
      }}>
      {dismiss.isPending ? "Dismissing…" : "Dismiss"}
    </Button>
  );
}

// A soft-linked task chip: "task #xxxx [· lane] [· title]" (the request's `taskId`, a NON-FK soft link —
// a dangling id is tolerated, never a crash). `columnKey` (card 889ae619, iii-b) is the linked card's
// CURRENT lane — its raw board-column slug (e.g. "in_progress"/"done"), shown so a human deciding whether
// a pending Request is still relevant can see at a glance whether its card already moved on, without a
// second fetch. Omitted (undefined) when the caller has no lane to show — the chip degrades to today's
// bare "task #xxxx" form. `onClick` (when set) navigates to the card; otherwise it's inert metadata.
function LinkedTaskChip({ taskId, title, columnKey, onClick }: { taskId: string; title?: string | null; columnKey?: string | null; onClick?: () => void }) {
  const label = `task #${taskId.slice(0, 8)}${columnKey ? ` · ${columnKey}` : ""}${title ? ` · ${title}` : ""}`;
  const style = { fontFamily: font.mono, fontSize: 11, color: color.cyan, border: `1px solid ${color.border}`,
    borderRadius: radius.sm, padding: "1px 6px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const };
  if (!onClick) return <span title={label} style={style}>{label}</span>;
  return (
    <button onClick={onClick} title={`Open ${label}`}
      style={{ ...style, background: "transparent", cursor: "pointer", textAlign: "left" }}>{label}</button>
  );
}

// ── Request ATTACHMENTS — Direction B "Manifest" (epic 7d1d66ab, card 19b7cf7a) ───────────────────
// The owner's pick on request 0bbf7d1b. TWO surfaces, one source of truth for both (the pure helpers in
// lib/questions.ts): the COLLAPSED inbox row gets a one-line typed count chip, and the OPENED detail gets
// a manifest — one dense `ls`-like row per file — beside a SINGLE preview pane. Nothing here introduces a
// colour, a component or a chart lib: it is Panel/Button/Badge plus the signal tones this file already
// uses, and the manifest row's hover/focus chrome lives in global.css like every other kit control's.
//
// @decision 19b7cf7a — an HTML attachment previews ONLY as an `<iframe src>` on loopback, never through
// blob:/srcdoc and never with `allow-same-origin`; no `message` listener is ever registered for the frame,
// because a sandboxed document's `origin` is "null" and cannot be verified.

/** The collapsed row's indicator: "▨ 2 html · 2 image", with a red ✕N when something is unavailable, and
 *  phosphor-outlined while any available attachment is still unopened. ONE LINE at any attachment count —
 *  never a thumbnail strip, never a second line. Renders nothing at all for a request with no files. */
function RequestAttachmentChip({ attachments }: { attachments: QuestionAttachment[] }) {
  if (attachments.length === 0) return null;
  const chip = attachmentCountChip(attachments);
  const unopened = chip.unopened > 0;
  return (
    <span data-testid="attachment-count-chip" title={chip.title} aria-label={chip.title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, fontFamily: font.mono,
        fontSize: 10.5, letterSpacing: "0.04em", color: unopened ? color.phosphor : color.textDim,
        border: `1px solid ${unopened ? color.phosphor : color.borderStrong}`, borderRadius: radius.sm,
        padding: "1px 7px", whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>{ATTACHMENT_CHIP_GLYPH}</span>
      {chip.text && <span>{chip.text}</span>}
      {chip.unavailable > 0 && <span style={{ color: color.red }}>✕{chip.unavailable}</span>}
    </span>
  );
}

// The manifest's column geometry, shared by the header and every row so the columns actually line up —
// one object rather than two sets of literals that could drift apart.
const MANIFEST_GLYPH_W = 16;
const MANIFEST_STATE_W = 96;
const MANIFEST_ACTION_W = 76;

/**
 * The `<img src>` for an image attachment. On LOOPBACK this resolves synchronously to the route URL and
 * never fetches — the browser streams it, range-requests it, and caches it. On a REMOTE origin the route
 * is Bearer-only, so the bytes are fetched through the api client (which attaches the gateway credential
 * a bare `<img src>` cannot carry) and handed back as an object URL, revoked when the selection changes or
 * the pane unmounts. Mirrors components/VaultAsset.tsx's `useVaultAsset`, which solved exactly this
 * Tier-1 problem for `/vault/raw`; the blob is minted through that module's own `viewBlobType`, so a
 * scriptable image type could never become a same-origin document even if one reached here as
 * `kind:"image"` (it cannot — `.svg` is classified `"other"` server-side at copy time, card 432765ab).
 */
function useAttachmentImageSrc(questionId: string, attachmentId: string, remote: boolean) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>(
    remote ? { url: null, error: null } : { url: api.questionAttachmentUrl(questionId, attachmentId), error: null },
  );
  // The object URL THIS hook minted, so the cleanup revokes exactly that and never the loopback route URL
  // (which is not an object URL and must not be revoked).
  const owned = useRef<string | null>(null);
  useEffect(() => {
    if (!remote) {
      setState({ url: api.questionAttachmentUrl(questionId, attachmentId), error: null });
      return;
    }
    let live = true;
    setState({ url: null, error: null });
    void api.questionAttachmentBlob(questionId, attachmentId)
      .then(({ blob, contentType }) => {
        const url = URL.createObjectURL(new Blob([blob], { type: viewBlobType(contentType) }));
        // The effect may have been torn down mid-flight — mint-then-revoke rather than leaking the URL for
        // the document's lifetime.
        if (!live) { URL.revokeObjectURL(url); return; }
        owned.current = url;
        setState({ url, error: null });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({ url: null, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
      if (owned.current) { URL.revokeObjectURL(owned.current); owned.current = null; }
    };
  }, [questionId, attachmentId, remote]);
  return state;
}

/** A centred note inside the preview frame — the shared shape for every state that has no picture to
 *  show (gone, needs-loopback, downloads-only, still loading). Never a blank frame: the pane always says
 *  WHY it is not rendering something. */
function PreviewNote({ glyph, glyphTone, children }: { glyph: string; glyphTone?: string; children: ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 6, textAlign: "center", padding: 12, fontFamily: font.mono, fontSize: 10.5,
      color: color.textMuted, lineHeight: 1.5 }}>
      <span aria-hidden style={{ fontSize: 20, lineHeight: 1, color: glyphTone ?? color.textMuted, opacity: 0.85 }}>{glyph}</span>
      <span>{children}</span>
    </div>
  );
}

function AttachmentImagePreview({ questionId, a, remote }: { questionId: string; a: QuestionAttachment; remote: boolean }) {
  const img = useAttachmentImageSrc(questionId, a.id, remote);
  if (img.error) return <PreviewNote glyph="✕" glyphTone={color.red}>{img.error}</PreviewNote>;
  if (!img.url) return <PreviewNote glyph="▨">loading…</PreviewNote>;
  return (
    <img src={img.url} alt={a.label}
      style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
  );
}

/**
 * The single preview pane: a 16:10 plate for whichever manifest row is selected, the file's own label +
 * size/dimensions beneath it, and the same `Open ↗` action the row carries. Exactly ONE of these exists
 * regardless of attachment count, which is what keeps the panel's height independent of how many files the
 * agent sent and means only one image ever decodes at a time.
 */
function AttachmentPreviewPane({ questionId, a, remote }: { questionId: string; a: QuestionAttachment; remote: boolean }) {
  const mode = attachmentPreviewMode(a, remote);
  return (
    <div data-testid="attachment-preview" data-preview-mode={mode}
      style={{ flex: "0 1 236px", minWidth: 196, alignSelf: "flex-start", display: "flex", flexDirection: "column",
        gap: 8, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base, padding: 8 }}>
      <div style={{ position: "relative", aspectRatio: "16 / 10", overflow: "hidden", background: color.bg,
        border: `1px solid ${mode === "missing" ? color.red : color.border}`, borderRadius: radius.sm }}>
        {mode === "image" && <AttachmentImagePreview questionId={questionId} a={a} remote={remote} />}
        {mode === "html" && (
          // The REAL route, so the document is governed by the route's own
          // `sandbox allow-scripts; form-action 'none'; connect-src 'none'` CSP (card 8f050b79). The
          // `sandbox` attribute is set here too as belt and braces, deliberately WITHOUT
          // `allow-same-origin` — so even a lost header still leaves the page in an opaque origin with no
          // reach into this origin's localStorage, where the loopback/gateway tokens live. A thumbnail is
          // not an interaction surface: `pointerEvents:none` keeps untrusted agent bytes from taking
          // clicks or focus inside the answer dialog — `Open ↗` is where you actually interact with it.
          <iframe data-testid="attachment-preview-frame" title={`Preview of ${a.label}`}
            src={api.questionAttachmentUrl(questionId, a.id)} sandbox="allow-scripts"
            referrerPolicy="no-referrer" loading="lazy"
            style={{ position: "absolute", top: 0, left: 0, width: "286%", height: "286%", border: "none",
              transform: "scale(0.35)", transformOrigin: "top left", pointerEvents: "none" }} />
        )}
        {mode === "html-needs-loopback" && (
          <PreviewNote glyph={ATTACHMENT_GLYPH.html}>HTML preview needs loopback access — this origin signs requests with a header a frame can’t send</PreviewNote>
        )}
        {mode === "download" && (
          <PreviewNote glyph={ATTACHMENT_GLYPH.other}>no inline preview — this one downloads when opened</PreviewNote>
        )}
        {mode === "missing" && (
          <PreviewNote glyph="✕" glyphTone={color.red}>source gone — Loom has no copy of these bytes any more</PreviewNote>
        )}
      </div>
      <div style={{ fontFamily: font.mono, fontSize: 10.5, lineHeight: 1.6, wordBreak: "break-word" }}>
        <div style={{ color: color.textDim }}>{a.label}</div>
        <div style={{ color: color.textMuted }}>{attachmentDetail(a)}</div>
      </div>
      <AttachmentOpenAction questionId={questionId} a={a} remote={remote} />
    </div>
  );
}

/**
 * `Open ↗` — the one action, on every row and in the pane. It opens the serving route in a NEW TAB (so an
 * HTML mockup runs under the route's full CSP rather than a degraded inline one) and stamps `openedAt`,
 * which is what flips the row's STATE from `new` to `opened <age>`.
 *
 * `rel="noopener noreferrer"` is load-bearing, not hygiene: the opened document is untrusted agent-authored
 * bytes and must never receive a `window.opener` handle back into this app. The stamp is fired-and-forgotten
 * alongside the navigation — a failed stamp leaves the row honestly reading `new` rather than blocking the
 * open; first-open-wins server-side, so a repeat click can never rewrite the original time.
 */
function AttachmentOpenAction({ questionId, a, remote }: { questionId: string; a: QuestionAttachment; remote: boolean }) {
  const qc = useQueryClient();
  const refusal = attachmentOpenRefusal(a, remote);
  const stamp = useMutation({
    mutationFn: () => api.markQuestionAttachmentOpened(questionId, a.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["question", questionId] });
      qc.invalidateQueries({ queryKey: ["openQuestions"] });
    },
  });
  const geometry = { padding: "2px 8px", fontSize: 11, whiteSpace: "nowrap" as const };
  if (refusal) {
    return (
      <Button data-testid="attachment-open" variant="default" disabled title={refusal} style={geometry}>Open ↗</Button>
    );
  }
  return (
    <a data-testid="attachment-open" className={`loom-btn loom-btn-${a.openedAt ? "default" : "primary"}`}
      href={api.questionAttachmentUrl(questionId, a.id)} target="_blank" rel="noopener noreferrer"
      title={`Open ${a.label} in a new tab`} onClick={() => stamp.mutate()}
      style={{ ...geometry, display: "inline-block", textAlign: "center", textDecoration: "none",
        borderRadius: radius.base, fontFamily: font.mono }}>
      Open ↗
    </a>
  );
}

/** One manifest row: glyph · label + size/dimensions · STATE · `Open ↗`. The row body is the select
 *  control (it drives the shared preview pane) and the action sits OUTSIDE it — a button inside a button
 *  is invalid HTML, so this is a flex row with fixed column widths rather than one nested control. An
 *  UNAVAILABLE row keeps its place, struck through, still selectable (its pane says what happened) with
 *  the action disabled; it is never dropped, which would silently rewrite what the agent said it sent. */
function AttachmentRow({ questionId, a, selected, now, remote, onSelect }: {
  questionId: string; a: QuestionAttachment; selected: boolean; now: number; remote: boolean; onSelect: () => void;
}) {
  const state = attachmentStateChip(a, now);
  return (
    <div data-testid="attachment-row" data-attachment-id={a.id} data-selected={selected}
      style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${color.border}`,
        borderLeft: `2px solid ${selected ? color.phosphor : "transparent"}`,
        background: selected ? color.panel2 : "transparent" }}>
      <button className="loom-manifest-row" onClick={onSelect} aria-current={selected}
        title={`${a.label} — ${attachmentDetail(a)}`}
        style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "7px 6px",
          background: "transparent", border: "none", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
        <span aria-hidden style={{ width: MANIFEST_GLYPH_W, flexShrink: 0, textAlign: "center", fontSize: 12, lineHeight: 1,
          color: a.available ? (a.kind === "html" ? color.phosphor : color.textDim) : color.red }}>
          {a.available ? ATTACHMENT_GLYPH[a.kind] : "✕"}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: font.mono, fontSize: 12, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
            color: a.available ? color.text : color.textDim,
            textDecoration: a.available ? "none" : "line-through" }}>{a.label}</span>
          <span style={{ display: "block", fontFamily: font.mono, fontSize: 10, color: color.textMuted, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachmentDetail(a)}</span>
        </span>
        <span data-testid="attachment-state" style={{ width: MANIFEST_STATE_W, flexShrink: 0, fontFamily: font.mono,
          fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: tone[state.tone] }}>{state.label}</span>
      </button>
      <span style={{ width: MANIFEST_ACTION_W, flexShrink: 0, display: "flex", justifyContent: "flex-end", paddingRight: 6 }}>
        <AttachmentOpenAction questionId={questionId} a={a} remote={remote} />
      </span>
    </div>
  );
}

/** The whole ATTACHED panel in the opened detail: the manifest on the left, the single preview pane on the
 *  right, wrapping to one column on a narrow viewport (flex-wrap rather than a media query, so the panel
 *  reflows inside the 720px dialog AND on a phone with no second styling path to keep in sync). */
function RequestAttachments({ question }: { question: QuestionInboxItem }) {
  const attachments = question.attachments;
  const remote = isRemoteOrigin();
  const now = Date.now();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Resolved against the LIVE list on every render, never held as a copy: a refetch (the inbox polls, and
  // an Open stamp invalidates) can drop or add an attachment, and a stale id must degrade to the first
  // available row rather than leaving the pane pointing at nothing. An unavailable row is selectable but
  // is never what the panel OPENS on — the first thing you can actually look at is.
  const selected = attachments.find((a) => a.id === selectedId)
    ?? attachments.find((a) => a.available)
    ?? attachments[0];
  if (attachments.length === 0 || !selected) return null;
  const chip = attachmentCountChip(attachments);

  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Attached · {attachments.length}</SectionLabel>
        {chip.unopened > 0 && <Badge tone="phosphor">{chip.unopened} unopened</Badge>}
        {chip.unavailable > 0 && <Badge tone="red">{chip.unavailable} unavailable</Badge>}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Column header — the same three widths the rows use, so the manifest reads as a table. */}
          <div aria-hidden style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 6px 5px",
            borderBottom: `1px solid ${color.border}`, fontFamily: font.head, fontSize: 9.5, fontWeight: 700,
            letterSpacing: "0.12em", textTransform: "uppercase", color: color.textMuted }}>
            <span style={{ width: MANIFEST_GLYPH_W, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>file</span>
            <span style={{ width: MANIFEST_STATE_W, flexShrink: 0 }}>state</span>
            <span style={{ width: MANIFEST_ACTION_W, flexShrink: 0, textAlign: "right", paddingRight: 6 }}>action</span>
          </div>
          {attachments.map((a) => (
            <AttachmentRow key={a.id} questionId={question.id} a={a} now={now} remote={remote}
              selected={a.id === selected.id} onSelect={() => setSelectedId(a.id)} />
          ))}
        </div>
        <AttachmentPreviewPane questionId={question.id} a={selected} remote={remote} />
      </div>
      {chip.unavailable > 0 && (
        <span style={{ fontFamily: font.mono, fontSize: 11.5, color: color.textDim, lineHeight: 1.6,
          borderLeft: `2px solid ${color.borderStrong}`, paddingLeft: 10 }}>
          A source was removed before you got here — most often a worker’s worktree reaped after it
          finished. The row stays so you can still see what the agent sent; the bytes themselves are gone.
        </span>
      )}
    </Panel>
  );
}

// ── RequestRow — one inbox entry (Direction A signal row) ─────────────────────────
// The left edge is signed the type's color while pending (amber on the answered-stuck watchdog case). The
// row action opens the detail MODAL in place (no route push); answered rows get a View that opens the same.
function RequestRow({ q, now, onOpen }: { q: QuestionInboxItem; now: number; onOpen: (id: string) => void }) {
  const watchdog = isDecisionWatchdog(q, now);
  const typeTone = REQUEST_TYPE_TONE[q.type];
  const edge = q.state === "pending" ? tone[typeTone] : watchdog ? color.amber : "transparent";
  const metaDot = q.state === "pending" ? typeTone : watchdog ? "amber" : "muted";
  return (
    // `data-testid` + `data-question-id`: an e2e needs to scope an assertion to ONE row, and filtering a
    // bare `div` by its title text matches every ANCESTOR container too — which silently widens the scope
    // to a sibling row's controls (the same collision class as the agent-row/project-name one).
    <Panel data-testid="request-row" data-question-id={q.id}
      style={{ display: "flex", flexDirection: "column", gap: 5, borderLeft: `3px solid ${edge}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Dot tone={metaDot} glow={watchdog} />
            <span style={{ color: color.cyan }}>{q.projectName}</span>
            <span>· <RequestProvenance q={q} /></span>
            <span>· {q.state === "pending" ? "asked" : q.state === "notice" ? "posted" : "answered"} {relativeAge(q.state === "pending" ? q.createdAt : q.answeredAt, now)}</span>
            {q.taskId && <LinkedTaskChip taskId={q.taskId} columnKey={q.linkedTaskColumnKey} />}
            <RequestAttachmentChip attachments={q.attachments} />
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <RequestTypeTag type={q.type} />
          {q.state === "pending"
            ? <RequestNeedsChip type={q.type} />
            : <DecisionStateChip q={q} now={now} />}
          {q.state === "pending"
            ? (
              <div style={{ display: "flex", gap: 6 }}>
                <DismissButton q={q} />
                <Button variant="primary" onClick={() => onOpen(q.id)}>{requestActionLabel(q.type)}</Button>
              </div>
            )
            : watchdog
              ? <NudgeMgrButton q={q} />
              : <Button variant="ghost" onClick={() => onOpen(q.id)} style={{ padding: "0 6px" }}>View</Button>}
        </div>
      </div>
      {/* second line: the type-colored hint (pending) or the recorded outcome (answered/consumed). */}
      {q.state === "pending" ? (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[typeTone] }}>{requestHint(q)}</span>
      ) : (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: watchdog ? color.amber : color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {q.state === "notice" ? "" : watchdog ? "answered, not picked up — " : "answered: "}
          {requestOutcome(q)}
        </span>
      )}
    </Panel>
  );
}

// A filter chip: a leading colored dot (type filters) + label + count; the active one is phosphor-outlined.
function FilterChip({ label, count, active, dotTone, onClick }:
  { label: string; count: number; active: boolean; dotTone?: Tone; onClick: () => void }) {
  return (
    <button onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, background: active ? color.panel2 : "transparent",
        border: `1px solid ${active ? color.phosphor : color.border}`, borderRadius: radius.sm, padding: "2px 8px", cursor: "pointer",
        fontFamily: font.mono, fontSize: 11, color: active ? color.phosphor : color.textDim }}>
      {dotTone && <Dot tone={dotTone} />}
      {label}
      <span style={{ color: active ? color.phosphor : color.textMuted }}>{count}</span>
    </button>
  );
}

// ── RequestsInbox (GLOBAL "waiting on me") ────────────────────────────────────────
// One cross-project queue with a TYPE filter (all + one per type, with counts) AND the existing per-project
// facet — both narrow WITHOUT leaving this destination. Pending rank first, then answered below. Row action
// opens the detail modal in place.
export function RequestsInbox() {
  const questions = useQuery({ queryKey: ["openQuestions"], queryFn: () => api.openQuestions(), refetchInterval: 3000 });
  const qc = useQueryClient();
  const [typeFacet, setTypeFacet] = useState<QuestionType | "all">("all");
  const [projFacet, setProjFacet] = useState<string>("all"); // projectId | "all"
  const [unreadOnly, setUnreadOnly] = useState(false);
  const openRequest = useOpenRequest();
  const now = Date.now();

  const items = questions.data ?? [];
  const unreadCount = items.filter(isUnread).length;
  // Type counts (over the whole queue) — one chip per type, "all" leads.
  const typeCounts = useMemo(() => {
    const m = new Map<QuestionType, number>();
    for (const q of items) m.set(q.type, (m.get(q.type) ?? 0) + 1);
    return m;
  }, [items]);
  // Project facet chips: one per project present, with its open count.
  const projects = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const q of items) {
      const cur = m.get(q.projectId);
      if (cur) cur.count += 1;
      else m.set(q.projectId, { id: q.projectId, name: q.projectName, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [items]);

  // A facet that no longer matches any row falls back to "all".
  const activeType = typeFacet !== "all" && (typeCounts.get(typeFacet) ?? 0) > 0 ? typeFacet : "all";
  const activeProj = projFacet !== "all" && projects.some((p) => p.id === projFacet) ? projFacet : "all";
  const filtered = items.filter((q) =>
    (activeType === "all" || q.type === activeType) &&
    (activeProj === "all" || q.projectId === activeProj) &&
    (!unreadOnly || isUnread(q)));
  const pending = filtered.filter((q) => q.state === "pending");
  // A notice (card 59fa6403) is its own group, NOT "waiting on me" — nobody is waiting on anything for
  // it, so it must never inflate the header count or sit under the "waiting on manager pickup" label,
  // which would be a false claim for a self-terminal row. Checked BEFORE the generic "answered" bucket.
  const notices = filtered.filter((q) => q.state === "notice");
  const answered = filtered.filter((q) => q.state !== "pending" && q.state !== "notice");
  const waitingCount = pending.length + answered.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SectionLabel style={{ margin: 0 }}>Waiting on me ({waitingCount})</SectionLabel>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => qc.invalidateQueries({ queryKey: ["openQuestions"] })}>Refresh</Button>
      </div>

      {/* type filter */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <FilterChip label="all" count={items.length} active={activeType === "all"} onClick={() => setTypeFacet("all")} />
        {REQUEST_TYPE_ORDER.filter((t) => (typeCounts.get(t) ?? 0) > 0).map((t) => (
          <FilterChip key={t} label={t} count={typeCounts.get(t) ?? 0} dotTone={REQUEST_TYPE_TONE[t]}
            active={activeType === t} onClick={() => setTypeFacet(t)} />
        ))}
      </div>

      {/* project facet */}
      {projects.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <FilterChip label="all projects" count={items.length} active={activeProj === "all"} onClick={() => setProjFacet("all")} />
          {projects.map((p) => (
            <FilterChip key={p.id} label={p.name} count={p.count} active={activeProj === p.id} onClick={() => setProjFacet(p.id)} />
          ))}
        </div>
      )}

      {/* unread filter (Phase 2 of card 59fa6403) — a toggle, not a facet: only on/off, never exclusive
          with the type/project facets above. */}
      {unreadCount > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FilterChip label="unread" count={unreadCount} dotTone="muted" active={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} />
        </div>
      )}

      {items.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Nothing is waiting on you. Managers surface requests here when they need your call.</span></Panel>}
      {items.length > 0 && filtered.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No requests match this filter.</span></Panel>}

      {pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pending.map((q) => <RequestRow key={q.id} q={q} now={now} onOpen={openRequest} />)}
        </div>
      )}
      {answered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel style={{ margin: "4px 0 0", color: color.textMuted }}>Answered · waiting on manager pickup</SectionLabel>
          {answered.map((q) => <RequestRow key={q.id} q={q} now={now} onOpen={openRequest} />)}
        </div>
      )}
      {notices.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel style={{ margin: "4px 0 0", color: color.textMuted }}>FYI · recent notices</SectionLabel>
          {notices.map((q) => <RequestRow key={q.id} q={q} now={now} onOpen={openRequest} />)}
        </div>
      )}
    </div>
  );
}

// ── RequestModal ──────────────────────────────────────────────────────────────────
// The detail/response as a centered dialog OVER the current page (Mission/Overview/Board/Requests) — the
// owner picked "answer without leaving the page you're on". ✕ closes; the backdrop and Escape close only
// while the answer form is CLEAN (card 544960ed — a stray click outside used to destroy a typed draft),
// and otherwise say what they refused to do. The same content also renders at /question/:id as a
// deep-link (see pages/QuestionAnswer.tsx).
export function RequestModal({ id, onClose }: { id: string; onClose: () => void }) {
  // The copy of the last refused close, or null. Read from the draft store at refusal time rather than
  // subscribed to, so typing in the form never re-renders the dialog.
  const [refused, setRefused] = useState<string | null>(null);
  const tryClose = useCallback(() => {
    if (!isRequestDraftDirty(id)) { onClose(); return; }
    // A credential secret is deliberately NOT retained (see requestDrafts.ts) — say so instead of
    // promising a draft that is about to be discarded by the one close path that still works.
    setRefused(getRequestDraft(id).secretDirty ? "Secret not kept — ✕ discards it" : "Draft kept — ✕ to close");
  }, [id, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") tryClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tryClose]);
  // The notice is transient — it answers "why did nothing happen?" and then gets out of the way.
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(null), 4000);
    return () => clearTimeout(t);
  }, [refused]);
  return (
    <div onClick={tryClose} role="dialog" aria-modal
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 60, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "100%", background: color.panel, border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.base, padding: 16, display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SectionLabel style={{ margin: 0, flex: 1 }}>Request · {id.slice(0, 8)}</SectionLabel>
          {refused && (
            <span data-testid="request-close-refused" role="status" aria-live="polite"
              style={{ fontFamily: font.mono, fontSize: 11, color: color.amber }}>{refused}</span>
          )}
          <Button onClick={onClose} title="Close (Esc)">✕</Button>
        </div>
        <RequestDetail id={id} onClose={onClose} />
      </div>
    </div>
  );
}

// ── RequestModalProvider / useOpenRequest ──────────────────────────────────────────
// ONE app-wide mechanism for opening a Request as an in-place modal, so EVERY in-app answer
// affordance — the Requests inbox/history, the Overview + Mission attention rows, the fleet decision
// hints, the command palette, the global attention toast, and the Board task drawer — opens the SAME
// dialog over the current page instead of navigating away to /question/:id. The provider is mounted
// once near the app root: it owns the openId state and renders a single <RequestModal>; useOpenRequest()
// returns the opener a consumer calls with a questionId. /question/:id stays a working standalone
// deep-link (bookmarks, the toast's browser Notification, external links) — only the IN-APP click
// affordances route through here, so there's no parallel per-page modal copy to drift.
const RequestModalContext = createContext<((questionId: string) => void) | null>(null);

export function RequestModalProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const qc = useQueryClient();
  // Phase 2 of card 59fa6403 (read/unread) — every in-app "open this request" affordance funnels through
  // this ONE opener (see the doc block above), so marking the row read ON OPEN here covers all of them
  // with no per-call-site wiring. Best-effort: a failed mark-read write never blocks opening the row.
  const open = useCallback((questionId: string) => {
    setOpenId(questionId);
    api.markQuestionsRead([questionId])
      .then((r) => { if (r.updated.length > 0) qc.invalidateQueries({ queryKey: ["openQuestions"] }); })
      .catch(() => { /* best-effort — the modal already has the row's data either way */ });
  }, [qc]);
  return (
    <RequestModalContext.Provider value={open}>
      {children}
      {openId && <RequestModal id={openId} onClose={() => setOpenId(null)} />}
    </RequestModalContext.Provider>
  );
}

// A module-level identity so the inert opener is referentially stable across renders, exactly as the
// provider's own `useCallback` opener is — a consumer may legitimately list it in a hook dependency array.
const INERT_OPEN: (questionId: string) => void = () => { /* held — see useOpenRequest below */ };

// @decision b472645a — an opener reached from inside the dev End-user preview must open NOTHING: the
// modal's answer / permission / credential controls and this provider's own mark-read-on-open write all
// act on the previewed home's own session, which is inside that gate's criterion (card edfd8295).
//
// This is the STRUCTURAL half of the pair, and it is here rather than at the call site for the reason
// `lib/previewOnly.tsx` sets out: the modal is mounted at the app root, so no prop from Platform.tsx can
// reach the controls themselves — the only place to stop them is the funnel every in-app affordance
// already goes through. Holding it here means a NEW open-request control added anywhere inside the
// preview is inert even if its author never reads the flag, which is the same property the cadence form's
// disabled `<fieldset>` buys structurally rather than per-control. The visible per-control gate (a
// disabled button that says why, `pages/Board.tsx` › ConnectedRequestRow) sits on top and is what a user
// actually reads; removing it would re-open nothing.
export function useOpenRequest(): (questionId: string) => void {
  const open = useContext(RequestModalContext);
  // Read before the throw: both hooks must run on every render, in the same order, whatever the outcome.
  const previewOnly = usePreviewOnly();
  if (!open) throw new Error("useOpenRequest must be used within a RequestModalProvider");
  return previewOnly ? INERT_OPEN : open;
}

// ── RequestDetail — the reusable detail/response body (4 affordances) ──────────────
// Renders the header (type tag · agent·project · linked-task chip · state chip · live-session link), the
// "The ask" panel, and the TYPE-APPROPRIATE control (decision · input · permission · credential) or, once
// answered/consumed, the recorded readout. Used by BOTH the modal and the /question/:id deep-link page.
// `onClose`, when set (the modal), is called before a linked-task navigation so the dialog closes first.
export function RequestDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const navigate = useNavigate();
  const active = useActiveProject();
  const q = useQuery({ queryKey: ["question", id], queryFn: () => api.question(id), enabled: !!id, retry: false });
  const question = q.data;
  const now = Date.now();

  // A request can stop being answerable OUT OF BAND — the owner answers it in chat (question_resolve),
  // from another tab, or a manager cancels it. The control then simply stops mounting, so its own
  // clear-on-submit never runs and the store would keep a dirty flag for an answer that can never be
  // sent: reopening would refuse the backdrop/Escape close with "Draft kept" and no form on screen to
  // explain why. Retiring on ANY non-pending state is the one place that covers every such path.
  // Deliberately NOT extended to q.isError: `retry:false` turns a transient blip into an error, and
  // clearing there would destroy a draft the human is still typing — the exact thing this card exists to
  // prevent. A vanished request can still always be closed with ✕.
  const questionState = question?.state;
  useEffect(() => {
    if (questionState && questionState !== "pending") clearRequestDraft(id);
  }, [id, questionState]);

  // Best-effort linked-task title (soft link — tolerate a dangling id). Only fetched when a taskId is set.
  const tasks = useQuery({
    queryKey: ["tasks", question?.projectId],
    queryFn: () => api.tasks(question!.projectId),
    enabled: !!question?.taskId && !!question?.projectId,
  });
  const linkedTask = question?.taskId ? tasks.data?.find((t) => t.id === question.taskId) : undefined;
  const linkedTitle = linkedTask?.title;
  // Card 889ae619 (iii-b) — prefer the LIVE board fetch's columnKey (linkedTask, above) when it resolved;
  // fall back to the enriched read's own join (question.linkedTaskColumnKey) so the lane still shows
  // before/without that per-project fetch settling. Same soft-link tolerance as linkedTitle: a dangling
  // taskId simply yields undefined/null from both sources, never a crash.
  const linkedColumnKey = linkedTask?.columnKey ?? question?.linkedTaskColumnKey;

  const openLinkedTask = () => {
    if (!question?.taskId) return;
    // Soft link → the board scoped to the request's project, drawer open on the card. `?task=` is consumed
    // by Board and cleared; a dangling id just opens the board (no crash).
    active.setProjectId(question.projectId);
    onClose?.();
    navigate(`/board?task=${encodeURIComponent(question.taskId)}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {q.isError && <Panel><span style={{ color: color.red, fontSize: 12 }}>Request not found (it may have been removed).</span></Panel>}
      {q.isLoading && <Panel><span style={{ color: color.textMuted, fontSize: 12 }}>Loading…</span></Panel>}

      {question && (
        <>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <RequestTypeTag type={question.type} />
            <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
              <RequestProvenance q={question} /> · <span style={{ color: color.cyan }}>{question.projectName}</span>
            </span>
            {question.taskId && <LinkedTaskChip taskId={question.taskId} title={linkedTitle} columnKey={linkedColumnKey} onClick={openLinkedTask} />}
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
              asked {relativeAge(question.createdAt, now)}
            </span>
            <DecisionStateChip q={question} now={now} />
            {question.sessionLive && (
              <button onClick={() => { onClose?.(); navigate(`/session/${question.sessionId}`); }}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: color.cyan, fontFamily: font.mono, fontSize: 12, padding: 0 }}>
                open live session ↗
              </button>
            )}
          </div>

          {/* The asking session is confirmed gone for good — say so before the human answers into a no-op. */}
          {question.sessionOrphaned && (
            <Panel style={{ borderLeft: `3px solid ${color.amber}` }}>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: color.amber }}>
                The asking session is gone for good and can never come back to pull an answer — submitting
                below will record your answer, but nothing will ever act on it automatically.
              </span>
            </Panel>
          )}

          {/* THE ASK */}
          <Panel style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `2px solid ${tone[REQUEST_TYPE_TONE[question.type]]}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <SectionLabel style={{ margin: 0 }}>The ask</SectionLabel>
              <span style={{ flex: 1 }} />
              <Badge tone={REQUEST_TYPE_TONE[question.type]}>{requestAnswerBadge(question)}</Badge>
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 15, color: color.text, lineHeight: 1.45 }}>{question.title}</div>
            {question.body && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{question.body}</div>}
          </Panel>

          {/* ATTACHED — its own panel between the ask and the answer controls, for EVERY state and type
              (a `notice` carries files just as legitimately as a pending decision, and a consumed row's
              files are still what the human was shown). Renders nothing when there are none, so a
              request without attachments is byte-identical to before. ⛔ The answer controls below are
              deliberately untouched — the owner's note on this card: "answer options optional as always,
              and the note field as before". */}
          <RequestAttachments question={question} />

          {/* Resolved → the recorded readout; pending → the type-specific control. */}
          {question.state !== "pending"
            ? <AnsweredReadout q={question} />
            : <RequestControl q={question} />}
        </>
      )}
    </div>
  );
}

// The recorded answer for a non-pending request. A credential NEVER shows a value — only that it was
// provided, encrypted. Decision/input show the chosen option + note; permission shows the authorize/deny
// outcome + note. A CANCELLED request was never answered at all — a distinct readout (never "Answered …"),
// naming the reason + who cancelled it (question_cancel/dismiss, card feat(orchestration): question_cancel
// + dismiss). A NOTICE (card 59fa6403) was likewise never answered — it's its own terminal state, checked
// by `state` (not `type`) so this stays correct even if a future type ever shares the notice state shape.
function AnsweredReadout({ q }: { q: QuestionInboxItem }) {
  if (q.state === "cancelled") {
    return (
      <Panel style={{ display: "flex", flexDirection: "column", gap: 6, borderLeft: `3px solid ${color.red}` }}>
        <SectionLabel style={{ margin: 0, color: color.red }}>Cancelled · never answered</SectionLabel>
        <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim }}>
          {q.cancelledReason ?? "no reason given"}
        </div>
        <div style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
          by {q.cancelledBy === "agent" ? "the asking agent" : "a human"}
        </div>
      </Panel>
    );
  }
  if (q.state === "notice") {
    return (
      <Panel style={{ display: "flex", flexDirection: "column", gap: 6, borderLeft: `3px solid ${tone.muted}` }}>
        <SectionLabel style={{ margin: 0 }}>FYI · no answer needed</SectionLabel>
        <span style={{ color: color.textMuted, fontSize: 12 }}>—</span>
      </Panel>
    );
  }
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SectionLabel style={{ margin: 0 }}>{q.state === "consumed" ? "Answered · the manager pulled it" : "Answered · waiting on manager pickup"}</SectionLabel>
      {q.type === "credential" ? (
        <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim }}>provided · encrypted, not shown</div>
      ) : q.type === "permission" ? (
        <div style={{ fontFamily: font.mono, fontSize: 13, color: q.chosenOption === "authorize" ? color.phosphor : color.red }}>{requestOutcome(q)}</div>
      ) : (
        <>
          {q.chosenOption && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>Chose: <span style={{ color: color.cyan }}>{q.chosenOption}</span></div>}
          {q.note && <div style={{ fontFamily: font.mono, fontSize: 13, color: color.textDim, whiteSpace: "pre-wrap" }}>Note: {q.note}</div>}
          {!q.chosenOption && !q.note && <span style={{ color: color.textMuted, fontSize: 12 }}>—</span>}
        </>
      )}
    </Panel>
  );
}

// Dispatch a PENDING request to its type-appropriate control.
function RequestControl({ q }: { q: QuestionInboxItem }) {
  switch (q.type) {
    case "permission": return <PermissionControl q={q} />;
    case "credential": return <CredentialControl q={q} />;
    case "input": return <InputControl q={q} />;
    default: return <DecisionControl q={q} />;
  }
}

// Shared submit-invalidation + a small success flash. Every control funnels its answer through here so the
// inbox + this question both refetch the moment the write lands — and so the ONE place that knows an
// answer actually landed is the one place that retires its draft (card 544960ed).
function useAnswerMutation(id: string, mutationFn: () => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      clearRequestDraft(id);
      qc.invalidateQueries({ queryKey: ["question", id] });
      qc.invalidateQueries({ queryKey: ["openQuestions"] });
    },
  });
}

const textareaStyle = {
  width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, background: color.panel2, color: color.text,
  border: `1px solid ${color.borderStrong}`, borderRadius: radius.base, padding: "8px 10px", fontFamily: font.mono, fontSize: 13,
};

// decision — options as selectable choices (recommendation flagged) + an always-optional note. Picking an
// offered option is a convenience; a human may answer by free-text note alone (mirrors the answer route).
function DecisionControl({ q }: { q: QuestionInboxItem }) {
  const [choice, setChoice] = useState<string | null>(() => getRequestDraft(q.id).choice);
  const [note, setNote] = useState(() => getRequestDraft(q.id).note);
  const hasOptions = !!q.options && q.options.length > 0;
  const answer = useAnswerMutation(q.id, () => api.answerQuestion(q.id, { chosenOption: choice, note: note.trim() || undefined }));
  const canSubmit = choice != null || note.trim().length > 0;
  // Mirror the unsent answer into the draft store: `canSubmit` IS dirtiness here (a pick or any note), and
  // a landed answer must never read dirty again — it would refuse the close of an already-answered dialog.
  useEffect(() => {
    setRequestDraft(q.id, { ...EMPTY_REQUEST_DRAFT, choice, note }, canSubmit && !answer.isSuccess);
  }, [q.id, choice, note, canSubmit, answer.isSuccess]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {hasOptions && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel>Options — pick one (optional)</SectionLabel>
          {q.options!.map((opt, i) => {
            const selected = choice === opt;
            const recommended = q.recommendation === opt;
            return (
              <Panel key={i} selected={selected} onClick={() => setChoice(opt)}
                style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <span aria-hidden style={{ width: 14, height: 14, borderRadius: 14, flexShrink: 0, marginTop: 2,
                  border: `2px solid ${selected ? color.cyan : color.borderStrong}`, background: selected ? color.cyan : "transparent",
                  boxShadow: selected ? `inset 0 0 0 2px ${color.panel}` : "none" }} />
                <span style={{ flex: 1, fontFamily: font.mono, fontSize: 13, color: color.text }}>{opt}</span>
                {recommended && <Badge tone="phosphor">recommended</Badge>}
              </Panel>
            );
          })}
        </div>
      )}
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>
          Note {hasOptions ? "(type your answer here, or add context for your pick)" : "(required — this is your answer)"}
        </SectionLabel>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder={hasOptions ? "add context for the manager…" : "your decision — e.g. “go ahead”, “hold off, do X first”…"}
          style={textareaStyle} />
        <SubmitRow label="Submit answer" disabled={!canSubmit} pending={answer.isPending} success={answer.isSuccess} onSubmit={() => answer.mutate()} />
      </Panel>
    </div>
  );
}

// input — a single required free-text answer (no options). The note IS the answer.
function InputControl({ q }: { q: QuestionInboxItem }) {
  const [note, setNote] = useState(() => getRequestDraft(q.id).note);
  const answer = useAnswerMutation(q.id, () => api.answerQuestion(q.id, { note: note.trim() }));
  useEffect(() => {
    setRequestDraft(q.id, { ...EMPTY_REQUEST_DRAFT, note }, note.trim().length > 0 && !answer.isSuccess);
  }, [q.id, note, answer.isSuccess]);
  return (
    <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel style={{ margin: 0 }}>Your answer (required)</SectionLabel>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4}
        placeholder="type your answer…" style={textareaStyle} />
      <SubmitRow label="Submit answer" disabled={note.trim().length === 0} pending={answer.isPending} success={answer.isSuccess} onSubmit={() => answer.mutate()} />
    </Panel>
  );
}

// permission — Authorize / Deny + a scope picker (once / standing) with an optional expiry (standing
// only) + an optional note. The human's chosen scope/expiry (fix(mcp): persist and surface permission
// scope/expiry) is sent STRUCTURALLY to the answer route (never folded into `note` text) — `expiry` here
// is a relative duration CODE from the picker below; `expiresAtIso` converts it to an ABSOLUTE timestamp
// at submit time, since "24h" only means something relative to the moment of decision. ADVISORY ONLY:
// Loom persists + surfaces this grant (and derives a read-time `lapsed` flag once it's past) but does not
// itself enforce or re-check it — a manager must read the grant and honor it.
const PERMISSION_EXPIRY_MS: Record<string, number> = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000 };
function PermissionControl({ q }: { q: QuestionInboxItem }) {
  // The asker's hint is this form's DEFAULT scope, so "dirty" means the human moved it off that default —
  // scope always holds a value and can never be judged dirty by emptiness the way the other fields are.
  const defaultScope = q.permissionScopeHint ?? "once";
  const [scope, setScope] = useState<PermissionScope>(() => getRequestDraft(q.id).scope ?? defaultScope);
  const [expiry, setExpiry] = useState<string>(() => getRequestDraft(q.id).expiry);
  const [note, setNote] = useState(() => getRequestDraft(q.id).note);
  const expiresAtIso = (): string | undefined => {
    if (scope !== "standing" || !expiry) return undefined;
    const ms = PERMISSION_EXPIRY_MS[expiry];
    return ms ? new Date(Date.now() + ms).toISOString() : undefined;
  };
  const authorize = useAnswerMutation(q.id, () => api.answerPermissionQuestion(q.id, "authorize", { scope, expiresAt: expiresAtIso(), note: note.trim() || undefined }));
  const deny = useAnswerMutation(q.id, () => api.answerPermissionQuestion(q.id, "deny", { note: note.trim() || undefined }));
  const pending = authorize.isPending || deny.isPending;
  const answered = authorize.isSuccess || deny.isSuccess;
  useEffect(() => {
    const dirty = note.trim().length > 0 || scope !== defaultScope || expiry !== "";
    setRequestDraft(q.id, { ...EMPTY_REQUEST_DRAFT, note, scope, expiry }, dirty && !answered);
  }, [q.id, note, scope, expiry, defaultScope, answered]);
  const kv = (label: string, value: string) => (
    <div style={{ display: "flex", gap: 10, fontFamily: font.mono, fontSize: 13 }}>
      <span style={{ color: color.textMuted, minWidth: 90 }}>{label}</span>
      <span style={{ color: color.text, whiteSpace: "pre-wrap" }}>{value}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel style={{ margin: 0 }}>Action</SectionLabel>
        {kv("Action", q.permissionAction ?? "—")}
        {kv("Asker suggested", q.permissionScopeHint ?? "once")}
        {q.permissionExpiresAt && kv("Until", q.permissionExpiresAt)}
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Scope</SectionLabel>
        <div style={{ display: "flex", gap: 8 }}>
          {PERMISSION_SCOPES.map((s) => {
            const selected = scope === s;
            return (
              <Panel key={s} selected={selected} onClick={() => setScope(s)}
                style={{ flex: 1, cursor: "pointer", display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: font.mono, fontSize: 13, color: selected ? color.phosphor : color.text }}>{s}</span>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
                  {s === "once" ? "this action only" : "keep authorizing this class"}
                </span>
              </Panel>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: scope === "standing" ? color.textDim : color.textMuted }}>Expiry</span>
          <Select value={expiry} disabled={scope !== "standing"} onChange={(e) => setExpiry(e.target.value)}
            title={scope === "standing" ? "Optional expiry for a standing grant" : "Enable by choosing the standing scope"}>
            <option value="">no expiry</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </Select>
        </div>
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Note (optional)</SectionLabel>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="add context for the manager…" style={textareaStyle} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" disabled={pending} onClick={() => authorize.mutate()}>{authorize.isPending ? "Authorizing…" : "Authorize"}</Button>
          <Button variant="danger" disabled={pending} onClick={() => deny.mutate()}>{deny.isPending ? "Denying…" : "Deny"}</Button>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Sends your decision to agent {q.sessionId.slice(0, 8)}.</span>
        </div>
        {(authorize.isSuccess || deny.isSuccess) && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ answered — the manager was nudged to pull it.</span>}
      </Panel>
    </div>
  );
}

// credential — NEVER-ECHO. A prominent banner, the target env-var name, and a MASKED secret input with a
// show/hide toggle. The plaintext is envelope-encrypted at the daemon's one write boundary and never
// returned; this UI must not imply otherwise.
function CredentialControl({ q }: { q: QuestionInboxItem }) {
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const answer = useAnswerMutation(q.id, () => api.answerCredentialQuestion(q.id, secret));
  // Only the FACT that a secret is half-typed reaches the draft store — never the value (see
  // requestDrafts.ts). That is enough for the backdrop/Escape guard, which is what the stray click needed;
  // the secret itself stays in this component's state and dies with it.
  useEffect(() => {
    setRequestDraft(q.id, { ...EMPTY_REQUEST_DRAFT, secretDirty: true }, secret.length > 0 && !answer.isSuccess);
  }, [q.id, secret, answer.isSuccess]);
  // The other three controls restore their draft on mount, so a dirty flag outliving the form is correct
  // for them. This one restores NOTHING, so its flag must die with it — a stale one would refuse the
  // backdrop close of a reopened, genuinely empty credential form.
  useEffect(() => () => clearRequestDraft(q.id), [q.id]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Panel style={{ borderLeft: `3px solid ${color.amber}`, display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: color.amber }}>Write-only secret</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.5 }}>
          Stored envelope-encrypted (AES-256-GCM) and NEVER echoed back to the agent or shown here again.
          It is NOT auto-injected into any session — wire it into a Connection or the project's config
          yourself before an agent can use it. Store it once — you won’t see it after.
        </span>
      </Panel>
      <Panel style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel style={{ margin: 0 }}>Secret value</SectionLabel>
        {q.credentialEnvVar && (
          <div style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
            target env var: <span style={{ color: color.amber }}>{q.credentialEnvVar}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type={reveal ? "text" : "password"} value={secret} onChange={(e) => setSecret(e.target.value)}
            autoComplete="off" spellCheck={false} placeholder="paste the secret value…"
            style={{ flex: 1, ...textareaStyle, resize: undefined }} />
          <Button type="button" onClick={() => setReveal((r) => !r)} aria-pressed={reveal}
            title={reveal ? "Hide the secret" : "Show the secret"}>{reveal ? "Hide" : "Show"}</Button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button variant="primary" disabled={secret.trim().length === 0 || answer.isPending} onClick={() => answer.mutate()}>
            {answer.isPending ? "Storing…" : "Store securely"}
          </Button>
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Encrypted at rest · never returned.</span>
        </div>
        {answer.isSuccess && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ stored — encrypted, and the manager was nudged to pull it.</span>}
      </Panel>
    </div>
  );
}

// The shared submit row (decision / input): a primary button + a one-line explainer + a success flash.
function SubmitRow({ label, disabled, pending, success, onSubmit }:
  { label: string; disabled: boolean; pending: boolean; success: boolean; onSubmit: () => void }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button variant="primary" disabled={disabled || pending} onClick={onSubmit}>{pending ? "Submitting…" : label}</Button>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>Records your answer and nudges the manager to pull it.</span>
      </div>
      {success && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.phosphor }}>✓ answered — the manager was nudged to pull it.</span>}
    </>
  );
}

// ── RequestHistory — a searchable/filterable view of consumed requests ─────────────
// `openQuestions(true)` folds in the terminal (consumed) history. A console-style table with a search box
// + type/project/outcome/date filters. Clicking a row opens the same detail modal (read-only readout).
export function RequestHistory() {
  const questions = useQuery({ queryKey: ["openQuestions", "history"], queryFn: () => api.openQuestions(true), refetchInterval: 5000 });
  const [search, setSearch] = useState("");
  const [typeF, setTypeF] = useState<QuestionType | "all">("all");
  const [projF, setProjF] = useState<string>("all");
  const [outcomeF, setOutcomeF] = useState<"all" | "authorized" | "denied" | "answered" | "provided" | "cancelled" | "notice">("all");
  const [dateF, setDateF] = useState<"all" | "24h" | "7d" | "30d">("all");
  const [readF, setReadF] = useState<"all" | "unread">("all"); // Phase 2 of card 59fa6403
  const openRequest = useOpenRequest();
  const now = Date.now();

  const all = questions.data ?? [];
  // Terminal history = 'consumed' (answered + pulled), 'cancelled' (question_cancel/dismiss — never
  // answered at all, card feat(orchestration): question_cancel + dismiss), AND 'notice' (card 59fa6403 —
  // self-terminal at ask time, never answered either, but it's genuinely resolved history, not something
  // still waiting on the owner) — all three retained the same way, never a separate view. Unlike the
  // default "waiting on me" tab (db.listOpenQuestions' 7-day notice window), History shows EVERY notice
  // regardless of age — it's the one place an old notice is still reachable.
  const terminal = useMemo(() => all.filter((q) => q.state === "consumed" || q.state === "cancelled" || q.state === "notice"), [all]);
  const cancelledCount = useMemo(() => terminal.filter((q) => q.state === "cancelled").length, [terminal]);
  const noticeCount = useMemo(() => terminal.filter((q) => q.state === "notice").length, [terminal]);
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const q of terminal) m.set(q.projectId, q.projectName);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [terminal]);

  // Outcome bucket for a terminal request — drives the outcome filter. Checked BEFORE the per-type
  // branches: a cancelled request was never answered, so it must never fall into "answered"/"provided".
  // A notice (card 59fa6403) was likewise never answered — its own bucket, checked right after cancelled
  // and before any type branch, for the same reason.
  const outcomeOf = (q: QuestionInboxItem): "authorized" | "denied" | "answered" | "provided" | "cancelled" | "notice" =>
    q.state === "cancelled" ? "cancelled"
      : q.state === "notice" ? "notice"
        : q.type === "credential" ? "provided"
          : q.type === "permission" ? (q.chosenOption === "authorize" ? "authorized" : "denied")
            : "answered";
  const withinDate = (iso: string | null): boolean => {
    if (dateF === "all") return true;
    if (!iso) return false;
    const ms = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 }[dateF];
    return now - Date.parse(iso) <= ms;
  };
  // A cancelled row's "when" is cancelledAt (it has no answeredAt — never answered).
  const resolvedAt = (q: QuestionInboxItem): string | null => q.state === "cancelled" ? q.cancelledAt : q.answeredAt;
  const s = search.trim().toLowerCase();
  // `q.agentName` (card 24a8b8c3) names the IMMUTABLE FILER's agent, not whichever agent currently owns
  // the routing target — so searching by agent name matches "who asked this", surviving any recycle.
  const rows = terminal.filter((q) =>
    (typeF === "all" || q.type === typeF) &&
    (projF === "all" || q.projectId === projF) &&
    (outcomeF === "all" || outcomeOf(q) === outcomeF) &&
    (readF === "all" || isUnread(q)) &&
    withinDate(resolvedAt(q)) &&
    (s === "" || `${q.title} ${q.note ?? ""} ${q.chosenOption ?? ""} ${q.cancelledReason ?? ""} ${q.agentName} ${q.projectName}`.toLowerCase().includes(s)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionLabel style={{ margin: 0 }}>History ({terminal.length - cancelledCount - noticeCount} consumed{cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ""}{noticeCount > 0 ? ` · ${noticeCount} notice${noticeCount === 1 ? "" : "s"}` : ""})</SectionLabel>
      {/* filter bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search titles / answers / agents…"
          style={{ flex: "1 1 220px", minWidth: 180, ...textareaStyle, resize: undefined }} />
        <Select value={typeF} onChange={(e) => setTypeF(e.target.value as QuestionType | "all")}>
          <option value="all">all types</option>
          {REQUEST_TYPE_ORDER.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select value={projF} onChange={(e) => setProjF(e.target.value)}>
          <option value="all">all projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select value={outcomeF} onChange={(e) => setOutcomeF(e.target.value as typeof outcomeF)}>
          <option value="all">all outcomes</option>
          <option value="authorized">authorized</option>
          <option value="denied">denied</option>
          <option value="answered">answered</option>
          <option value="provided">provided</option>
          <option value="cancelled">cancelled</option>
          <option value="notice">notice (FYI)</option>
        </Select>
        <Select value={dateF} onChange={(e) => setDateF(e.target.value as typeof dateF)}>
          <option value="all">any time</option>
          <option value="24h">last 24h</option>
          <option value="7d">last 7 days</option>
          <option value="30d">last 30 days</option>
        </Select>
        <Select value={readF} onChange={(e) => setReadF(e.target.value as typeof readF)}>
          <option value="all">read + unread</option>
          <option value="unread">unread only</option>
        </Select>
      </div>

      {terminal.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No history yet — answered requests land here once the manager pulls them, and dismissed/cancelled ones land here too.</span></Panel>}
      {terminal.length > 0 && rows.length === 0 && <Panel><span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>No history matches your search.</span></Panel>}

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((q) => (
            <button key={q.id} onClick={() => openRequest(q.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", cursor: "pointer",
                background: color.panel, border: `1px solid ${color.border}`, borderLeft: `3px solid ${tone[REQUEST_TYPE_TONE[q.type]]}`,
                borderRadius: radius.sm, padding: "6px 10px" }}>
              <RequestTypeTag type={q.type} />
              <span style={{ flex: "2 1 200px", minWidth: 0, fontFamily: font.mono, fontSize: 12, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
              <span title={`${q.projectName} · ${requestProvenanceText(q)}`}
                style={{ flex: "1 1 170px", minWidth: 0, fontFamily: font.mono, fontSize: 11, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.projectName} · <RequestProvenance q={q} compact /></span>
              <span style={{ flex: "2 1 200px", minWidth: 0, fontFamily: font.mono, fontSize: 11, color: q.state === "cancelled" ? color.red : color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={requestOutcome(q)}>{requestOutcome(q)}</span>
              {q.taskId && <LinkedTaskChip taskId={q.taskId} columnKey={q.linkedTaskColumnKey} />}
              <span style={{ flexShrink: 0, fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{relativeAge(resolvedAt(q), now)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
