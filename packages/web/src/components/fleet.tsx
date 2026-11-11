import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, OrchestrationEvent } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { api } from "../lib/api";
import { attentionKindLabel, isRateLimited, isAnswerableRequest, usePendingDecisionsBySession, type AttentionItem, type PendingDecision } from "../lib/attention";
import { fleetRollup, workerBuckets, capArchived, ARCHIVED_ONLY_CAP, WAITING_ON_YOU, type ArchivedOnlyProject } from "../lib/fleet";
import { harnessOf } from "../lib/harnessFields";
import { eventKindLabel } from "../lib/eventLabels";
import { useActiveProject } from "../lib/activeProject";
import { sentenceCase } from "../lib/textCase";
import { DecisionStateChip } from "./decisions";
import { HarnessTag } from "./HarnessPicker";
import { useOpenRequest } from "./requests";
import { Panel, StatusPill, Chip, Meter, Button, Dot, Select } from "./ui";
import { color, font, radius, tone, toneFill, type Tone, fs } from "../theme";

// The pure roll-up math lives in lib/fleet.ts (JSX-free, so the hermetic node test can import it); the
// widgets re-export it so existing consumers (Overview) keep importing from the components/fleet barrel.
export { fleetRollup, workerBuckets };

// Shared FLEET widgets — the projects→managers→workers roll-up cards, fleet rows, plan-usage strip,
// attention rows, activity rows, and their roll-up helpers. Extracted from MissionControl (the
// god-eye view) so the project-scoped Overview page can compose the SAME widgets against a
// project-filtered session set. Pure presentation off existing endpoints; no new backend.

// A session's status pill. Precedence: rate-limited > not live > waiting on you (it holds a PENDING
// owner Request it filed: pass `waitingOnYou` from `usePendingDecisionsBySession().has(s.id)`) >
// working > idle. Without the flag a session blocked on the owner would read as green "idle".
export function sessionStatus(s: SessionListItem, waitingOnYou = false): { tone: Tone; label: string; glow?: boolean; solid?: boolean } {
  if (isRateLimited(s)) return { tone: "danger", label: "rate-limited" };
  if (s.processState !== "live") return { tone: "muted", label: s.processState };
  if (waitingOnYou) return { ...WAITING_ON_YOU };
  if (s.busy) return { tone: "work", label: "working", glow: true };
  return { tone: "live", label: "idle" };
}

export function Stat({ label, value, tone: t = "live" }: { label: string; value: number; tone?: Tone }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: "4px 12px", minWidth: 64 }}>
      <span style={{ fontFamily: font.mono, fontSize: fs.h1, color: tone[t] }}>{value}</span>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text3 }}>{sentenceCase(label)}</span>
    </span>
  );
}

/**
 * Card 51a80b4d — what AttentionRow needs to RENDER a row, which is strictly less than what
 * `useAttention` must produce. `notify` (the browser-notification category) is OPTIONAL here and
 * REQUIRED on `AttentionItem`, deliberately: the required field on `AttentionItem` is what guarantees
 * every alert that can raise a desktop notification also has a Settings toggle, but a caller that only
 * BORROWS this row shape to render something never routed through `useAttention` (today:
 * `MergeGateAttention` in components/mergeGate.tsx, which renders straight onto the project Home tab and never
 * reaches `useNewAttention`) has no notification to categorise. Forcing it to name one would ship a
 * toggle in Settings that silences nothing. A real `AttentionItem` satisfies this type, so the two
 * genuine callers (the Workspace and project Home tabs) are unaffected.
 *
 * ⚠️ If a render-only borrowing is ever wired INTO `useAttention`'s item list, it stops being render-only
 * and must gain a real `notify` kind (+ its Settings toggle) at that point.
 */
export type AttentionRowItem = Omit<AttentionItem, "notify"> & Partial<Pick<AttentionItem, "notify">>;

// Card 611e76ba, design rule 3 — the half of the dismiss tooltip that is true of EVERY kind, so the X
// can never read as "this resolves the thing". Dismissing is a VIEW action: it hides the row and stops
// its browser notification, and touches nothing else. Kept beside AttentionRow (the one renderer of the X)
// rather than in lib/attention, so a new dismissable row picks it up by rendering through this component.
// @decision 611e76ba — a dismiss hides the row and its notification, and changes nothing underneath.
const DISMISS_INVARIANT =
  "It only hides this alert and its notification — it never answers, cancels, or changes the underlying request, session, or board.";
