import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RepoRegistryEntry } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Panel, SectionLabel, Dot, Button, Input } from "../components/ui";
import { color, font } from "../theme";

// Git view: branches + commit log (read), plus WRITE actions — checkout, create-branch, commit
// (stage-all + message), and push. Writes go through the daemon's HUMAN-only REST surface (no agent
// MCP tool); each returns a structured { ok, error } the UI shows. Scoped to the header's active project.
export default function Git() {
  const qc = useQueryClient();
  const { projectId, projects } = useActiveProject();
  const project = projects.find((p) => p.id === projectId) ?? null;
  // retry:false (matches Platform.tsx/MissionControl.tsx/requests.tsx's own expected-error queries): a
  // git read failure (corrupt repo, blocked env var) is deterministic, not transient — retrying 3x with
  // react-query's default backoff just delays the error by several seconds for no chance of success.
  const branches = useQuery({ queryKey: ["git-branches", projectId], queryFn: () => api.gitBranches(projectId), enabled: !!projectId, retry: false });
  const log = useQuery({ queryKey: ["git-log", projectId], queryFn: () => api.gitLog(projectId), enabled: !!projectId, retry: false });

  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");

  // Every write refetches branches + log so the view reflects the new HEAD/commit, and surfaces the
  // structured result (ok or git's own error) in the shared feedback line.
  const refresh = () => { qc.invalidateQueries({ queryKey: ["git-branches", projectId] }); qc.invalidateQueries({ queryKey: ["git-log", projectId] }); };
  const report = (ok: boolean, text: string) => setFeedback({ ok, text });

  const checkout = useMutation({
    mutationFn: (branch: string) => api.gitCheckout(projectId, branch),
    onSuccess: (r) => { refresh(); report(r.ok, r.ok ? `Switched to ${r.branch}` : (r.error ?? "checkout failed")); },
    onError: (e) => report(false, String(e)),
  });
  const createBranch = useMutation({
    mutationFn: (name: string) => api.gitCreateBranch(projectId, name),
    onSuccess: (r) => { refresh(); if (r.ok) setNewBranch(""); report(r.ok, r.ok ? `Created + switched to ${r.branch}` : (r.error ?? "create-branch failed")); },
    onError: (e) => report(false, String(e)),
  });
  const commit = useMutation({
    mutationFn: (msg: string) => api.gitCommit(projectId, msg),
    onSuccess: (r) => { refresh(); if (r.ok) setMessage(""); report(r.ok, r.ok ? `Committed ${r.hash?.slice(0, 7)}` : (r.error ?? "commit failed")); },
    onError: (e) => report(false, String(e)),
  });
  const push = useMutation({
    mutationFn: () => api.gitPush(projectId),
    onSuccess: (r) => { refresh(); report(r.ok, r.ok ? `Pushed ${r.branch}` : (r.error ?? "push failed")); },
    onError: (e) => report(false, String(e)),
  });
  const busy = checkout.isPending || createBranch.isPending || commit.isPending || push.isPending;

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && (
        <>
          {feedback && (
            <Panel style={{ marginTop: 12, borderColor: feedback.ok ? color.phosphor : color.red }}>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: feedback.ok ? color.phosphor : color.red }}>
                {feedback.ok ? "✓ " : "✗ "}{feedback.text}
              </span>
            </Panel>
          )}

          <Panel style={{ marginTop: 12 }}>
            <SectionLabel>Branches</SectionLabel>
            {/* Panel doesn't forward arbitrary props to its DOM node, so the e2e address hook lives on
                this plain div instead — see the analogous note on the Commits panel below. */}
            <div data-git-pane="branches">
              {branches.isError && <ErrorLine error={branches.error} />}
              {!branches.isError && branches.data && (
                <BranchList data={branches.data} busy={busy} onCheckout={(b) => checkout.mutate(b)} />
              )}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${color.border}` }}>
              <Input placeholder="new-branch-name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim() && !busy) createBranch.mutate(newBranch.trim()); }}
                style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={!newBranch.trim() || busy} onClick={() => createBranch.mutate(newBranch.trim())}>+ Branch</Button>
              <Button disabled={busy} onClick={() => push.mutate()}>{push.isPending ? "Pushing…" : "Push"}</Button>
            </div>
          </Panel>

          <Panel>
            <SectionLabel>Commit</SectionLabel>
            <div style={{ display: "flex", gap: 6 }}>
              <Input placeholder="commit message (stages all changes)" value={message} onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && message.trim() && !busy) commit.mutate(message.trim()); }}
                style={{ flex: 1, minWidth: 0 }} />
              <Button variant="primary" disabled={!message.trim() || busy} onClick={() => commit.mutate(message.trim())}>{commit.isPending ? "Committing…" : "Commit"}</Button>
            </div>
          </Panel>

          <Panel style={{ maxHeight: "50vh", overflow: "auto" }}>
            <SectionLabel>Commits</SectionLabel>
            {/* Panel (components/ui) doesn't spread arbitrary props onto its DOM node — a data attribute
                passed directly to it is accepted by TS (data- and aria- names bypass excess-property
                checks on any JSX element) but silently dropped at runtime, never reaching the DOM. The
                e2e address hook needs a plain element Panel actually renders, hence this wrapper div. */}
            <div data-git-pane="primary-log">
              {log.isError ? <ErrorLine error={log.error} /> : <CommitTable commits={log.data} />}
            </div>
          </Panel>

          {/* Reference repos (reference-repos epic Phase 5, card f4888775) — read-only git log per bound
              sibling repo, reusing the SAME CommitTable rendering as the primary repo above. Each panel is
              collapsed by default and fetches its log lazily (enabled:open) so mounting the Git tab doesn't
              eagerly shell out to git for every reference repo. */}
          {project && project.referenceRepos.length > 0 && (
            <Panel>
              <SectionLabel>Reference Repos</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {project.referenceRepos.map((path, i) => (
                  <ReferenceRepoLog key={path} projectId={projectId} index={i} path={path} />
                ))}
              </div>
            </Panel>
          )}

          {/* Registered repos (multi-repo epic 49136451, phase 3) — the WRITABLE registry, distinct from
              the read-only reference repos above: a card can be routed at one of these, and it gets its
              own worktree, branch and gate. Read surfaces only this phase (the git-WRITE controls at the
              top of this page still act on the primary repo alone). Same lazy collapsed treatment. */}
          {project && project.repos.length > 0 && (
            <Panel>
              <SectionLabel>Registered Repos</SectionLabel>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
                writable · a card targets one by its key
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                {project.repos.map((r, i) => (
                  <RegisteredRepoLog key={r.key} projectId={projectId} index={i} entry={r} />
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

// The branch list degrades gracefully at ~300 refs (card a044b33b). A healthy Loom project accumulates a
// worker branch (`loom/<id>`) per dispatched card, so the raw `git branch` list is dominated by opaque
// hashes a human can't scan. Three moves make it usable without hiding anything:
//   1. a substring FILTER over every branch name (the highest-value affordance);
//   2. the CURRENT branch pinned prominently at the top instead of buried alphabetically;
//   3. the `loom/*` worker branches folded into a collapsed "worker branches (N)" disclosure, so the
//      default view shows what a human actually NAMED — with the count always visible, never a silent
//      truncation. A live filter auto-expands the fold so a matching worker branch is never hidden.
// NOTE we fold ALL worker branches, not merged ones specifically — `GET …/git/branches` returns only
// { current, all } with no merged signal, and telling merged from unmerged is a daemon change owned
// elsewhere. Likewise a `loom/<hash>` is shown verbatim (no card-title resolution): that mapping has no
// endpoint today and resolving per-branch would be an N+1 — both were scoped out of this UI-only card.
const isWorkerBranch = (b: string) => b.startsWith("loom/");

function branchButtonStyle(c: string, busy: boolean) {
  return {
    display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none",
    cursor: busy ? "default" : "pointer", padding: 0, textAlign: "left" as const,
    fontFamily: font.mono, fontSize: 12, color: c,
  };
}

function BranchList({ data, busy, onCheckout }: {
  data: { current: string; all: string[] };
  busy: boolean;
  onCheckout: (b: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [workersOpen, setWorkersOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const matches = (b: string) => q === "" || b.toLowerCase().includes(q);

  const current = data.current || null;
  // Partition into current / human-named / worker(`loom/*`) — current is pulled out of both lists so it
  // renders once, pinned, and never double-counts.
  const named = data.all.filter((b) => b !== current && !isWorkerBranch(b));
  const workers = data.all.filter((b) => b !== current && isWorkerBranch(b));
  const namedShown = named.filter(matches);
  const workersShown = workers.filter(matches);
  const otherTotal = named.length + workers.length;
  const otherShown = namedShown.length + workersShown.length;

  // A live filter forces the worker fold open so a matching `loom/*` branch is never hidden behind it.
  const showWorkers = q !== "" || workersOpen;

  const checkoutBtn = (b: string) => (
    <button key={b} title="checkout" disabled={busy} onClick={() => onCheckout(b)}
      style={branchButtonStyle(color.textDim, busy)}>
      {b}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <Input aria-label="Filter branches" placeholder="filter branches…" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, whiteSpace: "nowrap" }}>
          {q === "" ? `${data.all.length} branches` : `${otherShown} of ${otherTotal} match`}
        </span>
      </div>

      {/* Current branch — pinned at the top, always visible. Kept a (disabled) button whose accessible
          name is exactly the branch name; the "current" tag is a SIBLING so it doesn't leak into that
          name (repository.spec keys `getByRole("button", { name: /^(main|master)$/ })` on it). */}
      {current && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: named.length || workers.length ? 12 : 0 }}>
          <button title="current branch" disabled style={{ ...branchButtonStyle(color.phosphor, true), cursor: "default" }}>
            <Dot tone="phosphor" glow />{current}
          </button>
          <span style={{ fontFamily: font.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted }}>
            current
          </span>
        </div>
      )}

      {/* Human-named branches — the default, scannable view. */}
      {named.length > 0 && (
        namedShown.length > 0
          ? <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>{namedShown.map(checkoutBtn)}</div>
          : <Hint>no named branches match “{query.trim()}”</Hint>
      )}

      {/* Worker branches — folded away by default so hashes don't drown the named branches, with the
          count always shown. */}
      {workers.length > 0 && (
        <div style={{ marginTop: named.length > 0 ? 12 : 0, paddingTop: named.length > 0 ? 10 : 0, borderTop: named.length > 0 ? `1px solid ${color.border}` : "none" }}>
          <button onClick={() => setWorkersOpen((o) => !o)}
            aria-expanded={showWorkers}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
            <span style={{ color: color.phosphor }}>{showWorkers ? "▾" : "▸"}</span>
            worker branches ({q === "" ? workers.length : `${workersShown.length} of ${workers.length}`})
          </button>
          {showWorkers && (
            <div style={{ marginTop: 8, maxHeight: "40vh", overflow: "auto" }}>
              {workersShown.length > 0
                ? <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>{workersShown.map(checkoutBtn)}</div>
                : <Hint>no worker branches match “{query.trim()}”</Hint>}
            </div>
          )}
        </div>
      )}

      {otherTotal === 0 && !current && <Hint>no branches</Hint>}
    </div>
  );
}

