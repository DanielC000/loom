// The session's Loom MCP activity strip, under the composer on the Atlas session node (card a9a7140c,
// owner pick B · Ledger). Compact: the latest Loom call as a sentence. Expanded: every call grouped by
// agent turn, a facet rail, and an inline "Asked Loom / Loom answered" per call. Data and its limits:
// lib/mcpActivity.ts. Arguments and results are agent-authored text and render as React text only.
// A codex session reads the daemon's per-call record instead (lib/mcpCallRecord.ts): no args, no answer,
// no turns, and a duration the router measured, so its copy says so (SourceCtx).
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TranscriptTurn } from "../lib/api";
import { fetchTranscriptIncremental } from "../lib/transcriptTail";
import {
  applyFilter, durationBarPx, emptyFilter, filterActive, fmtClock, fmtMs, groupByTurn, isUnclassified, linksOf, mcpPollInterval,
  fmtDateTime, parseMcpCalls, sentenceOf, tally, turnSpanMs, DURATION_HINT, REFUSED_HINT, SPAN_HINT, SUBSYSTEMS, UNCLASSIFIED_HINT,
  type McpCall, type McpFilter, type McpOutcome, type McpSubsystem,
} from "../lib/mcpActivity";
import { turnCauses, type TurnCause } from "../lib/turnCause";
import {
  mcpRecordQuery, mcpSourceFor, recordSentenceOf, recordToMcpCalls, RECORD_DURATION_HINT, RECORD_GROUP_LABEL, RECORD_NOT_KEPT,
  RECORD_REFUSED_HINT, RECORD_SPAN_HINT, type McpSource,
} from "../lib/mcpCallRecord";

/** Where this strip's calls came from: the transcript (claude) or the per-call record (codex). */
const SourceCtx = createContext<McpSource>("transcript");
const NO_CAUSES: ReadonlyMap<number, TurnCause> = new Map();

const OUTCOME_MARK: Record<McpOutcome, string> = { ok: "✓", refused: "!", error: "✕", pending: "…" };
const OUTCOME_LABEL: Record<McpOutcome, string> = { ok: "ok", refused: "refused", error: "error", pending: "no answer yet" };
const LINK_LABEL = { card: "card", worker: "worker", gate: "gate op", note: "note", request: "request" } as const;
const MAX_BEADS = 12;
const TOP_TOOLS = 6;

function Glyph({ sub }: { sub: McpSubsystem }) {
  return <span className={`loom-mcp-gl ${sub}`} aria-hidden="true" />;
}

const refusedHint = (src: McpSource) => (src === "record" ? RECORD_REFUSED_HINT : REFUSED_HINT);
const durationHint = (src: McpSource) => (src === "record" ? RECORD_DURATION_HINT : DURATION_HINT);

function Mark({ outcome }: { outcome: McpOutcome }) {
  const src = useContext(SourceCtx);
  return (
    <span className={`loom-mcp-ocx ${outcome}`} role="img" aria-label={OUTCOME_LABEL[outcome]}
      title={outcome === "refused" ? `refused · ${refusedHint(src)}` : undefined}>
      {OUTCOME_MARK[outcome]}
    </span>
  );
}

function Sentence({ call }: { call: McpCall }) {
  const s = useContext(SourceCtx) === "record" ? recordSentenceOf(call) : sentenceOf(call);
  return (
    <>
      {s.lead}
      {s.object && <> <b>{s.object}</b></>}
      {s.tail && <> <span className="loom-mcp-tail">{s.tail}</span></>}
    </>
  );
}

/** "after worker report 9e40d7a1 (progress)": what opened the turn (lib/turnCause.ts). Text only; the
 *  excerpt is the opening message, already cut, and shown in quotes only where there is room for it. */
