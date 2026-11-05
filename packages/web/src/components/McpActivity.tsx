// The session's Loom MCP activity strip, under the composer on the Atlas session node (card a9a7140c,
// owner pick B · Ledger). Compact: the latest Loom call as a sentence. Expanded: every call grouped by
// agent turn, a facet rail, and an inline "Asked Loom / Loom answered" per call. Data and its limits:
// lib/mcpActivity.ts. Arguments and results are agent-authored text and render as React text only.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  applyFilter, emptyFilter, filterActive, groupByTurn, linksOf, mcpPollInterval, parseMcpCalls, sentenceOf, tally,
  SUBSYSTEMS, type McpCall, type McpFilter, type McpOutcome, type McpSubsystem,
} from "../lib/mcpActivity";

const OUTCOME_MARK: Record<McpOutcome, string> = { ok: "✓", error: "✕", pending: "…" };
const OUTCOME_LABEL: Record<McpOutcome, string> = { ok: "ok", error: "error", pending: "no answer yet" };
const LINK_LABEL = { card: "card", worker: "worker", gate: "gate op", note: "note", request: "request" } as const;
const MAX_BEADS = 12;
const TOP_TOOLS = 6;

function Glyph({ sub }: { sub: McpSubsystem }) {
  return <span className={`loom-mcp-gl ${sub}`} aria-hidden="true" />;
}

function Mark({ outcome }: { outcome: McpOutcome }) {
  return (
    <span className={`loom-mcp-ocx ${outcome}`} role="img" aria-label={OUTCOME_LABEL[outcome]}>
      {OUTCOME_MARK[outcome]}
    </span>
  );
}

function Sentence({ call }: { call: McpCall }) {
  const s = sentenceOf(call);
  return (
    <>
      {s.lead}
      {s.object && <> <b>{s.object}</b></>}
      {s.tail && <> <span className="loom-mcp-tail">{s.tail}</span></>}
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  const t = useQuery({
    queryKey: ["transcript", sessionId],
    queryFn: () => api.transcript(sessionId),
    refetchInterval: mcpPollInterval({ hidden, expanded, busy }),
  });
  const calls = useMemo(() => parseMcpCalls(t.data ?? []), [t.data]);
  const panelId = useId();

  if (!calls.length) {
    const note = t.isError ? "Couldn't read this session's transcript."
      : t.isLoading ? "Reading the transcript…"
      : harness === "codex" ? "Codex sessions don't show their Loom calls here yet."
      : "No Loom MCP calls yet this session.";
    return (
      <div className="loom-mcp" data-testid="mcp-activity" data-state="empty">
        <div className="loom-mcp-empty-bar"><span className="loom-mcp-lab">Loom MCP</span><span>{note}</span></div>
      </div>
    );
  }

  const latest = calls[calls.length - 1]!;
  const turnCalls = calls.filter((c) => c.turn === latest.turn);
  const errors = calls.filter((c) => c.outcome === "error").length;
  const beads = turnCalls.slice(-MAX_BEADS);

  return (
    <div className={`loom-mcp${expanded ? " open" : ""}`} data-testid="mcp-activity">
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
          <span>· turn {latest.turn}</span>
          <span className="loom-mcp-beads" aria-label={`${plural(turnCalls.length, "call")} this turn`}>
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
          <span className="loom-mcp-meta">{latest.tool}</span>
        </span>
        <span className="loom-mcp-right">
          <span>
            <span data-testid="mcp-activity-count">{calls.length}</span>
            {calls.length === 1 ? " call" : " calls"}
            {errors > 0 && <span className="loom-mcp-errn"> · {plural(errors, "error")}</span>}
          </span>
          <span className="loom-mcp-chev" aria-hidden="true">▾</span>
        </span>
      </button>
      {expanded && <Expanded id={panelId} calls={calls} />}
    </div>
  );
}

function Expanded({ id, calls }: { id: string; calls: McpCall[] }) {
  const [filter, setFilter] = useState<McpFilter>(emptyFilter);
  const [openSeq, setOpenSeq] = useState<ReadonlySet<number>>(() => new Set());
  const shown = useMemo(() => applyFilter(calls, filter), [calls, filter]);
  const groups = useMemo(() => groupByTurn(shown), [shown]);
  // A turn header counts the WHOLE turn, not the filtered slice, so a filter never misstates the turn.
  const turnTotals = useMemo(() => {
    const m = new Map<number, { n: number; err: number; calls: McpCall[] }>();
    for (const c of calls) {
      const e = m.get(c.turn) ?? { n: 0, err: 0, calls: [] };
      e.n++; if (c.outcome === "error") e.err++; e.calls.push(c);
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
      <div className="loom-mcp-log" data-testid="mcp-activity-log" role="list" aria-label="Loom calls by turn">
        {groups.length === 0 ? (
          <p className="loom-mcp-none">No calls match. Clear a filter to widen it.</p>
        ) : groups.map((g) => {
          const tot = turnTotals.get(g.turn)!;
          return (
            <div key={g.turn} role="listitem" className="loom-mcp-turn" data-testid={`mcp-turn-${g.turn}`}>
              <div className="loom-mcp-turnh">
                <span className="loom-mcp-tn">Turn {g.turn}</span>
                <span>{plural(tot.n, "call")}{tot.err > 0 && <span className="loom-mcp-errn"> · {plural(tot.err, "error")}</span>}</span>
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
        <Glyph sub={call.subsystem} />
        <span className="loom-mcp-s"><Sentence call={call} /></span>
        <span className="loom-mcp-tool">{call.tool}</span>
        <Mark outcome={call.outcome} />
      </button>
      {open && (
        <div className="loom-mcp-ob" id={bodyId} data-testid={`mcp-call-${call.seq}-detail`}>
          <div className="loom-mcp-obmeta">
            <span>router <b>{call.router}</b></span>
            <span>call <b>#{call.seq}</b> this session</span>
            {call.tag && <span>transcript tag <b>{`{${call.tag}}`}</b></span>}
          </div>
          <div>
            <div className="loom-mcp-subh">Asked Loom</div>
            <pre className="loom-mcp-blk">{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          <div>
            <div className="loom-mcp-subh">Loom answered · first 2 KB</div>
            <pre className={`loom-mcp-blk ${call.outcome}`} data-testid={`mcp-call-${call.seq}-answer`}>
              {call.result ?? "No answer yet."}
            </pre>
          </div>
          <div className="loom-mcp-links">
            <span className="loom-mcp-subh">Touched</span>
            {links.length === 0 ? <span className="loom-mcp-muted">nothing named in the arguments</span>
              : links.map((l) => (
                <span key={`${l.kind}:${l.id}`} className="loom-mcp-lk"><span>{LINK_LABEL[l.kind]}</span>{l.id}</span>
              ))}
          </div>
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
  const outcomeKeys: McpOutcome[] = outcomes.has("pending") ? ["ok", "error", "pending"] : ["ok", "error"];

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
          placeholder="tool, card, worker, key"
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