// Shared commit-table rendering, reused by both the primary repo's log and each reference repo's log below.
// A commitless repo (e.g. straight out of `git init`) is a valid, expected state — the daemon returns an
// empty list rather than an error, so an empty (but defined, i.e. loaded) list renders an honest empty
// state instead of a blank table that reads as broken.
function CommitTable({ commits }: { commits: { hash: string; date: string; message: string; author: string }[] | undefined }) {
  if (commits && commits.length === 0) {
    return <Hint>no commits yet</Hint>;
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: font.mono, fontSize: 13 }}>
      <tbody>
        {commits?.map((c) => (
          <tr key={c.hash} style={{ borderTop: `1px solid ${color.border}` }}>
            <td style={{ color: color.cyan, padding: "3px 8px 3px 0", whiteSpace: "nowrap" }}>{c.hash.slice(0, 7)}</td>
            <td style={{ color: color.text, padding: "3px 8px 3px 0" }}>{c.message}</td>
            <td style={{ color: color.textMuted, padding: "3px 0", whiteSpace: "nowrap" }}>{c.author}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// One collapsible read-only git log for a single bound reference repo. `index` is the repo's position in
// project.referenceRepos — the daemon resolves the actual path SERVER-side from that index, so this client
// never sends a host path over the wire (see the endpoint's security note in gateway/server.ts).
function ReferenceRepoLog({ projectId, index, path }: { projectId: string; index: number; path: string }) {
  const [open, setOpen] = useState(false);
  const log = useQuery({
    queryKey: ["reference-repo-git-log", projectId, index],
    queryFn: () => api.referenceRepoGitLog(projectId, index),
    enabled: open,
    retry: false, // a git read failure is deterministic — see the primary branches/log queries above
  });
  return (
    <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: 0,
          fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>{path}
      </button>
      {open && (
        <div style={{ marginTop: 8, maxHeight: "40vh", overflow: "auto" }} data-git-pane={`reference-repo-${index}`}>
          {log.isLoading && <Hint>loading log…</Hint>}
          {log.isError ? <ErrorLine error={log.error} /> : <CommitTable commits={log.data} />}
        </div>
      )}
    </div>
  );
}

// One collapsible read-only git log for a single REGISTERED repo. Mirrors ReferenceRepoLog exactly —
// `index` is the entry's position in project.repos and the daemon resolves the path SERVER-side from it,
// so this client never sends a host path over the wire. Beyond that it shows the two facts the reference
// list has no equivalent of: the repo's KEY (what a card's repoKey names) and whether it has a gate — a
// gateless registered repo merges as unverified, and it does NOT inherit the project's gate command.
function RegisteredRepoLog({ projectId, index, entry }: { projectId: string; index: number; entry: RepoRegistryEntry }) {
  const [open, setOpen] = useState(false);
  const log = useQuery({
    queryKey: ["registered-repo-git-log", projectId, index],
    queryFn: () => api.registeredRepoGitLog(projectId, index),
    enabled: open,
    retry: false, // a git read failure is deterministic — see the primary branches/log queries above
  });
  return (
    <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: 0,
          fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: color.cyan }}>{entry.key}</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.path}</span>
        <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 11, color: entry.gateCommand ? color.textMuted : color.amber }}
          title={entry.gateCommand
            ? `This repo's own gate command — the merge gate and a worker's run_gate both run this here`
            : "No gate command configured — work merged here is reported unverified. It does not fall back to this project's gate command."}>
          {entry.gateCommand ? `gate: ${entry.gateCommand}` : "no gate"}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8, maxHeight: "40vh", overflow: "auto" }} data-git-pane={`registered-repo-${index}`}>
          {log.isLoading && <Hint>loading log…</Hint>}
          {log.isError ? <ErrorLine error={log.error} /> : <CommitTable commits={log.data} />}
        </div>
      )}
    </div>
  );
}

// Shared cause-naming error line for a failed git read — one look across the primary Branches/Commits
// panels and both secondary (reference/registered repo) panels, so the four surfaces render consistently
// instead of three different not-quite-matching shapes (card 60b53c8d).
function ErrorLine({ error }: { error: unknown }) {
  return <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{(error as Error).message}</span>;
}

function Hint({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{children}</span>;
}