// Used when a row supplies no `dismissHint` of its own. Deliberately generic: the old default described
// STUCK-BUSY's re-appearance rule specifically, which silently mis-described every other kind that
// borrowed it.
const DISMISS_FALLBACK_HINT = "Hide this alert — it comes back only if something new happens.";

/**
 * `footer` (card c2968651) — a SECOND line under the row's own one-line head, for a kind whose
 * action does not fit beside the text. A band column is ~300px, and the Atlas Needs-you band wants
 * a MERGE REQUEST's "Approve & merge" one click away rather than a navigation to /review/:id; that
 * button plus the row's kind label, text and dismiss cannot share one line at that width, so the
 * row stacks instead of ellipsising the thing the reader is scanning for. Same two-line grammar the
 * band's own operator/agent rows already use.
 *
 * ⛔ OPT-IN, and that is load-bearing. The classic surfaces (Mission Control, the project Overview)
 * pass no footer and get the EXACT single-`div` row they render today, children and all — they pull
 * MERGE REQUEST out of their attention list and render it as the rich Review-queue card instead, so
 * only Atlas ever renders a merge row through here at all.
 *
 * @decision c2968651 — never make the footer unconditional or item-derived. A classic attention row
 * must stay the one-line shape, with no wrapper element inserted around its children.
 */
