import { useMemo, useState } from "react";
import { errorText } from "../lib/loopbackCredential";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, workerDiffQuery } from "../lib/api";
import { Panel, Button, SectionLabel, Chip, Dot, Badge } from "./ui";
import { FileDiffBlock, FileOverviewRow } from "./Diff";
import { analyzeDiff, defaultOpenPaths, riskOrder, riskTone } from "../lib/diff";
import { color, font, tone, fs, radius } from "../theme";

// The human-in-the-loop REVIEW & MERGE gate — the product's fast-triage centerpiece. A worker's
// branch diff is parsed CLIENT-SIDE (lib/diff) into an auto-summary, a risk-ranked file overview, and
// per-file collapsible hunks, with one-step Approve & merge / Request-changes wired to the EXISTING
// daemon merge gate (fail-closed build gate → squash-merge) and the sendInput turn surface. Reached
// from the review queue. The merge logic itself is unchanged — this only surfaces it.
//
// It lives in components/ rather than pages/ because it is the worker session node's Diff pane
// (card 525c8ad9), which `/review/:workerId` renders. Keeping it in pages/ and importing it from the
// node would have made a page↔component cycle.
//
// Every caller must key it on the worker id, so result / note / openFiles never carry across a
// review→review switch (latent stale-banner / lost-open-by-default guard — card 496fe90e).
export function ReviewSurface({ workerId }: { workerId: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: ({ signal }) => api.allSessions(signal) });
  const worker = (sessions.data ?? []).find((s) => s.id === workerId);
  // Shares the Review-queue card's cache entry (same key via workerDiffQuery), so arriving here from a
  // card — the normal path — renders the diff from cache instead of re-issuing the git call.
  const diff = useQuery({ ...workerDiffQuery(workerId), enabled: !!workerId });

  const merge = useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.mergeWorker(workerId),
    // `pending` (merged:null, card 361520a0 Half Four) means the gate is STILL running — checked BEFORE
    // `r.merged` below, which used to read the pending case's `false` as a genuine rejection and show
    // "rejected — …" for a merge that was never actually refused (the exact re-click bait this card's
    // dedupe exists to prevent).
    onSuccess: (r) => { setResult(r.pending ? `still running — ${r.reason}` : r.merged ? "✓ merged to main" : `rejected — ${r.reason}`); qc.invalidateQueries({ queryKey: ["allSessions"] }); },
    onError: (e) => setResult(`error — ${errorText(e)}`),
  });
  const requestChanges = useMutation({
    mutationFn: () => api.sendInput(workerId, `[loom:review] Changes requested before merge:\n${note}`),
    onSuccess: (r) => { setResult(r.delivered ? "changes requested (sent to worker)" : "worker not live — couldn't send"); setNote(""); },
  });

  // Parse + risk-rank once per diff payload. Files for the OVERVIEW are sorted risk-desc then by churn
  // so the load-bearing changes sit at the top; the DIFF blocks below keep git's original file order
  // (so a reviewer reading top-to-bottom sees a coherent change), but high/medium files open by
  // default and low-risk ones fold away.
  // Headline file/±totals are single-sourced from the backend numstat (diff.data) — the SAME source the
  // header chip reads — so the summary and chip can never disagree on a parse undercount (card dc97b111).
  // The per-file overview below still uses the parsed hunks.
  const analysis = useMemo(() => (diff.data ? analyzeDiff(diff.data.patch, diff.data) : null), [diff.data]);
  const overview = useMemo(() => {
    if (!analysis) return [];
    return [...analysis.files].sort((a, b) =>
      riskOrder(b.risk) - riskOrder(a.risk) || (b.insertions + b.deletions) - (a.insertions + a.deletions));
  }, [analysis]);

  // Which file blocks are expanded — keyed by path. Seeded (on first analysis) by defaultOpenPaths:
  // every file of a small diff, else only the high/medium-risk ones.
  const [openFiles, setOpenFiles] = useState<Set<string> | null>(null);
  const open = openFiles ?? new Set(analysis ? defaultOpenPaths(analysis.files) : []);
  const toggleFile = (path: string) => setOpenFiles(() => {
    const next = new Set(open);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });
  const jumpTo = (path: string) => {
    setOpenFiles(() => { const next = new Set(open); next.add(path); return next; });
    requestAnimationFrame(() => document.getElementById(`file-${path}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const merged = diff.data?.merged;
  const uncommitted = diff.data?.uncommitted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* No identity run (`← back` / MERGE REQUEST / `worker w:…`): the frame's crumb trail and node
          head state all three, and the node head carries the context meter. The branch + diffstat chips
          stay: they are about THIS REVIEW, not about which session you are looking at. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {worker?.branch && <Chip label="branch" value={`${worker.branch} → main`} tone="muted" />}
        {diff.data && <Chip value={`${diff.data.filesChanged} files · +${diff.data.insertions} −${diff.data.deletions}`} tone="muted" />}
      </div>

      {!workerId && <Panel><span style={{ color: color.text3 }}>No worker.</span></Panel>}
      {workerId && diff.isError && <Panel><span style={{ color: color.danger, fontSize: fs.sm }}>No diff (worker has no branch, or it was merged/removed).</span></Panel>}

      {/* Auto-summary + risk surface — read this BEFORE the raw diff. */}
      {analysis && (
        <Panel style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `2px solid ${analysis.highRisk ? color.danger : analysis.mediumRisk ? color.attn : color.live}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <SectionLabel style={{ margin: 0 }}>Summary</SectionLabel>
            <span style={{ fontSize: fs.sm, color: color.text3 }}>auto-derived</span>
            <span style={{ flex: 1 }} />
            {merged && <Badge tone="live">already merged</Badge>}
            {uncommitted && <Badge tone="attn">uncommitted</Badge>}
            <Badge tone={analysis.highRisk ? "danger" : analysis.mediumRisk ? "attn" : "live"}>
              {analysis.highRisk ? `${analysis.highRisk} high-risk` : analysis.mediumRisk ? `${analysis.mediumRisk} to watch` : "low risk"}
            </Badge>
          </div>

          <div style={{ fontSize: fs.body, color: color.text, lineHeight: 1.5 }}>{analysis.headline}</div>

          {/* Touched-area roll-up */}
          {analysis.areas.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {analysis.areas.map((a) => <Chip key={a.area} label={a.area} value={a.count} />)}
            </div>
          )}

          {/* Risk callout: the high/medium files + why, so attention lands here first. */}
          {(analysis.highRisk > 0 || analysis.mediumRisk > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: `1px solid ${color.line}`, paddingTop: 8 }}>
              {analysis.files.filter((f) => f.risk !== "low")
                .sort((a, b) => riskOrder(b.risk) - riskOrder(a.risk))
                .map((f) => (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: fs.sm }}>
                    <Dot tone={riskTone(f.risk)} glow={f.risk === "high"} />
                    <button onClick={() => jumpTo(f.path)} className="loom-btn"
                      style={{ background: "transparent", border: "none", color: color.text2, cursor: "pointer", padding: 0, fontFamily: font.mono, fontSize: fs.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360, textAlign: "left" }}
                      title={`jump to ${f.path}`}>{f.path}</button>
                    <span style={{ color: tone[riskTone(f.risk)], fontSize: fs.sm }}>{f.reasons.join(", ")}</span>
                  </div>
                ))}
            </div>
          )}
        </Panel>
      )}

      {/* Decision — placed high so triage is one decision, not a scroll-to-the-bottom hunt. */}
      {diff.data && (
        <Panel>
          {/* The decision row is FLUID, never fixed-width (card 525c8ad9). A `width: 320` textarea in a
              non-wrapping span gave this cluster a ~456px min-content, which overflowed the ~370px Atlas
              content column at a 420px viewport by 61px — off the right of the screen, with the Request
              changes button unreachable. The classic page had the same defect, so the fix is here rather
              than behind the Atlas switch: let the cluster wrap, and let the textarea take a flex BASIS
              with a max-width so it grows on a wide row and gives way on a narrow one. */}
          <div className="rv-decide" style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Button variant="primary" disabled={merge.isPending || merged} onClick={() => { setResult(null); merge.mutate(); }}>
              {merge.isPending ? "Running build gate…" : merged ? "Merged" : "Approve & merge"}
            </Button>
            <span className="rv-changes" style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap", flex: "1 1 320px", minWidth: 0 }}>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="changes to request (sent to the worker as a turn)…"
                style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 420, resize: "vertical", boxSizing: "border-box", background: color.inset, color: color.text, border: `1px solid ${color.lineStrong}`, borderRadius: radius.sm, padding: "6px 8px", fontFamily: font.ui, fontSize: fs.sm }} />
              <Button variant="danger" disabled={!note.trim() || requestChanges.isPending} onClick={() => requestChanges.mutate()}>Request changes</Button>
            </span>
          </div>
          <p style={{ color: color.text3, fontSize: fs.sm, marginTop: 8 }}>
            Approve runs the project's build/DoD gate in the worktree (fail-closed) before squash-merging; on green the worktree is removed and the task closed. Request changes sends your note to the worker as a turn.
          </p>
          {result && <div style={{ marginTop: 8, fontSize: fs.body, color: result.startsWith("✓") ? color.liveFg : result.startsWith("error") || result.startsWith("rejected") ? color.danger : result.startsWith("still running") ? color.workText : color.attnText }}>{result}</div>}
        </Panel>
      )}

      {/* File overview (risk-ranked) + the per-file diff. The two-column grid and its narrow collapse
          live in global.css (`.rv-files`), keyed to THIS surface's own width via a container query
          rather than the viewport: the Atlas tree eats 244px, so at a 768px viewport the content column
          is ~480px and a 220px Files column would leave the diff a sliver. Narrow, it goes one column
          and the Files list is dropped, since each Diff header already carries the same row (card
          2b7826f4: at 390px the Diff column was clipped off-screen and could not be opened). */}
      {analysis && analysis.files.length > 0 && (
        <div className="rv-files" data-testid="review-files">
          <div className="rv-files-grid">
            <div className="rv-files-list" style={{ position: "sticky", top: 12 }}>
              <SectionLabel>Files ({analysis.files.length})</SectionLabel>
              <Panel style={{ maxHeight: "60vh", overflow: "auto", padding: 6 }}>
                {overview.map((f) => <FileOverviewRow key={f.path} file={f} onJump={() => jumpTo(f.path)} />)}
              </Panel>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <SectionLabel>Diff</SectionLabel>
              {analysis.files.map((f) => (
                <FileDiffBlock key={f.path} file={f} anchorId={`file-${f.path}`} open={open.has(f.path)} onToggle={() => toggleFile(f.path)} />
              ))}
            </div>
          </div>
        </div>
      )}

      {analysis && analysis.files.length === 0 && diff.data && (
        <Panel><span style={{ color: color.text3 }}>{diff.data.patch ? "Could not parse the diff." : "No changes vs main."}</span></Panel>
      )}
    </div>
  );
}
