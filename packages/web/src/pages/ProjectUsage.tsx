import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SessionUsageTotals } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { boardHierarchy, taskLinks, type RelationKind, type TaskRef } from "../lib/taskHierarchy";
import {
  USAGE_RELATION_LABEL, buildTaskUsageTree, flattenTree, relationRows, rolledByTaskId, sortTree,
  taskTotalTokens, usagePartition,
  type UsageSortKey, type UsageTaskMeta, type UsageTaskNode,
} from "../lib/projectUsage";
import { Badge, Chip, Meter, Panel, SectionLabel } from "../components/ui";
import {
  Field, RowName, SectionHead, SortToggle, Stat, TIMESPANS, WindowSelect,
  fmtRatio, fmtTokens, fmtUsd, ratioTone, sinceIsoFor, type Timespan,
} from "../components/usageKit";
import { color, font, fs } from "../theme";

// THE PROJECT NODE'S USAGE TAB — card 30266229, the owner's Atlas feedback item (verbatim): `Add new
// per project "Usage" tab. - Breakdown usage by tasks and related tasks too.`
//
// ONE PLANE, not three. The cross-project /usage page is a god-eye console over three deliberately
// separate planes (interactive sessions · live occupancy · Agent Runs) that must never be summed. This
// tab shows exactly ONE of them — interactive-session consumption — sliced by TASK, which is the only
// plane that can be: live occupancy is a snapshot (not spend), and Agent Runs are API-triggered and
// carry no task id at all (and are not getting one — the investigation's G5). Keeping to one plane is
// why this tab needs no plane labels or never-sum warnings of its own.
//
// Every row, formatter, tone and window control comes from components/usageKit.tsx — the SAME ones
// /usage renders. The roll-up rules are pure functions in lib/projectUsage.ts (unit-tested in
// test/project-usage.mjs); design: $LOOM_PROJECT_WORK_DIR/analyses/30266229-usage-tab.md §5b.