export function AttentionRow({ item, onOpen, onDismiss, footer, compact }: {
  item: AttentionRowItem; onOpen?: () => void; onDismiss?: () => void; footer?: ReactNode; compact?: boolean;
}) {
  // A pending Request of ANY type (live or orphaned) reads as an answerable ask: a cyan left-edge, a
  // PENDING state chip, and an "Answer →" (not the generic "Open") — distinct from the phosphor MERGE
  // REQUEST and the red/amber alerts. Orphaned still routes to the same answer page (its own amber
  // tone/text already flags the asker is gone), just via item.tone rather than a hardcoded second border
  // color. Card 68f27faf round 3 (CR 7cbb6994, item 1): a self-terminal `notice` also carries `questionId`
  // (it's a Request row too — opening it marks it read) but is NOT answerable, so a bare `questionId !=
  // null` check wrongly rendered it as a PENDING ask with an "Answer →" button. `isAnswerableRequest`
  // (lib/attention.ts) is the one place that distinction lives — App.tsx's collapsed request pill reads
  // the SAME helper, so the two can never drift apart on what counts as answerable.
  const decision = isAnswerableRequest(item);
  // The row's parts, each named once and composed differently per shape below. Hoisting them is what
  // lets the `compact` band shape re-order the SAME children without a second copy of any of them —
  // and a fragment adds no DOM node, so the classic `head` below renders the element sequence it
  // always did, attributes and inline styles included.
  const dot = <Dot tone={item.tone} glow={item.tone === "attn"} />;
  const kindStyle = { fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: tone[item.tone], whiteSpace: "nowrap" } as const;
  const kindLabel = <span style={kindStyle}>{attentionKindLabel(item.kind)}</span>;
  const textBase = { fontSize: fs.sm, color: color.text2, overflow: "hidden", textOverflow: "ellipsis" } as const;
  /* `title` (card ed0858dc): the row ellipsizes, and some kinds carry detail too long for one line
     (the isolation-gap `reason` strings run to a paragraph each) — so hover reveals `hoverText` when
     a kind supplies it, else the full untruncated `text`. `text` still has to stand alone: a reader
     who never hovers must get the whole actionable point from the row itself. */
  const textSpan = (extra?: CSSProperties) => (
    <span data-testid="attention-row-text" title={item.hoverText || item.text}
      style={extra ? { ...textBase, ...extra } : textBase}>{item.text}</span>
  );
  const stateChip = decision && <DecisionStateChip q={{ state: "pending", answeredAt: null }} now={0} />;
  const clearRateLimit = item.rateLimitSessionId && <ClearRateLimitButton sessionId={item.rateLimitSessionId} />;
  const snooze = item.staleQuestionId && <SnoozeButton questionId={item.staleQuestionId} />;
  const openButton = onOpen && <Button variant={decision ? "primary" : "default"} onClick={onOpen}>{decision ? "Answer →" : "Open"}</Button>;
  /* Dismiss — passed whenever item.dismissKey is set, which since card 611e76ba is every kind the
     attention queue builds (owner ruling 2026-10-12: everything shown here must be hideable). The
     hover title is assembled from TWO halves: the item's own `dismissHint` names what makes THIS
     kind come back, and DISMISS_INVARIANT below states what dismissing does NOT do. The invariant
     is appended here, once, rather than restated by 18 builders that could each drift from it. */
  const dismissButton = onDismiss && (
    <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss this alert"
      title={`${item.dismissHint || DISMISS_FALLBACK_HINT} ${DISMISS_INVARIANT}`}
      style={{ padding: "0 6px", fontSize: fs.lg, lineHeight: 1, flex: "none" }}>×</Button>
  );
  const head = (
    <>
      {dot}
      {kindLabel}
      {textSpan()}
      <span style={{ flex: 1 }} />
      {stateChip}
      {clearRateLimit}
      {snooze}
      {openButton}
      {dismissButton}
    </>
  );
  // `data-*` hooks (card ed0858dc): an e2e assertion on an attention row has to be scoped to the row it
  // MEANS — the e2e daemon is shared, so a sibling spec's session renders a byte-identical row and a
  // text-matched locator would pass against the wrong data. Kind + session id make the scope explicit.
  const hooks = {
    "data-testid": "attention-row",
    "data-kind": item.kind,
    "data-session-id": item.sessionId ?? item.workerSessionId ?? "",
  };
  const frame = {
    border: `1px solid ${color.line}`,
    borderLeft: decision ? `3px solid ${color.attn}` : `1px solid ${color.line}`,
    borderRadius: radius.sm, padding: "6px 10px", marginBottom: 6,
  };
  // ── The BAND shape (card d0d430d4) ───────────────────────────────────────────────────────────
  // The one-line shape below cannot hold this row's fixed parts in a ~300px band column. Before this
  // card, on /home at 1600×1000: the action's box ended 21px past the band body's right edge, and the
  // text collapsed to 0px wide and 486px tall — one character per line — which pushed the merge rows
  // below the panel's fold at 420px. The band stacks instead: a head line carrying the title, then a
  // right-aligned action line. Same two-line grammar the band's own operator/agent rows use.
  //
  // @decision d0d430d4 — OPT-IN. The classic surfaces (Mission Control, the project Overview, the
  // merge-gate escalation) must keep the one-line shape below, with `head` as the frame's own direct
  // flex children and no wrapper element inserted around them.
  if (compact) {
    // Three lines (card 104a31a4): the head line (dot, kind, ×), then the ASK on its own full-width
    // line clamped to two, then the actions. Sharing the head line left the ask ~12 characters at
    // 1440; its own line shows ~60+. The head line never wraps: the kind label is what ellipsizes
    // (full kind on hover), and the × is `flex: none`, because dismissing is a VIEW action on the ROW
    // (see DISMISS_INVARIANT), not a sibling of its answer. The ask is indented under the kind label
    // (8px dot + 10px gap).
    //
    // @decision 104a31a4 — the ask keeps its own clamped line; never put it back beside the kind label.
    const actions = [stateChip, clearRateLimit, snooze, openButton].filter(Boolean);
    const kindText = attentionKindLabel(item.kind);
    return (
      <div {...hooks} style={{ display: "flex", flexDirection: "column", gap: 4, ...frame }}>
        <div style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 10, minWidth: 0 }}>
          {dot}
          <span data-testid="attention-row-kind" title={kindText}
            style={{ ...kindStyle, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{kindText}</span>
          {dismissButton}
        </div>
        {textSpan({
          display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2,
          whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.35, paddingLeft: 18, minWidth: 0,
        })}
        {actions.length > 0 && (
          <div data-testid="attention-row-actions"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, rowGap: 6 }}>
            {stateChip}
            {clearRateLimit}
            {snooze}
            {openButton}
          </div>
        )}
        {footer}
      </div>
    );
  }
  // No footer ⇒ the one-line row, with `head` as the frame's OWN direct flex children: the text's
  // ellipsis and the `flex: 1` spacer both measure against this element, so wrapping them in an
  // inner box unconditionally would change every classic row's layout for no reason.
  if (!footer) {
    return <div {...hooks} style={{ display: "flex", alignItems: "center", gap: 10, ...frame }}>{head}</div>;
  }
  // A footer with no `compact` — the generic slot shape. `flex-start`, not `center`: a footer exists
  // because the row's action did not fit beside its text, which means the text may wrap, and centring
  // would leave the kind pill floating against the middle of that block. No caller takes this path
  // today (the band passes `compact`, which stacks the actions as well), so it is the shape a FUTURE
  // non-band footer caller gets, not dead code for the band.
  return (
    <div {...hooks} style={{ display: "flex", flexDirection: "column", gap: 6, ...frame }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>{head}</div>
      {footer}
    </div>
  );
}

