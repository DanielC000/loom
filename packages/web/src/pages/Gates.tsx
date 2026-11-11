import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import type { GateRun, GateHistoryRow, GateType, GateOutcome, TaskPriority } from "@loom/shared";
import { api } from "../lib/api";
import { useFrameOwnsNodeIdentity } from "../lib/atlasNodeHead";
import { Panel, Button, SectionLabel } from "../components/ui";
import { color, font, radius, space, wash, fs } from "../theme";

// Gates page (card a1c86452) — the god-eye view of Loom's daemon-executed gates (merge, worker run_gate,
// deploy) across every project, all serialized through ONE daemon-global GateSemaphore. Owner-approved
// HYBRID: Direction 1's active-gate LANE-HERO on top (the semaphore lane + its queue, with the P-behind-P
// head-of-line block called out) + Direction 2's settled HISTORY table below. Its own per-project filter
// (default ALL). Reads two read-only endpoints: /api/gates/active (the live registry snapshot) and
// /api/gates/history (paginated settled events). Matches the mockup set at Mockups/2026-07-21 Gates Page.

const HISTORY_PAGE = 50;

// ── time helpers ──────────────────────────────────────────────────────────────
// A 1s tick so the running/queued elapsed clocks advance live (the lane-hero's amber elapsed + queue wait).
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// "7m 41s" / "44s" — an elapsed/duration in whole seconds, tabular for a steady clock.
function fmtSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}m ${String(ss).padStart(2, "0")}s` : `${ss}s`;
}
function fmtDurationMs(ms: number | null): string {
  return ms == null ? "—" : fmtSeconds(ms / 1000);
}
// "4m ago" / "2h 5m ago" / "just now" — a coarse relative time for a settled row.
function relTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const remM = min % 60;
  if (hr < 24) return remM > 0 ? `${hr}h ${remM}m ago` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ── gate-type + outcome + priority styling (kept on the existing token palette) ──
const KIND_COLOR: Record<GateType, string> = { merge: color.text2, deploy: color.text2, worker: color.text2 };
const KIND_LABEL: Record<GateType, string> = { merge: "merge", deploy: "deploy", worker: "worker" };
// "cancelled" (card 3a6f04cc) gets its OWN neutral cyan, matching Board.tsx's own cancelled-outcome tone
// for a pending-merge cancel — it must never read as a failure (red), since no verdict was reached.
// "skipped" (card db9b0130) shares that same cyan info tone — also a non-verdict (an inert-diff merge
// gate that never spawned), distinct from cancelled only in WHY nothing ran, not in whether it's a failure.
// "error" (card cee17efe) is a FOURTH non-verdict, amber rather than red or cyan: the dist-importer
// advisory's own machinery broke (a bad cut/build/scan), never a real test red and never a withdrawal.
const OUTCOME_COLOR: Record<GateOutcome, string> = { pass: color.live, reject: color.danger, timeout: color.danger, kill: color.danger, cancelled: color.text2, skipped: color.text2, error: color.attnText };
const OUTCOME_GLOW: Record<GateOutcome, boolean> = { pass: false, reject: false, timeout: true, kill: true, cancelled: false, skipped: false, error: false };
const PRIORITY_RANK: Record<TaskPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const PRIORITY_COLOR: Record<TaskPriority, string> = { p0: color.danger, p1: color.danger, p2: color.text3, p3: color.text3 };

// ── non-run rows (card 04cef8d7) ────────────────────────────────────────────────
// `gateRan:false` (card 3a6f04cc) means no gate PROCESS ever spawned for this op. Such a row still
// carries a `durationMs`, and that number is REAL — it just measures the wrong thing: op overhead
// (the reuse-proof git calls, queue/admission bookkeeping), never gate execution. Rendered plain
// beside a real run's duration it silently contaminates the one question this table exists to answer
// ("is the gate floor climbing?") — the exact contamination the agent-facing `gate_history` tool
// description already warns agents against, leaving an agent and a human to read the same rows and
// reach different conclusions with nothing on screen to explain why. So the row STAYS (it is a real
// event; hiding it would only create a different blindness) and only its DURATION is de-emphasised:
// parenthesised + muted, with a cyan "no gate ran" marker (cyan is this page's established
// non-verdict/info tone, so the marker never reads as a failure) and a per-row reason on hover.
const NON_RUN_LABEL = "no gate ran";
const NON_RUN_NOTE =
  "This duration is a real number, but it measures op overhead (reuse checks, queue and git bookkeeping), not gate execution. Leave this row out of a gate-duration trend.";
// Derived from `outcome`, which is the only signal this row carries about WHY nothing spawned:
// "skipped" is inert-diff by construction (card db9b0130), "cancelled" is a withdrawal before a
// process started (card 3a6f04cc), and a "pass" that never ran is a reused worker self-check — the
// only remaining producer. Anything else falls back to the reason-free note rather than guessing.
function nonRunReason(outcome: GateOutcome, skipReason?: string | null): string {
  // Card e8df2659: a human-only "merge gate off" landing is NOT an inert docs-only skip — say which it was.
  if (outcome === "skipped" && skipReason === "gate-disabled") return "The project's merge gate is switched OFF, so the merge landed without running the gate (not a pass).";
  // Card 87798130: an interval skip is neither of the above. The merge-gate interval let this landing through
  // ungated because it was not its turn to run the real gate.
  if (outcome === "skipped" && skipReason === "gate-interval") return "The merge-gate interval let this landing through ungated: it was not this landing's turn to run the gate (not a pass).";
  if (outcome === "skipped") return "The merge diff was proven inert, so the gate was never attempted.";
  if (outcome === "cancelled") return "This run was withdrawn before a gate process spawned.";
  if (outcome === "error") return "The check's own scan/build/run machinery failed before it could reach a verdict — not a real test red.";
  if (outcome === "pass") return "This merge reused an already-green worker self-check.";
  return "No gate process spawned for this run.";
}

// ── override landings (card 87798130, owner pick B · Disclosure, request 0b1a2240) ──────────────
// `overrideReason` is the manager's own free text for landing an interval-skipped merge although the
// branch's own run_gate self-check was red on that tip (card 4a95e9fc). It is RECORDED, never verified,
// and the landing never counts as a pass. The row carries an amber outlined `override` chip, the same
// shape as ForfeitTag (amber: a human should look; not red, since nothing failed in THIS row). The chip
// is a real button that discloses the detail panel below the row, so the reason is one click away and
// always labelled with who wrote it and that Loom did not check it.
const OVERRIDE_LABEL = "override";
const OVERRIDE_NOTE =
  " marks a merge that landed without its gate although the branch's own run_gate self-check was red on that exact commit. The merging manager wrote the reason when it confirmed the merge. Loom stores the text as written and does not check it, and the landing never counts as a pass.";

function OverrideChip() {
  return (
    <span
      style={{
        fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, padding: "1px 5px", borderRadius: radius.sm, border: `1px solid ${color.attn}`, color: color.attnText, flex: "none", lineHeight: 1.45,
      }}
    >
      {OVERRIDE_LABEL}
    </span>
  );
}

// ── batched merge gates (card 10fd660b) ─────────────────────────────────────────
// A batched merge (`merge_batch`) lands N worker branches under ONE gate, so it has NO single branch:
// its row/run carries `branch: null` + `taskId: null` BY DESIGN, and that null pair is the batch
// signature other readers already key on. Rendering a batch off `branch` therefore degraded three
// different ways at once - the lane hero dropped its identity line entirely, the queue card fell
// through to the bare agent name, and the history table printed a bare em-dash, which is exactly what a
// broken/missing-data row looks like. All three now read the batch fields instead and share ONE chip,
// so a batch is recognisable at a glance wherever it appears. Nothing here synthesizes a branch name.
const BATCH_LABEL = "batch";

// The identity line a batch gets INSTEAD of a branch name: "3 branches" / "3 of 4 branches".
// `landed` is the POST-ASSEMBLY count and `requested` is `batchBranches.length` - two DIFFERENT numbers
// (a conflict can drop a branch while the batch is assembled), so the fraction is shown only when they
// actually differ, and neither is ever derived from the other (card cf0e2e3b's denominator trap).
function batchSummary(landed: number | null, requested: number | null): string {
  const branches = (n: number) => `${n} branch${n === 1 ? "" : "es"}`;
  if (landed == null) return requested == null ? "batched merge" : `${branches(requested)} requested`;
  if (requested != null && requested > landed) return `${landed} of ${branches(requested)}`;
  return branches(landed);
}

// A FILLED micro-chip, deliberately not a second outlined one: this page's outlined chips (kind,
// priority) answer "what sort of run is this", and a batch marker answers "what is this run's subject" -
// it belongs on the identity line, reading as a label rather than competing with the kind tag beside it.
function BatchTag() {
  return (
    <span style={{
      fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, padding: "1px 5px", borderRadius: radius.sm, background: color.surface2, color: color.text2, flex: "none",
    }}>
      {BATCH_LABEL}
    </span>
  );
}

// The one-line batch identity shared by BOTH active-lane sites (the running hero and the queued card).
// The branch names ride in the title so the count never has to widen a width-constrained lane card.
function BatchIdentity({ landed, branches, style }: { landed: number | null; branches: string[] | null; style?: CSSProperties }) {
  return (
    <div
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, fontFamily: font.ui, fontSize: fs.sm, color: color.text2, ...style }}
      title={branches && branches.length > 0 ? `Branches in this batch:\n${branches.join("\n")}` : undefined}
    >
      <BatchTag />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{batchSummary(landed, branches?.length ?? null)}</span>
    </div>
  );
}

// The always-visible half of the batch affordance, mirroring NON_RUN_NOTE's own pattern: the per-row chip
// says WHICH rows, this says what an empty Branch cell means. Shown only while a batched row is loaded.
const BATCH_NOTE =
  "lands several worker branches under one gate, so it has no single branch to name. Expand the count to see which branches went in.";

// ── wholesale batch forfeit (card b480dda9) ──────────────────────────────────────
// A batched merge's own gate can genuinely PASS while the whole batch still lands ZERO branches: main
// advanced mid-gate, so the assembled tree went stale before the post-gate fast-forward, and every
// candidate fell back to its own individual gate instead. `outcome`/`passed` on this row stay a real
// "pass" — the gate itself wasn't wrong — so without a distinct marker this reads as an ordinary green
// K=N batch for a run that actually landed nothing. This tag is that annotation, on the SAME row (never
// a second one): amber, not red/phosphor, since it isn't a gate failure, and shown ONLY when
// `batchForfeited` is true — an ordinary batch that landed all N renders with no tag at all, unchanged.
const FORFEIT_LABEL = "forfeited";
const FORFEIT_NOTE =
  "This batch's own gate passed, but main advanced while it ran — the assembled tree went stale before it could land, so nothing from this run actually merged. Every candidate branch fell back to its own individual gate (look for it among the surrounding rows).";

function ForfeitTag() {
  return (
    <span
      style={{
        fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, padding: "1px 5px", borderRadius: radius.sm, border: `1px solid ${color.attn}`, color: color.attnText, flex: "none",
      }}
      title={FORFEIT_NOTE}
    >
      {FORFEIT_LABEL}
    </span>
  );
}

// ── batch FALLBACK merges (card 4cacc6f9) ────────────────────────────────────────
// When a `merge_batch` can't land its candidates together it re-tries each one AUTOMATICALLY as an
// ordinary per-branch merge: a red gate or a forfeit sends every chosen candidate down that path, and
// even a green batch sends its dropped / over-cap / stranded ones. Each spawned run then registers as a
// perfectly normal solo merge — a real branch, a real task, that worker's own label — so nothing about
// the row itself said where it came from. A human watching a batch fall back saw up to K merge rows
// appear at once, unexplained and with no stated relationship to each other: the exact confusion card
// 19256231 closed for a MANAGER reading `gate_queue`, left in place here for the owner.
//
// `GateRun.fallbackOfBatchOpId` carries the PARENT BATCH's opId on every such row (`null` on everything
// else), so rows sharing one value are one group — that is what the group callout below counts, and it
// is why the id is rendered as a shared attribution rather than a per-row identifier.
const FALLBACK_LABEL = "fallback";

// The batch opId shortened to the 8-char prefix Loom displays — and ACCEPTS — everywhere else
// (`gate_status`, `tasks_get`, the board). Long enough to correlate this row against the batch's own
// gate row or settle nudge, short enough to sit on a width-constrained lane card. A bare full uuid on
// screen helps nobody who wasn't already holding it, which is the whole point of the field.
const shortOpId = (opId: string) => opId.slice(0, 8);

const FALLBACK_NOTE = (opId: string) =>
  `Spawned automatically by batch ${shortOpId(opId)}.\n\n`
  + "A batched merge falls back to merging its candidates ONE BRANCH AT A TIME — every candidate when "
  + "the batch itself was rejected or forfeited, and any dropped / over-cap / stranded candidate even "
  + "when it passed. Each retry runs as an ordinary solo merge with its own branch and its own gate, "
  + "which is why it looks like an unrelated merge without this tag.";

// An OUTLINED cyan chip, matching ForfeitTag's shape rather than BatchTag's fill: like the forfeit tag
// this annotates a run's CIRCUMSTANCE, and cyan is this design system's "info / metadata" tone — a
// fallback row is provenance to read, never a fault to alarm about.
function FallbackTag({ opId }: { opId: string }) {
  return (
    <span
      title={FALLBACK_NOTE(opId)}
      style={{
        fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, padding: "1px 5px", borderRadius: radius.sm, border: `1px solid ${color.lineStrong}`, color: color.text2, flex: "none",
      }}
    >
      {FALLBACK_LABEL}
    </span>
  );
}

// The per-row attribution line shared by BOTH active sites (the running lane hero and the queued card).
// It states the RELATIONSHIP in words — "from batch 07520fa5" — never a bare id: the id alone is only
// legible to a reader who already knew what they were looking at.
function FallbackIdentity({ opId, style }: { opId: string; style?: CSSProperties }) {
  return (
    <div
      title={FALLBACK_NOTE(opId)}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: fs.sm, color: color.text2, ...style }}
    >
      <FallbackTag opId={opId} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        from batch <span style={{ fontFamily: font.mono }}>{shortOpId(opId)}</span>
      </span>
    </div>
  );
}

// Group the runs CURRENTLY ON SCREEN by their parent batch. Fed from the same `running`/`queued` arrays
// the lanes and queue cards render, so the callout's count can never claim a row the reader can't see.
// ⚠️ Deliberately NOT a claim about the batch's total candidate count: `runFallback` spawns these
// sequentially, so at any instant some siblings may not exist yet and earlier ones may already have
// settled. The callout says so rather than implying "N of N".
function fallbackGroups(running: GateRun[], queued: GateRun[]): { opId: string; running: number; queued: number }[] {
  const byOp = new Map<string, { opId: string; running: number; queued: number }>();
  const add = (gates: GateRun[], key: "running" | "queued") => {
    for (const g of gates) {
      if (!g.fallbackOfBatchOpId) continue;
      const e = byOp.get(g.fallbackOfBatchOpId) ?? { opId: g.fallbackOfBatchOpId, running: 0, queued: 0 };
      e[key] += 1;
      byOp.set(g.fallbackOfBatchOpId, e);
    }
  };
  add(running, "running");
  add(queued, "queued");
  return [...byOp.values()];
}

// A long-running lane cue mirroring the mockup: the running lane's elapsed clock is amber while healthy
// and flips to RED once a gate has consumed this FRACTION of its OWN project's resolved
// `gateCommandTimeoutMs` (surfaced per row as `GateRun.gateTimeoutMs`).
//
// ⚠️ The two fractions are NOT the same measurement and must not be read as one: the daemon's is a single
// STEP's duration; this one is the WHOLE RUN's elapsed time since admission (worktree prep + every step).
// Whole-run elapsed is always ≥ the worst step, so on a project with a heavy build step this fires EARLIER
// relative to the daemon's signal. That is the safe direction for a warning, not an equivalence.
//
// @decision fd9edb87 — the warn threshold is a FRACTION of the row's own per-project
// gateCommandTimeoutMs, never a page-level fixed-seconds constant; the healthy band APPEARS
// to scale with batch size K — retune per-K, never widen one band to cover every K.
const LONG_RUN_WARN_FRACTION = 0.80;

/** The per-ROW long-run verdict for a running gate: `warn` flips its elapsed clock from work to red once
 *  the run has consumed {@link LONG_RUN_WARN_FRACTION} of THAT row's own project bound.
 *  A row whose `gateTimeoutMs` is `null` (the project row was unreadable — see `GateRun.gateTimeoutMs`)
 *  NEVER warns: there is ⛔ deliberately no fallback constant, because an unknown bound cannot say whether
 *  a run is long, and inventing one is exactly the information-free warning this replaced. `title` always
 *  states which case it is, so the colour is never mute about why. */
function longRunCue(elapsedSec: number, gateTimeoutMs: number | null): { warn: boolean; title: string } {
  if (gateTimeoutMs == null || gateTimeoutMs <= 0) {
    return {
      warn: false,
      title: "This project's gate timeout is unknown, so there is no bound to measure this run against — the clock never turns red however long it runs.",
    };
  }
  const fraction = (elapsedSec * 1000) / gateTimeoutMs;
  const warn = fraction >= LONG_RUN_WARN_FRACTION;
  return {
    warn,
    title: `${Math.round(fraction * 100)}% of this project's ${fmtSeconds(gateTimeoutMs / 1000)} gate timeout`
      + (warn ? " — this lane is close to its bound." : "."),
  };
}