export default function ProjectUsage() {
  const { projectId, projects } = useActiveProject();
  const [span, setSpan] = useState<Timespan>("7d");
  const [sort, setSort] = useState<UsageSortKey>("cost");
  /** Which task rows are expanded — their child breakdown + their relation rows. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const project = projects.find((p) => p.id === projectId) ?? null;
  const spanMeta = TIMESPANS.find((t) => t.key === span)!;

  // `taskBreakdown: true` is what adds byTask/orchestrationOverhead/unattributed. The daemon omits all
  // three for an unscoped or unknown project, which cannot happen here — this tab always has one real
  // project — but the derivation treats them as optional anyway (see usagePartition's `present`).
  const usageQ = useQuery({
    queryKey: ["projectUsageHistory", projectId, span],
    queryFn: ({ signal }) => api.sessionUsageHistory(sinceIsoFor(span), projectId, true, signal),
    enabled: !!projectId,
    refetchInterval: 30000,
  });
  // The SAME query key + fetcher the Board tab and the node's own board rollup use, so the titles and
  // parentage here come from one cache entry rather than a second request.
  const boardQ = useQuery({
    queryKey: ["board", projectId],
    queryFn: ({ signal }) => api.board(projectId, undefined, signal),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  const part = usagePartition(usageQ.data);
  const meta: UsageTaskMeta[] = (boardQ.data?.tasks ?? []).map((t) => ({
    id: t.id, title: t.title, columnKey: t.columnKey, parentId: boardHierarchy(t).parentId,
  }));
  const roots = sortTree(buildTaskUsageTree(usageQ.data?.byTask ?? [], meta), sort);
  const rolled = rolledByTaskId(roots);
  // Every row's meter is scaled to the biggest SINGLE figure on screen — the three buckets included, so
  // a task bar and the overhead bar are comparable rather than each filling its own section.
  const peak = Math.max(
    ...flattenTree(roots).map((n) => taskTotalTokens(n.rolled)),
    taskTotalTokens(part.overhead), taskTotalTokens(part.unattributed), 1,
  );
  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  if (!projectId) {
    return <Panel><span style={{ color: color.text3 }}>Pick a project to see its usage.</span></Panel>;
  }

  return (
    <section data-testid="project-usage" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <Field label="Window">
          <WindowSelect value={span} onChange={setSpan} testId="project-usage-window" />
        </Field>
        <span style={{ flex: 1 }} />
        <SortToggle value={sort} onChange={setSort} />
      </div>

      <SectionHead title="Usage by task" tag={`est. consumption · ${spanMeta.window}`} tagTone="muted" />

      {usageQ.isLoading && <Panel><span style={{ color: color.text3 }}>Loading usage…</span></Panel>}
      {usageQ.isError && (
        <Panel><span style={{ color: color.danger, fontSize: fs.sm }}>
          Couldn't load usage: {(usageQ.error as Error)?.message ?? "unknown error"}
        </span></Panel>
      )}

      {!usageQ.isLoading && !usageQ.isError && (
        part.total.samples === 0 ? (
          <Panel style={{ padding: 20 }} data-testid="project-usage-empty">
            <div style={{ fontFamily: font.ui, fontSize: fs.body, color: color.text2, marginBottom: 6 }}>
              No usage recorded in this window
            </div>
            <div style={{ fontSize: fs.sm, color: color.text3, lineHeight: 1.6, maxWidth: 560 }}>
              No interactive-session usage recorded for {project?.name ?? "this project"} in this window
              ({spanMeta.window}). Try a wider window, or this fills in as this project's sessions run and
              the daemon samples them.
            </div>
          </Panel>
        ) : (
          <>
            {/* The window's grand total — the figure every row below is a slice of. */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <Stat label="est. consumption" value={fmtUsd(part.total.costUsd)} tone="muted" testId="project-usage-total-cost" />
              <Stat label="total tok" value={fmtTokens(taskTotalTokens(part.total))} tone="muted" testId="project-usage-total-tokens" />
              <Stat label="cache hit" value={fmtRatio(part.total.cacheHitRatio)} tone={ratioTone(part.total.cacheHitRatio)} />
              <Stat label="tasks" value={String(usageQ.data?.byTask?.length ?? 0)} tone="muted" testId="project-usage-task-count" />
            </div>

            <div>
              <SectionLabel>By task</SectionLabel>
              <Panel data-testid="project-usage-tasks">
                {roots.length === 0 && (
                  <span style={{ color: color.text3, fontSize: fs.sm }}>
                    No usage in this window resolved to a task.
                  </span>
                )}
                {roots.map((n) => (
                  <TaskUsageRows key={n.taskId} node={n} depth={0} peak={peak}
                    open={open} onToggle={toggle} rolled={rolled} />
                ))}
              </Panel>
            </div>

            {/* The two labelled buckets that are NOT a task — present so the rows on screen add up. */}
            <div>
              <SectionLabel>Not attributed to a task</SectionLabel>
              <Panel data-testid="project-usage-buckets">
                <BucketRow label="Orchestration overhead" testId="project-usage-overhead"
                  hint="managers &amp; platform leads — one session, many tasks"
                  row={part.overhead} peak={peak} />
                <BucketRow label="Unattributed" testId="project-usage-unattributed"
                  hint="no task on the session, or its session row is gone"
                  row={part.unattributed} peak={peak} />
                {!part.balanced && (
                  <div data-testid="project-usage-residual"
                    style={{ fontSize: fs.sm, color: color.danger, paddingTop: 6 }}>
                    {fmtUsd(part.residual.costUsd)} / {fmtTokens(taskTotalTokens(part.residual))} tok of
                    this window's total is in none of the rows above — the breakdown is incomplete.
                  </div>
                )}
              </Panel>
            </div>

            <UsageDisclosure balanced={part.balanced} present={part.present} />
          </>
        )
      )}
    </section>
  );
}

// ── One task's row, plus (when expanded) its children and its relation edges ──────────────────────
// A CHILD IS DRAWN TWICE AND MEANS DIFFERENT THINGS EACH TIME, which is the whole point of the
// expansion: collapsed, a parent states ONE number that already contains its subtree; expanded, the
// same subtree is itemised underneath it. A relation row is drawn ONCE and is never contained in
// anything — see lib/projectUsage.ts's own anchor for why.
function TaskUsageRows({ node, depth, peak, open, onToggle, rolled }: {
  node: UsageTaskNode;
  depth: number;
  peak: number;
  open: Set<string>;
  onToggle: (id: string) => void;
  rolled: Map<string, SessionUsageTotals>;
}) {
  const expanded = open.has(node.taskId);
  return (
    <>
      <TaskRow node={node} depth={depth} peak={peak} expanded={expanded} onToggle={onToggle} />
      {expanded && node.children.map((c) => (
        <TaskUsageRows key={c.taskId} node={c} depth={depth + 1} peak={peak}
          open={open} onToggle={onToggle} rolled={rolled} />
      ))}
      {expanded && <RelationRows taskId={node.taskId} rolled={rolled} />}
    </>
  );
}