function Cause({ cause, testId, quote = false }: { cause: TurnCause | undefined; testId: string; quote?: boolean }) {
  if (!cause) return null;
  return (
    <span className="loom-mcp-why" data-testid={testId} data-cause={cause.kind}
      title={cause.excerpt && !quote ? cause.excerpt : undefined}>
      after {cause.label}
      {cause.id && <> <b>{cause.id}</b></>}
      {cause.detail && <> ({cause.detail})</>}
      {cause.more > 0 && <> <span className="loom-mcp-whymore">+{cause.more} more</span></>}
      {quote && cause.excerpt && <> <q className="loom-mcp-quote">{cause.excerpt}</q></>}
    </span>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "≈42ms", always marked approximate (lib/mcpActivity.ts DURATION_HINT). */
const approx = (ms: number) => `≈${fmtMs(ms)}`;
/** A recorded duration is the router's own measurement, so it carries no "≈". */
const fmtDur = (src: McpSource, ms: number) => (src === "record" ? fmtMs(ms) : approx(ms));

/** A row's duration cell: the figure and a log-scale bar, or nothing at all when there is no duration. */
function Duration({ call }: { call: McpCall }) {
  const src = useContext(SourceCtx);
  if (call.ms == null) return <span className="loom-mcp-dur" />;
  return (
    <span className="loom-mcp-dur" data-testid={`mcp-call-${call.seq}-dur`} title={durationHint(src)}>
      {fmtDur(src, call.ms)}
      <i className={call.outcome} data-testid={`mcp-call-${call.seq}-bar`} style={{ width: durationBarPx(call.ms) }} />
    </span>
  );
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

export function McpActivity({ sessionId, harness, busy = false }: {
  sessionId: string;
  harness?: string | null;
  busy?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = useDocumentHidden();
  // Same key and function as the Transcript tab (TranscriptPane): one cache, one poll cadence.
  // See mcpPollInterval for why the key must stay shared.
  // The fetch is incremental (first load full, then only the tail); the cached array stays the full
  // transcript, so the Transcript tab reading the same key is unaffected.
  const qc = useQueryClient();
  // A codex transcript has no tool-call lines, so codex reads the per-call record on its own key at the
  // same cadence; each session fetches exactly one of the two (lib/mcpCallRecord.ts mcpRecordQuery).
  const source = mcpSourceFor(harness);
  const interval = mcpPollInterval({ hidden, expanded, busy });
  const t = useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: ({ signal }) => fetchTranscriptIncremental(
      qc.getQueryData<TranscriptTurn[]>(["transcript", sessionId]),
      (offset) => api.transcriptTail(sessionId, offset, signal),
      () => api.transcript(sessionId, signal),
    ),
    enabled: source === "transcript",
    refetchInterval: interval,
  });
  const r = useQuery(mcpRecordQuery(sessionId, harness, api.mcpCalls, interval));
  const calls = useMemo(
    () => (source === "record" ? recordToMcpCalls(r.data?.calls ?? []) : parseMcpCalls(t.data ?? [])),
    [source, r.data, t.data],
  );
  const causes = useMemo(() => (source === "record" ? NO_CAUSES : turnCauses(t.data ?? [])), [source, t.data]);
  const panelId = useId();

  if (!calls.length) {
    const q = source === "record" ? r : t;
    const note = source === "record"
      ? q.isError ? "Couldn't read this session's Loom call record."
        : q.isLoading ? "Reading the call record…"
        : "No Loom MCP calls recorded for this codex session yet."
      : q.isError ? "Couldn't read this session's transcript."
        : q.isLoading ? "Reading the transcript…"
        : "No Loom MCP calls yet this session.";
    return (
      <div className="loom-mcp" data-testid="mcp-activity" data-state="empty" data-source={source}>
        <div className="loom-mcp-empty-bar"><span className="loom-mcp-lab">Loom MCP</span><span>{note}</span></div>
      </div>
    );
  }

  const latest = calls[calls.length - 1]!;
  const turnCalls = calls.filter((c) => c.turn === latest.turn);
  const errors = calls.filter((c) => c.outcome === "error").length;
  const refused = calls.filter((c) => c.outcome === "refused").length;
  const beads = turnCalls.slice(-MAX_BEADS);
  const recorded = source === "record";

  return (
    <SourceCtx.Provider value={source}>
    <div className={`loom-mcp${expanded ? " open" : ""}`} data-testid="mcp-activity" data-source={source}>
      <button
        type="button"
        className="loom-mcp-bar"
        data-testid="mcp-activity-bar"
        aria-expanded={expanded}
        aria-controls={panelId}
        title={expanded ? "Collapse" : "Show every Loom call this session"}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="loom-mcp-l1">
          <span className="loom-mcp-lab">Loom MCP</span>
          {recorded ? <span data-testid="mcp-activity-scope">· latest calls</span> : <span>· turn {latest.turn}</span>}
          <Cause cause={causes.get(latest.turn)} testId="mcp-activity-cause" />
          <span className="loom-mcp-beads" aria-label={recorded ? `latest ${plural(beads.length, "call")}` : `${plural(turnCalls.length, "call")} this turn`}>
            {turnCalls.length > beads.length && <span className="loom-mcp-more">+{turnCalls.length - beads.length}</span>}
            {beads.map((c) => (
              <span key={c.seq} className={`loom-mcp-bead ${c.outcome}`} title={`${c.tool} · ${OUTCOME_LABEL[c.outcome]}`}>
                <Glyph sub={c.subsystem} />
              </span>
            ))}
          </span>
        </span>
        <span className="loom-mcp-l2" key={latest.seq}>
          <Mark outcome={latest.outcome} />
          <span className="loom-mcp-say" data-testid="mcp-activity-latest" data-outcome={latest.outcome}>
            <Sentence call={latest} />
          </span>
          <span className="loom-mcp-meta">
            {latest.tool}
            {latest.ms != null && <span data-testid="mcp-activity-latest-dur" title={durationHint(source)}> · {fmtDur(source, latest.ms)}</span>}
          </span>
        </span>
        <span className="loom-mcp-right">
          <span>
            <span data-testid="mcp-activity-count">{calls.length}</span>
            {calls.length === 1 ? " call" : " calls"}
            {refused > 0 && (
              <span className="loom-mcp-refn" data-testid="mcp-activity-refused-count" title={refusedHint(source)}> · {refused} refused</span>
            )}
            {errors > 0 && <span className="loom-mcp-errn"> · {plural(errors, "error")}</span>}
          </span>
          <span className="loom-mcp-chev" aria-hidden="true">▾</span>
        </span>
      </button>
      {expanded && <Expanded id={panelId} calls={calls} causes={causes} />}
    </div>
    </SourceCtx.Provider>
  );
}

function Expanded({ id, calls, causes }: { id: string; calls: McpCall[]; causes: ReadonlyMap<number, TurnCause> }) {
  const src = useContext(SourceCtx);
  const [filter, setFilter] = useState<McpFilter>(emptyFilter);
  const [openSeq, setOpenSeq] = useState<ReadonlySet<number>>(() => new Set());
  const shown = useMemo(() => applyFilter(calls, filter), [calls, filter]);
  const groups = useMemo(() => groupByTurn(shown), [shown]);
  // A turn header counts the WHOLE turn, not the filtered slice, so a filter never misstates the turn.
  const turnTotals = useMemo(() => {
    const m = new Map<number, { n: number; err: number; ref: number; calls: McpCall[] }>();
    for (const c of calls) {
      const e = m.get(c.turn) ?? { n: 0, err: 0, ref: 0, calls: [] };
      e.n++; if (c.outcome === "error") e.err++; if (c.outcome === "refused") e.ref++; e.calls.push(c);
      m.set(c.turn, e);
    }
    return m;
  }, [calls]);

  const toggleCall = (seq: number) => setOpenSeq((prev) => {
    const next = new Set(prev);
    if (next.has(seq)) next.delete(seq); else next.add(seq);
    return next;
  });

  return (
    <div className="loom-mcp-x" id={id}>
      <Facets calls={calls} filter={filter} setFilter={setFilter} />
      <div className={`loom-mcp-log${calls.some((c) => c.at != null) ? " timed" : ""}`}
        data-testid="mcp-activity-log" role="list" aria-label="Loom calls by turn">
        {groups.length === 0 ? (
          <p className="loom-mcp-none">No calls match. Clear a filter to widen it.</p>
        ) : groups.map((g) => {
          const tot = turnTotals.get(g.turn)!;
          const span = turnSpanMs(tot.calls);
          const startedAt = tot.calls.find((c) => c.at != null)?.at;
          return (
            <div key={g.turn} role="listitem" className="loom-mcp-turn" data-testid={`mcp-turn-${g.turn}`}>
              <div className="loom-mcp-turnh">
                <span className="loom-mcp-tn">{src === "record" ? RECORD_GROUP_LABEL : `Turn ${g.turn}`}</span>
                {startedAt && (
                  <span className="loom-mcp-tat" data-testid={`mcp-turn-${g.turn}-at`} title={`first Loom call at ${fmtDateTime(startedAt)}`}>
                    {fmtClock(startedAt).slice(0, 5)}
                  </span>
                )}
                <Cause cause={causes.get(g.turn)} testId={`mcp-cause-turn-${g.turn}`} quote />
                <span className="loom-mcp-tcount">
                  {plural(tot.n, "call")}
                  {span != null && (
                    <span data-testid={`mcp-turn-${g.turn}-total`} title={src === "record" ? RECORD_SPAN_HINT : SPAN_HINT}>{" · "}{fmtDur(src, span)}</span>
                  )}
                  {tot.ref > 0 && <span className="loom-mcp-refn"> · {tot.ref} refused</span>}
                  {tot.err > 0 && <span className="loom-mcp-errn"> · {plural(tot.err, "error")}</span>}
                </span>
                <span className="loom-mcp-stack" aria-hidden="true">
                  {tot.calls.map((c) => <i key={c.seq} className={`${c.subsystem} ${c.outcome}`} />)}
                </span>
              </div>
              {g.calls.map((c) => (
                <Entry key={c.seq} call={c} open={openSeq.has(c.seq)} onToggle={() => toggleCall(c.seq)} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Entry({ call, open, onToggle }: { call: McpCall; open: boolean; onToggle: () => void }) {
  const recorded = useContext(SourceCtx) === "record";
  const bodyId = `loom-mcp-call-${call.seq}`;
  const links = linksOf(call);
  return (
    <>
      <button
        type="button"
        className={`loom-mcp-ent ${call.outcome}`}
        data-testid={`mcp-call-${call.seq}`}
        data-outcome={call.outcome}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
      >
        <span className="loom-mcp-t" data-testid={call.at ? `mcp-call-${call.seq}-at` : undefined}>
          {call.at ? fmtClock(call.at) : ""}
        </span>
        <Glyph sub={call.subsystem} />
        <span className="loom-mcp-s"><Sentence call={call} /></span>
        <span className="loom-mcp-tool">{call.tool}</span>
        <Duration call={call} />
        <Mark outcome={call.outcome} />
      </button>
      {open && (
        <div className="loom-mcp-ob" id={bodyId} data-testid={`mcp-call-${call.seq}-detail`}>
          <div className="loom-mcp-obmeta">
            <span>router <b>{call.router}</b></span>
            {recorded ? <span>recorded call <b>#{call.seq}</b></span> : <span>call <b>#{call.seq}</b> this session</span>}
            {call.tag && <span>transcript tag <b>{`{${call.tag}}`}</b></span>}
            {call.at && <span>at <b>{fmtClock(call.at)}</b></span>}
            {call.ms != null && (recorded
              ? <span title={RECORD_DURATION_HINT}>took <b>{fmtMs(call.ms)}</b>, measured by Loom's router</span>
              : <span title={DURATION_HINT}>took <b>{approx(call.ms)}</b>, approximate: includes hook and harness time</span>)}
          </div>
          {recorded ? (
            <div className="loom-mcp-obnote">
              <p className="loom-mcp-hint" data-testid={`mcp-call-${call.seq}-not-kept`}>{RECORD_NOT_KEPT}</p>
              {call.outcome === "refused" && <p className="loom-mcp-hint refused">{RECORD_REFUSED_HINT}</p>}
            </div>
          ) : <>
          <div>
            <div className="loom-mcp-subh">Asked Loom</div>
            <pre className="loom-mcp-blk">{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          <div>
            <div className="loom-mcp-subh">Loom answered · first 2 KB</div>
            <pre className={`loom-mcp-blk ${call.outcome}`} data-testid={`mcp-call-${call.seq}-answer`}>
              {call.result ?? "No answer yet."}
            </pre>
            {call.outcome === "refused" && <p className="loom-mcp-hint refused">Read as refused. {REFUSED_HINT}</p>}
            {isUnclassified(call) && <p className="loom-mcp-hint">{UNCLASSIFIED_HINT}</p>}
          </div>
          <div className="loom-mcp-links">
            <span className="loom-mcp-subh">Touched</span>
            {links.length === 0 ? <span className="loom-mcp-muted">nothing named in the arguments</span>
              : links.map((l) => (
                <span key={`${l.kind}:${l.id}`} className="loom-mcp-lk"><span>{LINK_LABEL[l.kind]}</span>{l.id}</span>
              ))}
          </div>
          </>}
        </div>
      )}
    </>
  );
}

function FacetRow({ testId, lead, label, n, max, pressed, barClass, onClick }: {
  testId: string; lead: ReactNode; label: string; n: number; max: number; pressed: boolean; barClass: string; onClick: () => void;
}) {
  return (
    <button type="button" className="loom-mcp-fr" data-testid={testId} aria-pressed={pressed} onClick={onClick}>
      {lead}
      <span className="loom-mcp-nm">
        <span>{label}</span>
        <span className="loom-mcp-bar3"><i className={barClass} style={{ width: `${max ? (n / max) * 100 : 0}%` }} /></span>
      </span>
      <span className="loom-mcp-n">{n}</span>
    </button>
  );
}

function Facets({ calls, filter, setFilter }: { calls: McpCall[]; filter: McpFilter; setFilter: (f: McpFilter) => void }) {
  const recorded = useContext(SourceCtx) === "record";
  const subs = new Map(tally(calls, "subsystem"));
  const maxSub = Math.max(1, ...subs.values());
  const outcomes = new Map(tally(calls, "outcome"));
  const tools = tally(calls, "tool").slice(0, TOP_TOOLS);
  const maxTool = tools[0]?.[1] ?? 1;
  const routers = tally(calls, "router");
  const toggleIn = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    return next;
  };
  const outcomeKeys: McpOutcome[] = outcomes.has("pending") ? ["ok", "refused", "error", "pending"] : ["ok", "refused", "error"];
  const unclassified = calls.filter(isUnclassified).length;

  return (
    <aside className="loom-mcp-facets" aria-label="Filter calls">
      <div className="loom-mcp-fq">
        <div className="loom-mcp-fh">
          <span>Find</span>
          {filterActive(filter) && (
            <button type="button" data-testid="mcp-filter-clear" onClick={() => setFilter(emptyFilter())}>Clear filters</button>
          )}
        </div>
        <input
          className="loom-mcp-search"
          data-testid="mcp-filter-search"
          placeholder={recorded ? "tool name" : "tool, card, worker, key"}
          aria-label="Search calls"
          value={filter.query}
          onChange={(e) => setFilter({ ...filter, query: e.target.value })}
        />
      </div>
      <div>
        <div className="loom-mcp-fh"><span>Where it went</span></div>
        {SUBSYSTEMS.filter((s) => subs.has(s.key)).map((s) => (
          <FacetRow key={s.key} testId={`mcp-facet-sub-${s.key}`} lead={<Glyph sub={s.key} />} label={s.label}
            n={subs.get(s.key)!} max={maxSub} pressed={filter.subsystems.has(s.key)} barClass={`sub ${s.key}`}
            onClick={() => setFilter({ ...filter, subsystems: toggleIn(filter.subsystems, s.key) })} />
        ))}
      </div>
      <div>
        <div className="loom-mcp-fh"><span>How it went</span></div>
        {outcomeKeys.map((o) => (
          <FacetRow key={o} testId={`mcp-facet-outcome-${o}`} lead={<Mark outcome={o} />} label={OUTCOME_LABEL[o]}
            n={outcomes.get(o) ?? 0} max={calls.length} pressed={filter.outcomes.has(o)} barClass={`oc ${o}`}
            onClick={() => setFilter({ ...filter, outcomes: toggleIn(filter.outcomes, o) })} />
        ))}
        <p className="loom-mcp-legend" data-testid="mcp-refused-legend">
          <span className="loom-mcp-ocx refused" aria-hidden="true">!</span>
          {recorded ? " refused: the tool returned an error envelope." : " refused is a guess: the answer carried an error field."}
          {unclassified > 0 && (
            <span data-testid="mcp-unclassified-count" title={UNCLASSIFIED_HINT}>
              {" "}<b>{unclassified}</b> {unclassified === 1 ? "answer" : "answers"} too long to check.
            </span>
          )}
        </p>
      </div>
      <div>
        <div className="loom-mcp-fh"><span>Most called</span></div>
        {tools.map(([tool, n]) => (
          <FacetRow key={tool} testId={`mcp-facet-tool-${tool}`}
            lead={<Glyph sub={calls.find((c) => c.tool === tool)!.subsystem} />} label={tool}
            n={n} max={maxTool} pressed={filter.tool === tool} barClass="plain"
            onClick={() => setFilter({ ...filter, tool: filter.tool === tool ? "" : tool })} />
        ))}
      </div>
      <div>
        <div className="loom-mcp-fh"><span>Router</span></div>
        {routers.map(([router, n]) => (
          <FacetRow key={router} testId={`mcp-facet-router-${router}`} lead={<span className="loom-mcp-muted" aria-hidden="true">⌁</span>}
            label={router} n={n} max={calls.length} pressed={filter.router === router} barClass="plain"
            onClick={() => setFilter({ ...filter, router: filter.router === router ? "" : router })} />
        ))}
      </div>
    </aside>
  );
}