export default function Gates() {
  const now = useNow();
  // Filter is a projectId, or "*" for ALL (default). Kept in component state (not the URL) — the page is a
  // god-eye view, not the header-picker-scoped kind.
  const [filter, setFilter] = useState<string>("*");

  const projects = useQuery({ queryKey: ["projects"], queryFn: ({ signal }) => api.projects(signal) });
  const active = useQuery({
    queryKey: ["gates-active"],
    queryFn: ({ signal }) => api.gatesActive(signal),
    refetchInterval: 2000, // the live lane occupancy changes as gates are admitted/settle
  });
  const history = useInfiniteQuery({
    queryKey: ["gates-history", filter],
    queryFn: ({ pageParam, signal }) =>
      api.gatesHistory({ projectId: filter === "*" ? undefined : filter, limit: HISTORY_PAGE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // Poll ONLY while a single page is loaded — refetching an infinite query re-runs every loaded page, so
    // stop polling once the user has paged (mirrors the archived-sessions pagination pattern).
    refetchInterval: (q) => ((q.state.data?.pages.length ?? 1) <= 1 ? 5000 : false),
  });

  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.name);
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [projects.data]);

  const cap = active.data?.cap ?? 1;
  const globalActive = active.data?.activeCount ?? 0;
  const globalQueued = active.data?.queuedCount ?? 0;
  const gates = active.data?.gates ?? [];
  const shownGates = filter === "*" ? gates : gates.filter((g) => g.projectId === filter);
  const running = shownGates.filter((g) => g.phase === "running");
  const queued = shownGates
    .filter((g) => g.phase === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));

  const historyRows = history.data?.pages.flatMap((p) => p.items) ?? [];
  const historyTotal = history.data?.pages[0]?.total ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(4) }}>
      <PageHead cap={cap} activeCount={globalActive} queuedCount={globalQueued} />

      <ProjectFilter
        projects={(projects.data ?? []).map((p) => ({ id: p.id, name: p.name }))}
        value={filter}
        onChange={setFilter}
      />

      <section>
        <SectionLabel style={{ margin: `0 0 ${space(3)}` }}>Active · Lane occupancy</SectionLabel>
        <LaneHero
          cap={cap}
          globalActive={globalActive}
          globalQueued={globalQueued}
          running={running}
          queued={queued}
          filterLabel={filter === "*" ? null : projectName(filter)}
          loading={active.isLoading}
          now={now}
        />
      </section>

      <section>
        <SectionLabel style={{ margin: `0 0 ${space(3)}` }}>
          History <span style={{ color: color.text3, fontWeight: 400 }}>· {historyTotal} run{historyTotal === 1 ? "" : "s"}</span>
        </SectionLabel>
        <HistoryTable
          rows={historyRows}
          now={now}
          loading={history.isLoading}
          error={history.isError}
          projectName={projectName}
        />
        {history.hasNextPage && (
          <div style={{ marginTop: space(3) }}>
            <Button onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
              {history.isFetchingNextPage ? "Loading…" : `Load more (${historyRows.length} of ${historyTotal})`}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Page header — title + subtitle + the global semaphore occupancy lamps ────────
// Inside the Atlas frame the title + subtitle go: the frame's crumbs, node head and tab row already
// name this node (card a7f23a2f). Under the classic shell the whole head is unchanged.
//
// THE LAMPS GO WITH THEM, INSIDE THE FRAME ONLY — and that reverses what card a7f23a2f's own record
// says ("nothing above the page carries them", so card 5968d7e0 would move them into the node head).
// That premise expired when card 7874e8c2 landed in between: the KPI strip now rides every node tab
// but Overview, and this page is a node TAB, so the row ~40px above it already reads
// `<running>·<queued> GATE RUN·QUEUED` from the same GateSemaphore. Measured at 1440 before this
// change: strip `0·0 GATE RUN·QUEUED`, lamps `0 / 1 LANE BUSY` + `0 QUEUED`, and the Semaphore panel
// in the body below reading `0 of 1 lane busy · 0 queued · maxConcurrentGates 1` — the same occupancy
// three times on one screen. Moving the lamps UP would have closed the gap to ~60px rather than
// removed the repeat. Nothing is lost: that Semaphore line is a strict superset of the two lamps (it
// names the cap as well), and it is unconditional.
//
// @decision 5968d7e0 — do not re-add these lamps inside the Atlas frame, and do not move them into
// the node head. The node's own KPI strip carries running·queued on this very tab row.
function PageHead({ cap, activeCount, queuedCount }: { cap: number; activeCount: number; queuedCount: number }) {
  const laneTone = activeCount > 0 ? color.work : color.lineStrong;
  // The whole head, lamps included, is the classic shell's. Inside the frame it renders nothing at
  // all — so this page starts on its filter row, exactly as every other re-homed tab body does.
  if (useFrameOwnsNodeIdentity()) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: space(4), flexWrap: "wrap" }}>
      <div data-testid="page-identity">
        <h1 style={{ fontFamily: font.ui, fontWeight: 600, fontSize: fs.h1, margin: 0, color: color.text }}>
          Gates
        </h1>
        <div style={{ color: color.text2, fontSize: fs.sm, marginTop: 2 }}>
          Every gate serializes through the GateSemaphore — {cap} lane{cap === 1 ? "" : "s"} by default
        </div>
      </div>
      <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: space(4) }}>
        <Lamp color={laneTone} glow={activeCount > 0} label={`${activeCount} / ${cap} lane${cap === 1 ? "" : "s"} busy`} />
        <Lamp color={queuedCount > 0 ? color.text3 : color.lineStrong} label={`${queuedCount} queued`} />
      </div>
    </div>
  );
}