// Per-session "clear / retry now" for a RATE-LIMITED attention item — mirrors the global Clear-usage-
// hold button but scoped to one session: POST /api/sessions/:id/rate-limit/clear ends the park, drops
// the global latch, and re-submits the held turn. HUMAN-only REST (no agent MCP surface). On success
// we invalidate the session poll so the cleared row drops out of the queue promptly.
function ClearRateLimitButton({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const clear = useMutation({
    mutationFn: () => api.clearSessionRateLimit(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  return (
    <Button variant="default" disabled={clear.isPending}
      title="Clear this session's rate-limit park and re-submit its held turn now"
      onClick={() => clear.mutate()}>
      {clear.isPending ? "Clearing…" : "Clear / retry"}
    </Button>
  );
}

// Durable per-duration snooze for a DECISION STALE attention row (card 889ae619, iii-a) — POST
// /api/questions/:id/acknowledge with an absolute ISO `until` computed HERE (the route deliberately never
// interprets a relative duration itself, same contract as the permission-answer duration picker in
// requests.tsx). A SNOOZE, not a dismiss: `state` stays 'pending' and fully answerable — this only drops
// the row to ordinary cyan until `until`, and it RE-REDDENS on its own the instant that passes (attention.ts
// re-derives `stale` from `acknowledgedUntil` on every poll), so there's nothing to "undo" if forgotten.
const SNOOZE_MS: Record<string, number> = { "1d": 24 * 60 * 60 * 1000, "3d": 3 * 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000 };
function SnoozeButton({ questionId }: { questionId: string }) {
  const qc = useQueryClient();
  const snooze = useMutation({
    mutationFn: (ms: number) => api.acknowledgeQuestion(questionId, new Date(Date.now() + ms).toISOString()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["openQuestions"] }),
  });
  return (
    <Select disabled={snooze.isPending} defaultValue=""
      title="Snooze — hides this STALE flag for a while; the request itself stays pending and answerable, and it re-reddens on its own if still unanswered once the snooze ends"
      onChange={(e) => {
        const ms = SNOOZE_MS[e.target.value];
        if (ms) snooze.mutate(ms);
        e.target.value = "";
      }}
      style={{ fontSize: fs.sm, padding: "2px 6px" }}>
      <option value="" disabled>Snooze…</option>
      <option value="1d">1 day</option>
      <option value="3d">3 days</option>
      <option value="7d">7 days</option>
    </Select>
  );
}

// Context consumption for ONE session: occupancy of the model's window. Loom drives the subscription
// CLI, so this is token CONSUMPTION (% of context window), never a dollar bill — the figure that
// signals "this agent needs recycling soon", with the absolute token count for scale.
//
// This is the SINGLE renderer behind every surface that shows a session's context usage (Mission
// Control / Overview fleet rows, and the Archive page's session cards), so those surfaces can never
// drift on HOW it is computed: `ctxInputTokens` against `contextWindowForModel(model)`, hot at
// CONTEXT_WARN_RATIO. Two surfaces computing it two ways would disagree, and the quiet one is the one
// nobody notices is wrong.
//
// `unmeasured` is what renders when there is NO measurement at all (`ctxInputTokens == null` — a
// session that never completed a turn). An ABSENT measurement is not a measured zero, and must never
// render as an empty meter or `0%`. Live fleet rows pass nothing (a live session that hasn't reported
// yet is just noise on a dense row); the Archive passes an explicit dash, because an archived session
// is final, so "never measured" is real information there. A MEASURED zero still renders as a real 0%
// meter under both policies, so the two states stay distinguishable on screen — and measured zeros do
// occur in practice, they are not a hypothetical.
export function ContextUsage({ ctxInputTokens, model, unmeasured = null }: {
  ctxInputTokens?: number | null;
  model?: string | null;
  unmeasured?: ReactNode;
}) {
  if (ctxInputTokens == null) return <>{unmeasured}</>;
  const ctx = ctxInputTokens;
  const win = contextWindowForModel(model);
  const hot = ctx > win * CONTEXT_WARN_RATIO;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title={`${ctx.toLocaleString()} input tokens · ${Math.round((ctx / win) * 100)}% of the ${(win / 1000).toFixed(0)}k window`}>
      <Meter value={ctx} max={win} tone={hot ? "attn" : "accent"} width={60} />
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: hot ? color.attnText : color.text3 }}>{Math.round((ctx / win) * 100)}%</span>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3 }}>{(ctx / 1000).toFixed(1)}k</span>
    </span>
  );
}