function TaskRow({ node, depth, peak, expanded, onToggle }: {
  node: UsageTaskNode;
  depth: number;
  peak: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const tok = taskTotalTokens(node.rolled);
  const short = node.taskId.slice(0, 8);
  // A deleted card keeps its usage and loses only its name — stated, never dropped (the same posture
  // the shared types take for a gone project/agent).
  const title = node.title ?? `(deleted card ${short})`;
  const kids = node.children.length;
  return (
    <div data-testid={`project-usage-row-${short}`} data-pu-task={node.taskId}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.line}` }}>
      <button onClick={() => onToggle(node.taskId)} data-testid={`project-usage-expand-${short}`}
        aria-expanded={expanded}
        title={expanded ? `Collapse ${title}` : `Expand ${title}`}
        style={{
          background: "transparent", border: "none", cursor: "pointer", padding: "0 2px",
          marginLeft: depth * 14, fontSize: fs.sm,
          color: color.text2, minWidth: 14, textAlign: "left",
        }}>
        {expanded ? "▾" : "▸"}
      </button>
      {/* A card title is a sentence, not an agent name — it gets most of the row (far more than the
          shared kit's 200px default), and only ellipsises once a narrow viewport takes the space back. */}
      <RowName width={240} maxWidth={560}
        name={node.title == null
          ? <span style={{ color: color.text3 }}>{title}</span>
          : <Link to={`/board?task=${node.taskId}`} style={{ color: color.text, textDecoration: "none" }}
              title={`Open card ${short} on the board`}>{title}</Link>}
        subtitle={short} />
      {node.columnKey && <Chip value={node.columnKey} />}
      {kids > 0 && (
        <Badge tone="muted">
          {/* The number IS the claim this row makes: the figure to its right contains that many cards'
              usage as well as its own. */}
          +{node.descendantsWithUsage} rolled up
        </Badge>
      )}
      <span style={{ flex: 1 }} />
      {/* `marginLeft: auto` is what keeps the figures hard RIGHT once the row wraps at a narrow width:
          the spacer above only pushes them on a line they SHARE with the title, so without this the
          wrapped figure line starts at the row's left edge and the column alignment every row is read
          down disappears exactly where it is hardest to scan. */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3, minWidth: 64, textAlign: "right" }}>{fmtTokens(tok)} tok</span>
        <Meter value={tok} max={peak} tone="muted" width={90} />
        <span data-testid={`project-usage-cost-${short}`}
          style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text, minWidth: 72, textAlign: "right" }}>{fmtUsd(node.rolled.costUsd)}</span>
      </span>
    </div>
  );
}

/**
 * A task's relation edges, each with its OWN total.
 *
 * Fetched lazily, on expand, through the single-task read (`GET /api/tasks/:id`) — the board LIST
 * projection carries only relation COUNTS, never the edges themselves, so there is no way to draw these
 * from the data already loaded. Doing it per expanded row is what keeps a project with a thousand cards
 * from issuing a thousand requests to render a page nobody has drilled into yet.
 */
function RelationRows({ taskId, rolled }: { taskId: string; rolled: Map<string, SessionUsageTotals> }) {
  // The SAME key + fetcher the board drawer uses for a card's full row, so expanding a card here and
  // opening it there share one cache entry.
  const q = useQuery({ queryKey: ["task", taskId], queryFn: ({ signal }) => api.getTask(taskId, signal), staleTime: 30_000 });
  const rows = relationRows(taskId, taskLinks(q.data).relations, rolled);
  if (q.isLoading) {
    return <Note indent={28}>Loading related cards…</Note>;
  }
  if (q.isError) {
    return <Note indent={28} tone="danger">Couldn't load this card's related cards.</Note>;
  }
  if (rows.length === 0) {
    return <Note indent={28}>No related cards.</Note>;
  }
  return (
    <>
      <div data-testid={`project-usage-relations-${taskId.slice(0, 8)}`}
        style={{ fontSize: fs.xs, color: color.text3, padding: "6px 0 2px", paddingLeft: 28, letterSpacing: "0.04em" }}>
        RELATED CARDS — counted on their own rows, never added to the figure above
      </div>
      {rows.map((r) => <RelationRow key={`${r.kind}:${r.ref.id}`} kind={r.kind} ref_={r.ref} totals={r.totals} />)}
    </>
  );
}

function RelationRow({ kind, ref_, totals }: { kind: RelationKind; ref_: TaskRef; totals: SessionUsageTotals }) {
  const short = ref_.id.slice(0, 8);
  const tok = taskTotalTokens(totals);
  return (
    <div data-testid={`project-usage-relation-${kind}-${short}`}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", flexWrap: "wrap", borderBottom: `1px dashed ${color.line}` }}>
      <span style={{ minWidth: 14, marginLeft: 28 }} />
      {/* The kind leads the row: without it, a relation row and a rolled-up CHILD row would look the
          same, and only one of the two is inside the parent's number. */}
      <Badge tone="muted">{USAGE_RELATION_LABEL[kind]}</Badge>
      <RowName width={200} maxWidth={440}
        name={<Link to={`/board?task=${ref_.id}`} style={{ color: color.text2, textDecoration: "none" }}
          title={`Open card ${short} on the board`}>{ref_.title}</Link>}
        subtitle={short} />
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3, minWidth: 64, textAlign: "right" }}>
          {totals.samples === 0 ? "no usage" : `${fmtTokens(tok)} tok`}
        </span>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: totals.samples === 0 ? color.text3 : color.text, minWidth: 72, textAlign: "right" }}>
          {totals.samples === 0 ? "—" : fmtUsd(totals.costUsd)}
        </span>
      </span>
    </div>
  );
}

/** One of the two non-task buckets (orchestration overhead · unattributed), laid out like a task row so
 *  the four figures on screen read on one scale. */
function BucketRow({ label, hint, row, peak, testId }: {
  label: string; hint: string; row: SessionUsageTotals; peak: number; testId: string;
}) {
  const tok = taskTotalTokens(row);
  return (
    <div data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", flexWrap: "wrap", borderBottom: `1px solid ${color.line}` }}>
      <RowName width={240} maxWidth={560} name={label} subtitle={hint} />
      <span style={{ flex: 1 }} />
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3, minWidth: 64, textAlign: "right" }}>{fmtTokens(tok)} tok</span>
        <Meter value={tok} max={peak} tone="muted" width={90} />
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text, minWidth: 72, textAlign: "right" }}>{fmtUsd(row.costUsd)}</span>
      </span>
    </div>
  );
}

function Note({ children, indent = 0, tone: t }: { children: ReactNode; indent?: number; tone?: "danger" }) {
  return (
    <div style={{ fontSize: fs.sm, color: t === "danger" ? color.danger : color.text3, padding: "4px 0", paddingLeft: indent }}>
      {children}
    </div>
  );
}

/**
 * THE DISCLOSURE. Short and plain, and it is not decoration: three of these four sentences name a real
 * way a figure above can be wrong or incomplete, and the investigation this tab was built from
 * (§5b.4) made stating them a condition of shipping it rather than faking a cleaner breakdown.
 */
function UsageDisclosure({ balanced, present }: { balanced: boolean; present: boolean }) {
  return (
    <div data-testid="project-usage-disclosure"
      style={{ fontSize: fs.sm, color: color.text3, lineHeight: 1.6, maxWidth: 720 }}>
      Cost is an ESTIMATE of what these tokens would cost on metered API, not a bill — on a flat
      subscription it meters what you consumed. A review-only worker's usage lands in Unattributed if
      its spawn carried no task. A manager works many cards over one session, so its usage is never
      attributed to one of them — that is the Orchestration overhead row. Plan and rate-limit usage is
      account-wide and has no per-task breakdown at all, so none is shown here.
      {present && balanced && " The rows above add up to the window's total exactly."}
    </div>
  );
}