function Lamp({ color: c, glow, label }: { color: string; glow?: boolean; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: fs.sm, color: color.text2 }}>
      <span style={{ width: 8, height: 8, borderRadius: radius.base, background: c, ...(glow ? { boxShadow: `0 0 6px ${c}` } : null) }} />
      {label}
    </span>
  );
}

// ── Per-project filter — All + one chip per project (active = phosphor) ──────────
function ProjectFilter({
  projects, value, onChange,
}: {
  projects: { id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const chips = [{ id: "*", name: "All" }, ...projects];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, marginRight: 4 }}>
        Project
      </span>
      {chips.map((c) => {
        const on = value === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            aria-pressed={on}
            className="loom-btn"
            style={{
              cursor: "pointer",
              fontSize: fs.sm,
              padding: "3px 10px",
              borderRadius: radius.base,
              border: `1px solid ${on ? color.accentEdge : color.line}`,
              color: on ? color.accentFg : color.text2,
              background: on ? color.selected : "transparent",
            }}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

// ── The lane-hero (Direction 1): the semaphore lane(s) holding running gates + the queue beside them ──
function LaneHero({
  cap, globalActive, globalQueued, running, queued, filterLabel, loading, now,
}: {
  cap: number;
  globalActive: number;
  globalQueued: number;
  running: GateRun[];
  queued: GateRun[];
  filterLabel: string | null;
  loading: boolean;
  now: number;
}) {
  // Head-of-line block: a queued gate strictly MORE urgent than a gate currently holding a lane. This is
  // the exact pain the owner wanted rendered (a P1 merge stuck behind a P3 worker self-check).
  const holGate = queued.find(
    (q) => q.priority != null && running.some((r) => PRIORITY_RANK[q.priority!] < PRIORITY_RANK[r.priority ?? "p3"]),
  );
  const holBlocker = holGate
    ? running.find((r) => PRIORITY_RANK[holGate.priority!] < PRIORITY_RANK[r.priority ?? "p3"])
    : undefined;

  // One slot per lane: fill with running gates, the rest are idle. Never fewer than the running count.
  const laneCount = Math.max(cap, running.length);
  const laneSlots = Array.from({ length: laneCount }, (_, i) => running[i] ?? null);

  const emptyForFilter = !loading && running.length === 0 && queued.length === 0;

  // Card 4cacc6f9: the per-row tags name each run's parent batch; this ties the SIBLINGS together, which
  // is the half a reader can't assemble by eye when K rows land across both the lanes and the queue.
  const fbGroups = fallbackGroups(running, queued);

  return (
    <Panel grid style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 700, color: color.text2 }}>
          Semaphore
        </span>
        <span style={{ fontSize: fs.sm, color: color.text3 }}>
          <b style={{ color: color.workText, fontWeight: 500 }}>{globalActive}</b> of {cap} lane{cap === 1 ? "" : "s"} busy · {globalQueued} queued · maxConcurrentGates <b style={{ color: color.workText, fontWeight: 500 }}>{cap}</b>
        </span>
      </div>

      {loading ? (
        <div style={{ color: color.text3, fontSize: fs.sm, padding: "8px 2px" }}>Reading the live semaphore…</div>
      ) : emptyForFilter ? (
        <div style={{ color: color.text3, fontSize: fs.sm, padding: "8px 2px" }}>
          No gate is running or queued{filterLabel ? ` for ${filterLabel}` : ""}.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "stretch", gap: 0, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "none", width: 320, minWidth: 260 }}>
            {laneSlots.map((g, i) => (
              <LaneSlot key={g?.id ?? `idle-${i}`} index={i} gate={g} now={now} filterLabel={filterLabel} globalActive={globalActive} />
            ))}
          </div>
          <div style={{ flex: "none", width: 44, display: "flex", alignItems: "center", justifyContent: "center", color: color.text3, fontSize: fs.lg }}>
            ◂
          </div>
          <div style={{ flex: 1, minWidth: 240, border: `1px dashed ${color.lineStrong}`, borderRadius: radius.base, padding: 12, background: color.inset }}>
            <div style={{ fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, marginBottom: 10 }}>
              Queue — waiting for a lane ({queued.length})
            </div>
            {queued.length === 0 ? (
              <div style={{ color: color.text3, fontSize: fs.sm }}>Queue empty — no gate waiting for a lane.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {queued.map((g, i) => (
                  <QueueCard key={g.id} gate={g} position={i + 1} now={now} isHol={g.id === holGate?.id} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {holGate && holBlocker && (
        <div style={{ marginTop: 12, padding: "8px 12px", border: `1px solid ${color.danger}`, borderLeftWidth: 3, borderRadius: radius.base, background: wash(color.danger, 5), fontSize: fs.sm, color: color.text }}>
          <b style={{ color: color.danger, fontWeight: 500 }}>Head-of-line block.</b>{" "}
          A {(holGate.priority ?? "").toUpperCase()} {KIND_LABEL[holGate.gateType]} gate
          {holGate.projectName ? ` (${holGate.projectName})` : ""} has waited{" "}
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtSeconds((now - Date.parse(holGate.since)) / 1000)}</span>{" "}
          behind a {(holBlocker.priority ?? "").toUpperCase()} {KIND_LABEL[holBlocker.gateType]} gate. Gates serialize; the lane frees when the running gate settles or times out.
        </div>
      )}

      {/* Card 4cacc6f9 — one callout per batch whose fallback runs are on screen. Cyan, not the
          head-of-line block's red: this explains a pile-up, it does not report a fault. The counts are
          taken from the SAME running/queued arrays rendered above, so the callout can never claim a row
          the reader cannot see — and it states plainly that it is a snapshot of a sequential process
          rather than implying it has counted the batch's whole candidate set. */}
      {fbGroups.map((g) => {
        const n = g.running + g.queued;
        // Both phases are named only when the group actually spans both — the single-phase case reads
        // "(0 queued)" as an assertion about the batch, which is exactly what this callout must not imply.
        const phases = g.running > 0 && g.queued > 0 ? ` (${g.running} running · ${g.queued} queued)` : "";
        const lead = n === 1
          ? `One run shown${phases} is a per-branch retry of batch `
          : `${n} of the runs shown${phases} are per-branch retries of batch `;
        const tail = n === 1
          ? " — it merges a single branch of that batch on its own gate, not an unrelated merge."
          : " — each merges a single branch of that batch on its own gate, not unrelated merges.";
        return (
          <div
            key={g.opId}
            style={{ marginTop: 12, padding: "8px 12px", border: `1px solid ${color.lineStrong}`, borderLeftWidth: 3, borderRadius: radius.base, background: color.surface2, fontSize: fs.sm, color: color.text }}
          >
            <b style={{ color: color.text2, fontWeight: 500 }}>Batch fallback.</b>{" "}
            {lead}
            <span style={{ fontFamily: font.mono, color: color.text2 }}>{shortOpId(g.opId)}</span>
            {/* The count is a SNAPSHOT of a sequential spawn, never the batch's candidate total — said in
                one short clause because two groups on screen repeat it, and repeated boilerplate is read
                past exactly like no caveat at all. */}
            {tail} Spawned one at a time: others may not have appeared yet, or may already have settled.
          </div>
        );
      })}
    </Panel>
  );
}

// One lane slot — a running gate card, or an idle placeholder when the lane isn't held for this view.
function LaneSlot({
  index, gate, now, filterLabel, globalActive,
}: {
  index: number;
  gate: GateRun | null;
  now: number;
  filterLabel: string | null;
  globalActive: number;
}) {
  const slotLabel = `Lane ${String(index + 1).padStart(2, "0")}`;
  if (!gate) {
    // Idle FOR THIS VIEW. Be honest about WHY: the lane may still be globally busy with another project's
    // gate (when filtered), vs genuinely free.
    const heldElsewhere = filterLabel != null && globalActive > 0;
    return (
      <div>
        <div style={slotLblStyle}>{slotLabel}</div>
        <div style={{ border: `1px solid ${color.lineStrong}`, borderRadius: radius.base, padding: 12, opacity: 0.6 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: fs.sm, color: color.text2 }}>
            <span style={{ width: 8, height: 8, borderRadius: radius.base, background: color.text3 }} />
            Idle
          </div>
          <div style={{ fontSize: fs.sm, color: color.text2, marginTop: 6 }}>
            {heldElsewhere ? "Lane held by another project's gate" : "Lane free"}
          </div>
          <div style={{ fontSize: fs.sm, color: color.text3, marginTop: 3 }}>
            {heldElsewhere
              ? `A gate on ${filterLabel} is next in line when the lane frees`
              : filterLabel
                ? `A gate on ${filterLabel} would start immediately`
                : "A new gate would start immediately"}
          </div>
        </div>
      </div>
    );
  }
  const elapsedSec = (now - Date.parse(gate.since)) / 1000;
  // Derived PER ROW from this gate's own project bound — never a page-level constant (card fd9edb87).
  const { warn, title: longRunTitle } = longRunCue(elapsedSec, gate.gateTimeoutMs);
  return (
    <div>
      <div style={slotLblStyle}>{slotLabel}</div>
      <div style={{ position: "relative", border: `1px solid ${color.work}`, borderRadius: radius.base, background: `linear-gradient(180deg,${wash(color.work, 5)},transparent)`, padding: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fs.sm, color: color.workText }}>
            <span style={{ width: 8, height: 8, borderRadius: radius.base, background: color.work, boxShadow: `0 0 6px ${color.work}` }} />
            Running
          </span>
          <KindTag gate={gate} />
          <span
            title={longRunTitle}
            style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", fontSize: fs.lg, color: warn ? color.danger : color.workText }}
          >
            {fmtSeconds(elapsedSec)}
          </span>
        </div>
        <div style={{ fontSize: fs.body, color: color.text, marginBottom: 2 }}>{gate.projectName}</div>
        {gate.batched
          ? <BatchIdentity landed={gate.branchCount} branches={gate.batchBranches} />
          : gate.branch && <div style={{ fontSize: fs.mono, color: color.text2, fontFamily: font.mono }}>{gate.branch}</div>}
        {/* Card 4cacc6f9 — its own line, directly under the branch it explains: this says why THIS branch
            is merging alone right now, which is a different question from what the run is. */}
        {gate.fallbackOfBatchOpId && <FallbackIdentity opId={gate.fallbackOfBatchOpId} style={{ marginTop: 3 }} />}
        <div style={{ fontSize: fs.sm, color: color.text3, marginTop: 5 }}>
          {gate.workerLabel ?? "—"}
          {gate.priority ? ` · ${gate.priority.toUpperCase()}` : ""}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, overflow: "hidden" }}>
          {/* Reuse the board card's oscilloscope sweep (loom-merge-sweep) — the shared running-gate liveness
              cue, already reduced-motion-aware in global.css. */}
          <span className="loom-merge-sweep" />
        </div>
      </div>
    </div>
  );
}

const slotLblStyle: CSSProperties = { fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, marginBottom: 6 };

// One queued gate — numbered, with its kind, project/branch, priority chip, and live wait.
function QueueCard({ gate, position, now, isHol }: { gate: GateRun; position: number; now: number; isHol: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
      border: `1px solid ${color.line}`,
      borderLeft: `2px solid ${isHol ? color.danger : color.lineStrong}`,
      borderRadius: radius.sm,
      background: isHol ? `linear-gradient(90deg,${wash(color.danger, 6)},transparent 60%)` : color.surface,
    }}>
      <span style={{ fontFamily: font.ui, fontWeight: 700, fontSize: fs.body, color: isHol ? color.danger : color.text3, width: 20, textAlign: "center", flex: "none" }}>
        {position}
      </span>
      <KindTag gate={gate} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: fs.sm, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gate.projectName}</div>
        <div style={{ fontSize: fs.xs, color: color.text3, fontFamily: font.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {gate.batched
            ? <BatchIdentity landed={gate.branchCount} branches={gate.batchBranches} style={{ fontSize: fs.xs, color: color.text3 }} />
            : (gate.branch ?? gate.workerLabel ?? "—")}
        </div>
        {/* Card 4cacc6f9 — the queue is exactly where an unexplained pile-up is read, so a fallback card
            carries the same attribution as the running lane rather than deferring to the callout alone. */}
        {gate.fallbackOfBatchOpId && <FallbackIdentity opId={gate.fallbackOfBatchOpId} style={{ fontSize: fs.xs, marginTop: 2 }} />}
      </div>
      {gate.priority && <PriorityTag priority={gate.priority} />}
      <span style={{ fontVariantNumeric: "tabular-nums", fontSize: fs.sm, color: color.text2, flex: "none" }}>
        waited {fmtSeconds((now - Date.parse(gate.since)) / 1000)}
      </span>
    </div>
  );
}

function KindTag({ gate }: { gate: GateRun }) {
  // Card bd9a483b / cee17efe: same no-confusion-with-a-real-gate labeling as HistoryRow below — see its
  // comment. Two independent non-gate mechanisms share "worker" underneath; neither must ever render as
  // an ordinary worker self-check.
  const label = gate.landingCheckOnly ? "landing check" : gate.distImporterCheckOnly ? "dist importer check" : KIND_LABEL[gate.gateType];
  const c = gate.landingCheckOnly ? color.text2 : gate.distImporterCheckOnly ? color.text2 : KIND_COLOR[gate.gateType];
  return (
    <span style={{ fontSize: fs.xs, padding: "2px 8px", borderRadius: radius.sm, border: `1px solid ${c}`, color: c, flex: "none" }}>
      {label}
    </span>
  );
}

function PriorityTag({ priority }: { priority: TaskPriority }) {
  const c = PRIORITY_COLOR[priority];
  return (
    <span style={{ fontSize: fs.xs, padding: "1px 6px", borderRadius: radius.sm, border: `1px solid ${c}`, color: c, flex: "none" }}>
      {priority}
    </span>
  );
}

// ── The history table (Direction 2): settled gate runs, newest first ─────────────
function HistoryTable({
  rows, now, loading, error, projectName,
}: {
  rows: GateHistoryRow[];
  now: number;
  loading: boolean;
  error: boolean;
  projectName: (id: string) => string;
}) {
  if (error) {
    return <Panel style={{ padding: 16, color: color.danger, fontSize: fs.sm }}>Couldn't load gate history.</Panel>;
  }
  if (loading) {
    return <Panel style={{ padding: 16, color: color.text3, fontSize: fs.sm }}>Loading gate history…</Panel>;
  }
  if (rows.length === 0) {
    return <Panel style={{ padding: 16, color: color.text3, fontSize: fs.sm }}>No gate history yet — settled merge, worker, and deploy gates will appear here newest-first.</Panel>;
  }
  return <HistoryTableBody rows={rows} now={now} projectName={projectName} />;
}

function HistoryTableBody({ rows, now, projectName }: { rows: GateHistoryRow[]; now: number; projectName: (id: string) => string }) {
  // Card 87798130: an override panel links to the red self-check it overrode. That row is usually loaded
  // (it sits just below the landing), so the link jumps to it and briefly marks it; when it is not in the
  // loaded pages the panel names its op id instead of offering a dead control.
  const byOpId = useMemo(() => {
    const m = new Map<string, GateHistoryRow>();
    for (const r of rows) if (r.opId) m.set(r.opId, r);
    return m;
  }, [rows]);
  const [flashOpId, setFlashOpId] = useState<string | null>(null);
  useEffect(() => {
    if (!flashOpId) return;
    const t = setTimeout(() => setFlashOpId(null), 1600);
    return () => clearTimeout(t);
  }, [flashOpId]);
  const jumpTo = (opId: string) => {
    const el = document.querySelector<HTMLElement>(`tr[data-gate-op="${CSS.escape(opId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
    setFlashOpId(opId);
  };
  return (
    <div className="loom-gate-scroller" style={{ overflowX: "auto", border: `1px solid ${color.line}`, borderRadius: radius.base, background: color.surface }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: fs.sm }}>
        <thead>
          <tr>
            {["Outcome", "Kind", "Project", "Branch", "Worker", "Duration", "Ended"].map((h) => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HistoryRow
              key={r.id}
              row={r}
              now={now}
              projectName={projectName}
              redRow={r.redSelfCheckOpId ? byOpId.get(r.redSelfCheckOpId) : undefined}
              flash={r.opId != null && r.opId === flashOpId}
              onJump={jumpTo}
            />
          ))}
        </tbody>
      </table>
      {/* The always-visible half of the non-run affordance (card 04cef8d7): the per-row marker says
          WHICH rows, this says WHAT it means — a hover tooltip alone would leave the distinction
          invisible to anyone who never hovers. Shown only while a non-run row is actually loaded, so
          it never becomes permanent chrome on a table that has none. */}
      {rows.some((r) => r.batched) && (
        <div style={{ padding: "9px 12px", borderTop: `1px solid ${color.line}`, fontSize: fs.sm, lineHeight: 1.55, color: color.text2, maxWidth: "78ch", whiteSpace: "normal" }}>
          <BatchTag />{" "}{BATCH_NOTE}
        </div>
      )}
      {rows.some((r) => r.batchForfeited) && (
        <div style={{ padding: "9px 12px", borderTop: `1px solid ${color.line}`, fontSize: fs.sm, lineHeight: 1.55, color: color.text2, maxWidth: "78ch", whiteSpace: "normal" }}>
          <ForfeitTag />{" "}{FORFEIT_NOTE}
        </div>
      )}
      {rows.some((r) => r.overrideReason != null) && (
        <div data-testid="override-note" style={{ padding: "9px 12px", borderTop: `1px solid ${color.line}`, fontSize: fs.sm, lineHeight: 1.55, color: color.text2, maxWidth: "78ch", whiteSpace: "normal" }}>
          <OverrideChip />{OVERRIDE_NOTE}
        </div>
      )}
      {rows.some((r) => !r.gateRan) && (
        <div style={{ padding: "9px 12px", borderTop: `1px solid ${color.line}`, fontSize: fs.sm, lineHeight: 1.55, color: color.text2, maxWidth: "78ch", whiteSpace: "normal" }}>
          <span style={{ fontSize: fs.xs, color: color.text2 }}>{NON_RUN_LABEL}</span>
          {" marks a run where no gate process ever spawned: a merge that reused a green worker self-check, a run withdrawn before it was admitted, a diff proven inert, or a landing the merge-gate interval let through ungated. Its duration is parenthesised because it is a real number measuring op overhead, not gate execution. Leave those rows out of a gate-duration trend."}
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  row, now, projectName, redRow, flash, onJump,
}: {
  row: GateHistoryRow;
  now: number;
  projectName: (id: string) => string;
  redRow: GateHistoryRow | undefined;
  flash: boolean;
  onJump: (opId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasOverride = row.overrideReason != null;
  const panelId = `gate-override-${row.id}`;
  // Card bd9a483b: a landing-check row is gateType:"worker" underneath (it shares that admission lane),
  // but must never render as an ordinary worker self-check — the whole point of `landingCheckOnly` is
  // that a reader can tell it apart from a real gate at a glance, not just in the underlying data.
  const kindLabel = row.landingCheckOnly ? "landing check" : row.distImporterCheckOnly ? "dist importer check" : KIND_LABEL[row.gateType];
  const kindC = row.landingCheckOnly ? color.text2 : row.distImporterCheckOnly ? color.text2 : KIND_COLOR[row.gateType];
  const outC = OUTCOME_COLOR[row.outcome];
  const killed = row.outcome === "kill" || row.outcome === "timeout";
  // With the panel open the row and its panel read as one unit: the hairline moves below the panel.
  const td: CSSProperties = hasOverride && open ? { ...tdStyle, borderBottom: "none" } : tdStyle;
  return (
    <Fragment>
    <tr
      className="loom-gate-row"
      id={row.opId ? `gate-op-${row.opId}` : undefined}
      data-gate-op={row.opId ?? undefined}
      tabIndex={-1}
      style={flash ? { background: color.attnSoft, outline: "none" } : { outline: "none" }}
    >
      <td style={td}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fs.sm, color: row.outcome === "pass" ? color.liveFg : outC }}>
            <span style={{ width: 7, height: 7, borderRadius: radius.base, background: outC, ...(OUTCOME_GLOW[row.outcome] ? { boxShadow: `0 0 5px ${outC}` } : null) }} />
            {row.outcome}
          </span>
          {row.batchForfeited && <ForfeitTag />}
          {hasOverride && (
            <button
              type="button"
              className="loom-btn loom-btn-ghost"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((o) => !o)}
              title={open ? "Hide the manager's override reason" : "Show the manager's override reason"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 4px", margin: "-2px -4px",
                borderRadius: radius.sm, font: "inherit", cursor: "pointer", color: color.attnText,
              }}
            >
              <OverrideChip />
              <span aria-hidden="true" style={{ fontSize: fs.xs }}>{open ? "▾" : "▸"}</span>
            </button>
          )}
        </span>
      </td>
      <td style={td}><span style={{ fontSize: fs.xs, color: kindC }}>{kindLabel}</span></td>
      <td style={td}>{row.projectName ?? (row.projectId ? projectName(row.projectId) : "—")}</td>
      {row.batched
        ? <BatchBranchCell row={row} />
        : <td style={{ ...td, color: color.text2, fontFamily: font.mono }}>{row.branch ?? "—"}</td>}
      <td style={{ ...td, color: color.text2, fontFamily: font.mono }} title={row.failingTest ?? undefined}>
        {row.workerLabel ?? "—"}
        {row.failingTest && <span style={{ color: color.danger }}> · {row.failingTest}</span>}
      </td>
      <td style={td} title={row.gateRan ? undefined : `${nonRunReason(row.outcome, row.skipReason)} ${NON_RUN_NOTE}`}>
        {row.gateRan ? (
          <span style={{ fontVariantNumeric: "tabular-nums", color: killed ? color.danger : color.text }}>
            {fmtDurationMs(row.durationMs)}
          </span>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7 }}>
            {/* Parenthesised so the number reads as an aside, not a measurement to compare. A null
                duration keeps the table's plain "—" — wrapping that in parens would say nothing. */}
            <span style={{ fontVariantNumeric: "tabular-nums", color: color.text3 }}>
              {row.durationMs == null ? fmtDurationMs(null) : `(${fmtDurationMs(row.durationMs)})`}
            </span>
            <span style={{ fontSize: fs.xs, color: color.text2 }}>
              {NON_RUN_LABEL}
            </span>
          </span>
        )}
      </td>
      <td style={{ ...td, color: color.text3, fontFamily: font.mono }}>{relTime(row.endedAt, now)}</td>
    </tr>
    {hasOverride && open && (
      <tr>
        <td colSpan={7} style={{ padding: "0 12px 11px", borderBottom: `1px solid ${color.line}`, whiteSpace: "normal" }}>
          <OverridePanel id={panelId} row={row} redRow={redRow} now={now} onJump={onJump} />
        </td>
      </tr>
    )}
    </Fragment>
  );
}

// The disclosed detail for an override landing. Every line answers a question a human reading a
// manager's free text needs answered before trusting it: who wrote it, whether Loom checked it, what it
// set aside, and what the landing counts as.
function OverridePanel({
  id, row, redRow, now, onJump,
}: {
  id: string;
  row: GateHistoryRow;
  redRow: GateHistoryRow | undefined;
  now: number;
  onJump: (opId: string) => void;
}) {
  const redOpId = row.redSelfCheckOpId;
  return (
    <dl id={id} data-testid="override-panel" className="loom-gate-override" style={overridePanelStyle}>
      <dt style={overrideDtStyle}>Reason</dt>
      {/* Verbatim, as written: pre-wrap keeps the manager's own line breaks; nothing is trimmed or clamped. */}
      <dd style={{ ...overrideDdStyle, color: color.text, whiteSpace: "pre-wrap" }}>“{row.overrideReason}”</dd>
      <dt style={overrideDtStyle}>Written by</dt>
      <dd style={overrideDdStyle}>The manager that confirmed this merge, as free text.</dd>
      <dt style={overrideDtStyle}>Verified</dt>
      <dd style={overrideDdStyle}>
        <span style={{ color: color.attnText, fontWeight: 600 }}>No.</span> Loom stores the text exactly as written and does not check any claim in it.
      </dd>
      <dt style={overrideDtStyle}>What it overrode</dt>
      <dd style={overrideDdStyle}>
        A red run_gate self-check on this branch's own tip
        {redOpId && redRow ? (
          <>
            {" ("}
            {/* An in-page link, not a button: it must wrap with the sentence at phone width. The handler
                scrolls + focuses the row itself, so the URL hash is never touched. */}
            <a
              href={`#gate-op-${redOpId}`}
              onClick={(e) => { e.preventDefault(); onJump(redOpId); }}
              title="Jump to that self-check's row"
              style={{ color: color.accentFg, textDecoration: "underline", textUnderlineOffset: 2, borderRadius: radius.sm }}
            >
              the worker {redRow.outcome} {relTime(redRow.endedAt, now)}, op <span style={{ fontFamily: font.mono }}>{shortOpId(redOpId)}</span>
            </a>
            {")"}
          </>
        ) : redOpId ? (
          <>
            {" (op "}<span style={{ fontFamily: font.mono, color: color.text }}>{shortOpId(redOpId)}</span>{", not in the loaded history)"}
          </>
        ) : null}
        . The merge gate interval would otherwise have run the real gate.
      </dd>
      <dt style={overrideDtStyle}>Counts as</dt>
      <dd style={overrideDdStyle}>An ungated landing. Never a pass.</dd>
    </dl>
  );
}

const overridePanelStyle: CSSProperties = {
  margin: "2px 0 4px 13px", padding: "12px 14px", border: `1px solid ${color.line}`, borderLeft: `2px solid ${color.attn}`,
  borderRadius: radius.sm, background: color.inset,
  // At phone width the table scrolls sideways; pinning the panel to the scroller's left edge and sizing it
  // to the scroller (100cqw: `.loom-gate-scroller` is the query container) keeps the whole panel readable
  // without scrolling to find it. 37px = the cell's 12px side paddings + this panel's 13px left margin.
  position: "sticky", left: 12, boxSizing: "border-box", width: "min(92ch, calc(100cqw - 37px))",
};
const overrideDtStyle: CSSProperties = { fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, paddingTop: 1 };
const overrideDdStyle: CSSProperties = { margin: 0, fontFamily: font.ui, fontSize: fs.sm, lineHeight: 1.55, color: color.text2, overflowWrap: "anywhere" };

// The Branch cell for a BATCHED row. The count alone already beats the old em-dash (it can no longer be
// mistaken for missing data), but a batch's whole point is WHICH branches landed together, so the count
// doubles as a disclosure control that lists them in place. Collapsed by default - the table's job is a
// scannable run index, and N permanently-expanded lists would bury it.
function BatchBranchCell({ row }: { row: GateHistoryRow }) {
  const [open, setOpen] = useState(false);
  const branches = row.batchBranches ?? [];
  const requested = row.batchBranches?.length ?? null;
  const canExpand = branches.length > 0;
  // ⚠️ `requested` and `row.branchCount` are DIFFERENT numbers by construction (see batchSummary): the
  // array is the pre-assembly REQUESTED set, the count is what actually LANDED. A gap between them means
  // a branch conflicted out while the batch was assembled.
  const droppedCount = row.branchCount != null && requested != null ? requested - row.branchCount : 0;
  return (
    <td style={{ ...tdStyle, color: color.text2, fontFamily: font.mono, whiteSpace: "normal" }}>
      {canExpand ? (
        <button
          type="button"
          className="loom-btn loom-btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide the branches in this batch" : "Show the branches in this batch"}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 5px", margin: "-3px -5px",
            borderRadius: radius.sm, font: "inherit", cursor: "pointer",
          }}
        >
          <BatchTag />
          <span>{batchSummary(row.branchCount, requested)}</span>
          {/* Deliberately states no `color`: it INHERITS the button's, so the glyph lifts with the label
              on ghost's hover rule instead of staying dim beside a brightening label. */}
          <span aria-hidden="true" style={{ fontSize: fs.xs }}>{open ? "▾" : "▸"}</span>
        </button>
      ) : (
        // No recorded branch list (a row from before `branches` was stamped). The count still identifies
        // it as a batch; there is simply nothing to expand, so no dead control is offered.
        <BatchIdentity landed={row.branchCount} branches={null} />
      )}
      {open && canExpand && (
        <>
          <ul style={{ listStyle: "none", margin: `${space(2)} 0 0`, padding: `0 0 0 ${space(2)}`, borderLeft: `1px solid ${color.line}`, display: "flex", flexDirection: "column", gap: 3 }}>
            {branches.map((b) => (
              <li key={b} style={{ fontSize: fs.sm, color: color.text2 }}>{b}</li>
            ))}
          </ul>
          {droppedCount > 0 && (
            <div style={{ marginTop: space(2), fontSize: fs.xs, lineHeight: 1.5, color: color.attnText, maxWidth: "52ch", whiteSpace: "normal", fontFamily: font.ui }}>
              {/* Honest about the limit of what this row records: the event carries the REQUESTED set and a
                  LANDED COUNT, never a landed set, so naming which branch dropped would be a guess. */}
              {droppedCount} of these did not land (a conflict at assembly). This row records how many
              landed, not which.
            </div>
          )}
        </>
      )}
    </td>
  );
}

const thStyle: CSSProperties = { textAlign: "left", fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text3, padding: "10px 12px 8px", borderBottom: `1px solid ${color.line}`, whiteSpace: "nowrap" };
const tdStyle: CSSProperties = { padding: "9px 12px", borderBottom: `1px solid ${color.line}`, whiteSpace: "nowrap" };