export function FleetRow({ s, star }: { s: SessionListItem; star?: boolean }) {
  const openRequest = useOpenRequest();
  const decisions = usePendingDecisionsBySession();
  const decision = decisions.get(s.id);
  const st = sessionStatus(s, decisions.has(s.id));
  const ctx = s.ctxInputTokens ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text, fontWeight: star ? 700 : 400 }}>
        {star ? "★ " : ""}{star ? "mgr " : "w:"}{s.id.slice(0, 8)}
      </span>
      {/* Which vendor CLI this session actually runs — grouped with the id because it's an identity
          fact about the row, not a status. `null` (never pinned) and an explicit `"claude"` both read
          as claude here: the daemon keeps them distinct because it's a provenance question, but they
          spawn the same binary, so there is nothing for a fleet reader to act on between them.

          @decision b8e52cfe — the tag renders for codex always, and for claude only inside a
          MIXED-harness view, never unconditionally. */}
      <HarnessTag harness={harnessOf(s.harness)} />
      <StatusPill tone={st.tone} label={st.label} glow={st.glow} solid={st.solid} data-testid={`fleet-row-status-${s.id}`} />
      {/* Decision affordance (surface 5): a session holding a pending decision flags it inline + jumps
          straight to the answer page — derived from the SAME pending-decision signal as the inbox + bell.
          The status pill beside it already says "waiting on you", so this names only the count. */}
      {decision && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: fs.sm, color: color.attnText,
            border: `1px solid ${color.attn}`, borderRadius: radius.sm, padding: "1px 7px" }}>
            <Dot tone="attn" />{decision.count} decision{decision.count === 1 ? "" : "s"} pending
          </span>
          <Button variant="primary" style={{ padding: "1px 8px", fontSize: fs.sm }} onClick={() => openRequest(decision.questionId)}>Answer →</Button>
        </span>
      )}
      {s.taskId && <Chip label="task" value={s.taskId.slice(0, 8)} />}
      {s.branch && <Chip label="branch" value={s.branch} tone="muted" />}
      {/* A LIVE row hides both "no reading yet" AND a measured zero — neither is worth the width on a
          dense, fast-moving row (the Archive, where a session is final, treats them differently). */}
      {ctx > 0 && <ContextUsage ctxInputTokens={s.ctxInputTokens} model={s.model} />}
    </div>
  );
}

// ── Fleet summary (small mode) ─────────────────────────────────────────────────
// A FIXED-SIZE per-project card: a roll-up status, manager/worker counts, a worker-state
// composition bar, worst-case context pressure, and a hint of the busiest manager. Expands to the
// full FleetRow list. Same component kit + tokens as the rest of the page (no new color/chart deps).
// (fleetRollup + workerBuckets live in lib/fleet.ts — imported + re-exported above.)

// Worst-case context occupancy across the fleet (the session closest to its window) — the figure
// that signals "someone needs recycling soon". 0/0 when no session reports ctx.
export function worstContext(sessions: SessionListItem[]): { ctx: number; window: number; ratio: number } {
  let ctx = 0, window = 0, ratio = 0;
  for (const s of sessions) {
    const c = s.ctxInputTokens ?? 0;
    if (c <= 0) continue;
    const w = contextWindowForModel(s.model);
    const r = c / w;
    if (r > ratio) { ratio = r; ctx = c; window = w; }
  }
  return { ctx, window, ratio };
}

const SEG_TONE = { waiting: "attn", busy: "work", idle: "live", rl: "danger", offline: "muted" } as const;

// Stacked horizontal bar of worker states (flex-weighted by count). Degrades cleanly: 0 workers →
// an empty track; 1 worker → a single full segment.
function CompBar({ buckets }: { buckets: ReturnType<typeof workerBuckets> }) {
  const segs = ([["waiting", buckets.waiting], ["busy", buckets.busy], ["idle", buckets.idle], ["rl", buckets.rl], ["offline", buckets.offline]] as const)
    .filter(([, n]) => n > 0);
  return (
    <div style={{ display: "flex", height: 8, width: "100%", borderRadius: radius.sm, overflow: "hidden", background: color.line }}>
      {segs.map(([key, n]) => (
        <div key={key} title={`${key} ${n}`} style={{ flexGrow: n, flexBasis: 0, background: toneFill[SEG_TONE[key]] }} />
      ))}
    </div>
  );
}

export function FleetCard({ name, managers, workers, archived = [], attention, onExpand, muted }: {
  name: string;
  managers: SessionListItem[]; // activity-sorted by the caller
  workers: SessionListItem[];
  // The project's ARCHIVED (exited) sessions — ArchivedSessionListItem extends SessionListItem, so they
  // drop in as-is. Folded in (capped) as muted history so the card doesn't go blank right after a wave
  // auto-archives. Optional + defaulted, so every existing call site stays byte-identical when omitted.
  archived?: SessionListItem[];
  attention: number;
  onExpand: () => void;
  // A fully-archived project (zero live sessions) — de-emphasize the whole card so finished waves stay
  // glanceable without crowding the active fleet. A restrained lower-contrast treatment (opacity), not a
  // new visual language. Optional + defaulted-off, so live cards stay byte-identical.
  muted?: boolean;
}) {
  const openRequest = useOpenRequest();
  const decisions = usePendingDecisionsBySession();
  const running = [...managers, ...workers];
  // A session on this card holding a pending decision → the attn card affordance (surface 5). Managers
  // first (activity-sorted by the caller), then any other running session, so a session that can file a
  // Request is never missed because it is not a manager. The first one is the "Answer →" jump target.
  const mgrWithDecision = managers.find((m) => decisions.has(m.id)) ?? running.find((x) => decisions.has(x.id));
  const decision: PendingDecision | undefined = mgrWithDecision ? decisions.get(mgrWithDecision.id) : undefined;
  // Cap the archived rows folded into the card's buckets so a big archive can't dominate the composition
  // bar; the header below still reports the TRUE archived total. Archived rows are exited → offline bucket.
  const foldedArchived = capArchived(archived);
  const archivedWorkers = foldedArchived.filter((s) => s.role !== "manager");
  const roll = fleetRollup(running, decisions); // severity from live state only (see lib/fleet.ts)
  const buckets = workerBuckets([...workers, ...archivedWorkers], decisions);
  const wc = worstContext(running); // ctx pressure is a live recycle signal — finished sessions excluded
  const ctxHot = wc.ratio > CONTEXT_WARN_RATIO;
  const topMgr = mgrWithDecision ?? managers[0];
  const topSt = topMgr ? sessionStatus(topMgr, decisions.has(topMgr.id)) : null;

  return (
    <Panel style={{ height: 206, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden",
      ...(decision ? { borderLeft: `3px solid ${color.attn}` } : null), ...(muted ? { opacity: 0.6 } : null) }}>
      {/* header: roll-up dot + name + expand */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot tone={roll.tone} glow={roll.glow} />
        <span style={{ fontFamily: font.ui, fontSize: fs.body, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" style={{ padding: "0 6px" }} title="Expand" onClick={onExpand}>⤢</Button>
      </div>

      {/* running / archived split — the "both-in-one" summary. Archived reads as clearly secondary. */}
      <div style={{ fontSize: fs.sm, color: color.text3, whiteSpace: "nowrap" }}>
        running {running.length}
        {archived.length > 0 && <span style={{ color: color.text2 }}> · archived {archived.length}</span>}
      </div>

      {/* status + counts */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusPill tone={roll.tone} label={roll.label} glow={roll.glow} solid={roll.solid} />
        <span style={{ flex: 1 }} />
        {decision && <Chip label="decision" value={decision.count} tone="attn" />}
        <Chip label="mgr" value={managers.length} />
        <Chip label="wkr" value={workers.length} />
        {attention > 0 && <Chip label="attn" value={attention} tone="danger" />}
      </div>

      {/* worker-state composition bar + legend */}
      <CompBar buckets={buckets} />
      <div style={{ display: "flex", gap: 10, fontSize: fs.xs }}>
        {buckets.waiting > 0 && <span style={{ color: color.attnText }}>waiting {buckets.waiting}</span>}
        <span style={{ color: color.workText }}>working {buckets.busy}</span>
        <span style={{ color: color.liveText }}>idle {buckets.idle}</span>
        {buckets.rl > 0 && <span style={{ color: color.danger }}>rl {buckets.rl}</span>}
        {buckets.offline > 0 && <span style={{ color: color.text3 }}>off {buckets.offline}</span>}
        {buckets.total === 0 && <span style={{ color: color.text3 }}>no workers</span>}
      </div>

      {/* worst-case context pressure */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.xs, color: color.text3, width: 28 }}>ctx</span>
        <Meter value={wc.ctx} max={wc.window || 1} tone={ctxHot ? "attn" : "accent"} width={110} />
        <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: ctxHot ? color.attnText : color.text3 }}>
          {wc.ctx > 0 ? `${Math.round(wc.ratio * 100)}%` : "—"}
        </span>
      </div>

      {/* busiest / most-recent manager hint — a held decision takes over the footer with an Answer → jump */}
      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: fs.sm, color: color.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {topMgr && topSt
            ? <>★ mgr <span style={{ fontFamily: font.mono }}>{topMgr.id.slice(0, 8)}</span> · <span style={{ color: decision ? color.attnText : tone[topSt.tone] }}>{decision ? "waiting on you" : topSt.label}</span></>
            : <span style={{ color: color.text3 }}>no live manager</span>}
        </div>
        {decision && (
          <Button variant="primary" style={{ padding: "1px 8px", fontSize: fs.sm, flexShrink: 0 }}
            onClick={() => openRequest(decision.questionId)}>Answer →</Button>
        )}
      </div>
    </Panel>
  );
}

// ── The inactive-projects tier ──────────────────────────────────────────────────────────────────
// The finished-wave tier of the fleet. Every project here has zero live sessions (present only in the
// archive), so a fleet derived from the RUNNING set would drop it entirely; each one surfaces as a MUTED
// FleetCard so past waves stay glanceable. The user calls these "inactive" (owner's wording) — NOT
// "archived": that word is reserved for the separate, reversible soft-archive "Archived" section (card
// baca1835), a genuinely different project state.
//
// Kept OUT of the way per the owner's constraint: collapsed behind a "N inactive project(s)" affordance
// AND, once open, capped at ARCHIVED_ONLY_CAP cards (the affordance still reports the true total) so
// inactive history can never crowd an active fleet above it.
//
// @decision ff6123de — `defaultOpen` stays defaulted OFF: Mission Control mounts this UNDER its live
// fleet grid, and an expanded strip there pushes the active fleet off the fold. Only a host with
// nothing above it to protect may pass it.
export function InactiveFleet({ projects, defaultOpen = false }: {
  projects: ArchivedOnlyProject[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (projects.length === 0) return null;
  const shown = projects.slice(0, ARCHIVED_ONLY_CAP);
  const overflow = projects.length - shown.length;
  return (
    <div style={{ marginTop: 12 }}>
      {/* The testid sits on the TOGGLE, not the wrapper: `aria-expanded` lives here, and this is the one
          button in the strip that is unambiguous whether it is open (when the cards add their own) or
          shut. The card list carries its own id below. */}
      <Button variant="ghost" onClick={() => setOpen((v) => !v)}
        data-testid="inactive-fleet"
        aria-expanded={open}
        title={open ? "Hide inactive projects" : "Show inactive projects"}
        style={{ fontSize: fs.sm, color: color.text3, padding: "2px 6px" }}>
        {open ? "▾" : "▸"} {projects.length} inactive project{projects.length === 1 ? "" : "s"}
      </Button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, alignItems: "start", marginTop: 8 }}
          data-testid="inactive-fleet-list">
          {shown.map((p) => (
            <FleetCard key={p.name} name={p.name} managers={[]} workers={[]} archived={p.archived}
              attention={0} onExpand={() => { /* no live sessions to expand into */ }} muted />
          ))}
          {overflow > 0 && (
            <span style={{ alignSelf: "center", fontSize: fs.sm, color: color.text3 }}>
              +{overflow} more inactive
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// The w:/t: tokens inherit the row's colour and mono face; the underline is what marks them as links.
const eventTokenLink: CSSProperties = { color: "inherit", textDecoration: "underline", textDecorationColor: color.line, textUnderlineOffset: 2 };

// `projectName` — the owning project of this event. Optional + only passed at the god-eye Mission Control
// call-site, where rows from every active project interleave and need attribution; the project-scoped
// Overview feed omits it (all its rows already belong to the one project on screen), so that surface stays
// byte-identical. Rendered as a small muted chip in a stable second column so it reads as scannable
// attribution, truncating instead of shoving the event kind off the row.
//
// @decision a7957bde — the columns give in a fixed order (detail, then project chip, then kind) and the
// timestamp never gives at all. Do not flatten the flexShrink weights, do not drop any column's
// minWidth + overflow + textOverflow trio, and do not make the row wrap.
//
// Card 99b98864: the kind column shows a plain-English label (lib/eventLabels.ts); the raw kind stays on
// its `title` and `data-event-kind`. The `w:`/`t:` tokens are links — the worker to its session node, the
// card to its board drawer. A card is project-scoped, so `projectId` (the event's own project, passed by
// the cross-project feeds) is made active before the board opens; project-scoped feeds omit it because
// the active project already IS the event's project. The detail column's text content and `title` are
// unchanged (`w:<id8> t:<id8>`), so its existing identity filters keep matching.
export function EventRow({ e, projectName, projectId }: { e: OrchestrationEvent; projectName?: string; projectId?: string }) {
  const workerToken = e.workerSessionId ? `w:${e.workerSessionId.slice(0, 8)}` : "";
  const taskToken = e.taskId ? `t:${e.taskId.slice(0, 8)}` : "";
  const detail = `${workerToken}${taskToken ? ` ${taskToken}` : ""}`;
  const label = eventKindLabel(e.kind, e.detail);
  const active = useActiveProject();
  const navigate = useNavigate();
  const openCard = (ev: MouseEvent) => {
    if (!e.taskId || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    if (projectId) active.setProjectId(projectId);
    navigate(`/board?task=${encodeURIComponent(e.taskId)}`);
  };
  return (
    <div data-testid="activity-event"
      style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: font.mono, fontSize: fs.sm, padding: "2px 0", borderBottom: `1px solid ${color.line}` }}>
      <span data-testid="activity-event-time" style={{ color: color.text3, whiteSpace: "nowrap", flexShrink: 0 }}>
        {new Date(e.ts).toLocaleTimeString()}
      </span>
      {projectName && (
        <span title={projectName} data-testid="activity-event-project"
          style={{ flexShrink: 1000, minWidth: 0, maxWidth: 116, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            fontSize: fs.xs, color: color.text3, border: `1px solid ${color.line}`, borderRadius: radius.sm, padding: "0 5px" }}>
          {projectName}
        </span>
      )}
      <span title={e.kind} data-testid="activity-event-kind" data-event-kind={e.kind}
        style={{ color: color.text2, whiteSpace: "nowrap", flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      <span title={detail || undefined} data-testid="activity-event-detail"
        style={{ color: color.text2, whiteSpace: "nowrap", flexShrink: 100000, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {workerToken && (
          <Link to={`/session/${e.workerSessionId}`} data-testid="activity-event-worker-link"
            title={`Open worker session ${e.workerSessionId}`} style={eventTokenLink}>{workerToken}</Link>
        )}
        {taskToken && (
          <>
            {workerToken ? " " : ""}
            <Link to={`/board?task=${encodeURIComponent(e.taskId!)}`} onClick={openCard} data-testid="activity-event-task-link"
              title={`Open card ${e.taskId} on the board`} style={eventTokenLink}>{taskToken}</Link>
          </>
        )}
      </span>
    </div>
  );
}
