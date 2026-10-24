// PROJECT LIFECYCLE — the five HUMAN-only writes that create, rename, re-bind, archive and destroy a
// project, plus the two repo-list editors that ride the same save surface. ONE implementation, two
// frames: the classic Projects page's "Manage project" collapsible (pages/Projects.tsx) and the Atlas
// project node's Settings tab (pages/Settings.tsx's `project-lifecycle` section).
//
// Moved here from pages/Projects.tsx by card c9b78d80, verbatim — the same move card 318b5a21 made for
// the agent editor, and for the same reason: the Atlas design dissolves /projects into the tree plus a
// per-project Settings tab (card 5afd71bd), so these five surfaces needed a second host. A second COPY
// of a permanent-delete confirm is the last thing this codebase should carry.
//
// @decision c9b78d80 — one lifecycle implementation. Never fork these controls per shell, and never
// relax the delete confirm in a new frame: it is a type-the-project-name gate over an irreversible
// cascade, and the frame it renders in has no bearing on that.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorText } from "../lib/loopbackCredential";
import type { Project, RepoRegistryEntry, StalePromptWarning } from "@loom/shared";
import { api } from "../lib/api";
import { Button, Input, SectionLabel, StaleStartupPromptWarning } from "./ui";
import { color, font } from "../theme";

/**
 * The FOUR project lifecycle writes, wired once: the structural rename/vaultPath PATCH, the reversible
 * archive, the restore back out of it, and the PERMANENT delete.
 *
 * Every host gets the SAME react-query invalidations, so no frame can hold a staler project list than
 * another: `["projects"]` on all four, plus `["archivedProjects"]` on the three that move a project
 * between those two lists. Hosts differ only in what happens AFTERWARDS — clearing a selection that
 * just stopped existing — which the two optional hooks do, BEFORE the invalidations, as the original
 * call site ordered them.
 *
 * @decision c9b78d80 — never fork these writes per shell; a second copy drifts its invalidation set.
 *
 * ⛔ No `meta: { inlineError: true }` on any of them, deliberately — matching `useAgentWrites`: no host
 * renders these mutations' own `.isError`, so the global mutation-error handler (src/main.tsx) is what
 * discloses a refusal (the server's "stop the fleet first" / reserved-home guards). The two repo-list
 * editors below DO opt out and render their own message — test/loopback-credential.mjs fails on half.
 */
export function useProjectLifecycleWrites(
  hooks: { onArchived?: (id: string) => void; onDeleted?: (id: string) => void } = {},
) {
  const qc = useQueryClient();
  const invalidateLists = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["archivedProjects"] });
  };
  const update = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; vaultPath?: string } }) => api.updateProject(v.id, v.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.archiveProject(id),
    onSuccess: (_r, id) => { hooks.onArchived?.(id); invalidateLists(); },
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreProject(id),
    onSuccess: invalidateLists,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProjectPermanent(id),
    onSuccess: (_r, id) => { hooks.onDeleted?.(id); invalidateLists(); },
  });
  return { update, archive, restore, remove };
}

// The strong-confirm body for a PERMANENT project delete — names the irreversible cascade and asks the
// human to type the project name back. The copy for `ArchivedProjects`' native prompt, in both of its
// frames. (`ProjectManage` below states the same cascade in its own INLINE reveal instead, because it
// has a panel to render one in; an archived row does not.) Exported so a spec can assert the copy
// rather than re-typing it.
export function deletePrompt(name: string): string {
  return `PERMANENTLY delete "${name}" and ALL of it — its agents, sessions, tasks, schedules, API keys, runs and saved transcripts. This CANNOT be undone.\n\nType the project name (${name}) to confirm:`;
}

// Per-project management: rename + edit vaultPath (Save), soft-archive (reversible "delete"), and a
// PERMANENT delete behind a type-the-name confirm naming the cascade. Archive + permanent-delete are
// DISABLED while the project has a live session (the server blocks them too — "stop the fleet first").
// Reserved/system projects never reach here (they're excluded from the project list this renders from).
//
// `collapsible` is the FRAME, and the only thing the two hosts differ by. It defaults to the classic
// Projects page's shape — a bordered "▸ Manage project" disclosure, closed on mount — so that call site
// is untouched. The Atlas project node's Settings tab passes `false`: there the section already has its
// own `SectionLabel` heading and a Panel around it, so a second disclosure inside would be a header
// under a header, and a collapse there would be a place for unfinished input to go (the owner's
// mount-once directive for node tabs, card 25c08fba, reads the same way about a settings surface).
// The draft state below is declared ABOVE that split and in BOTH shapes, never inside the `open`
// branch: it is what keeps a half-typed rename alive across a collapse on the classic page.
export function ProjectManage(
  { project, liveCount, onSave, onArchive, onDelete, saving, archiving, deleting, staleStartupPrompts, collapsible = true }:
  { project: Project; liveCount: number; onSave: (patch: { name?: string; vaultPath?: string }) => void;
    onArchive: () => void; onDelete: () => void; saving: boolean; archiving: boolean; deleting: boolean;
    staleStartupPrompts?: StalePromptWarning[]; collapsible?: boolean },
) {
  const [open, setOpen] = useState(!collapsible);
  const [name, setName] = useState(project.name);
  const [vaultPath, setVault] = useState(project.vaultPath);
  const [confirmText, setConfirmText] = useState("");
  const [showDelete, setShowDelete] = useState(false);
  // A vault-ONLY project (no separate repo) can't unbind its vault: that'd leave it with nothing bound
  // at all. Any other project CAN clear the field to unbind (card 9fe578b3) — an explicit "" is distinct
  // from leaving the field untouched, so a blank Save sends the unbind, not a no-op. `project.vaultOnly`
  // is the server's own explicit fact (card b98957e9) — never re-derived client-side from
  // repoPath/vaultPath equality, which also matched a legacy repo-bound project from before cdc3792d.
  const isVaultOnly = project.vaultOnly;
  const vaultTrim = vaultPath.trim();
  const dirty = (name.trim() !== project.name || vaultTrim !== project.vaultPath) && !!name.trim() && (vaultTrim !== "" || !isVaultOnly);
  const live = liveCount > 0;
  const liveTitle = live ? `stop the fleet first — ${liveCount} live session${liveCount === 1 ? "" : "s"}` : undefined;
  const body = (
    <>
      {open && (
        <div data-testid="project-manage-fields" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder={isVaultOnly ? "vault path" : "vault path (clear + Save to unbind)"}
            value={vaultPath} onChange={(e) => setVault(e.target.value)} />
          {isVaultOnly && vaultTrim === "" && (
            <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
              This project has no separate repo — its vault can't be unbound. Archive it instead.
            </span>
          )}
          <Button variant="primary" disabled={!dirty || saving}
            onClick={() => onSave({ name: name.trim(), vaultPath: vaultTrim })}>{saving ? "Saving…" : "Save changes"}</Button>
          {/* Stale-prompt lint (card 0597e092): the save SUCCEEDED, but a rename/vaultPath change left an
              agent's startupPrompt still naming the OLD value. WARN-only — nothing was auto-edited. */}
          <StaleStartupPromptWarning warnings={staleStartupPrompts} />
          <ReferenceReposEditor project={project} />
          <RepoRegistryEditor project={project} />
          <Button disabled={live || archiving} title={liveTitle}
            onClick={() => { if (window.confirm(`Archive "${project.name}"? It moves to the Archived section and can be restored later.`)) onArchive(); }}>
            {archiving ? "Archiving…" : "Archive (reversible)"}
          </Button>
          {!showDelete
            ? <Button variant="danger" disabled={live} title={liveTitle} onClick={() => { setShowDelete(true); setConfirmText(""); }}>Delete permanently…</Button>
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, border: `1px solid ${color.red}`, borderRadius: 4, padding: 8 }}>
                <span style={{ fontFamily: font.mono, fontSize: 11, color: color.red }}>
                  Permanently delete this project and ALL of it — agents, sessions, tasks, schedules, keys, runs, transcripts. Cannot be undone. Type <strong>{project.name}</strong> to confirm:
                </span>
                <Input autoFocus placeholder={project.name} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
                <div style={{ display: "flex", gap: 6 }}>
                  <Button variant="danger" disabled={confirmText !== project.name || live || deleting} title={liveTitle}
                    onClick={onDelete}>{deleting ? "Deleting…" : "Delete forever"}</Button>
                  <Button onClick={() => setShowDelete(false)}>Cancel</Button>
                </div>
              </div>
            )}
        </div>
      )}
    </>
  );
  if (!collapsible) return body;
  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: "2px 0",
          fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>Manage project
      </button>
      {body}
    </div>
  );
}

// Soft-archived projects — restore one back into the live project list, or destroy it permanently.
// The archived LIST is the host's read (both hosts already poll `["archivedProjects"]`); the two writes
// are the host's too, so the invalidations stay in `useProjectLifecycleWrites` above and this component
// owns neither.
//
// Moved here from pages/Projects.tsx by card baca1835, for the reason ProjectManage moved on c9b78d80:
// the Atlas design retires /projects (card 5afd71bd), and this tier was the LAST thing living only
// there — without a second home, a soft-archived project under Atlas would be invisible AND
// unrestorable, which turns a reversible archive into an effective delete.
//
// `collapsible` is the FRAME, exactly as it is for ProjectManage above, and defaults to the classic
// Projects rail's shape — a "▸ Archived · N" disclosure, closed on mount — so that call site renders as
// it always did. The Workspace Settings section passes `false`: that section already carries its own
// heading inside a Panel, so a disclosure there would be a header under a header.
//
// @decision baca1835 — the type-the-name confirm lives HERE, never in a host. Two hosts asking their
// own confirm over the same irreversible cascade is exactly the second permanent-delete site c9b78d80
// forbids, and the one that drifts is the one nobody is looking at.
export function ArchivedProjects(
  { projects, onRestore, onDelete, collapsible = true }:
  { projects: Project[]; onRestore: (id: string) => void; onDelete: (id: string) => void; collapsible?: boolean },
) {
  const [open, setOpen] = useState(!collapsible);
  // The gate: type the project's name back, exactly. A MISMATCH is told so, because silently doing
  // nothing is indistinguishable from a delete that failed; a dismissed prompt (null) is a cancel and
  // deserves no message at all.
  const confirmDelete = (p: Project) => {
    const typed = window.prompt(deletePrompt(p.name));
    if (typed === p.name) onDelete(p.id);
    else if (typed !== null) window.alert("name did not match — not deleted");
  };
  // The empty line is only reachable in the un-collapsed frame: the classic rail mounts this component
  // at all only while the archived list is non-empty, whereas a Settings section is a fixed address and
  // has to say that nothing is there.
  const body = open && (
    <div data-testid="archived-projects-list" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {projects.length === 0 ? (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "2px 0" }}>No archived projects.</span>
      ) : projects.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font.mono, fontSize: 12, color: color.textDim }}>{p.name}</span>
          <Button onClick={() => onRestore(p.id)} aria-label={`Restore ${p.name}`}>Restore</Button>
          <Button variant="danger" onClick={() => confirmDelete(p)} aria-label={`Delete ${p.name} permanently`}>Delete</Button>
        </div>
      ))}
    </div>
  );
  if (!collapsible) return <>{body}</>;
  return (
    <div style={{ marginTop: 2, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", cursor: "pointer",
          background: "transparent", border: "none", padding: "2px 0",
          fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim }}>
        <span style={{ color: color.phosphor }}>{open ? "▾" : "▸"}</span>Archived · {projects.length}
      </button>
      {body}
    </div>
  );
}

// The reference-repos list editor (reference-repos epic Phase 4, card f4888775). Edits a project's
// `referenceRepos` — the read-only SIBLING repos a worker may consult, DISTINCT from the one load-bearing
// primary `repoPath` (its own field, shown as a Chip above, never merged into this list). Add / remove
// rows, then Save persists via the phase-2 PATCH /api/projects/:id; the server validates each entry
// (absolute path + existing git repo) and 400s with a clear reason we surface INLINE (not an alert).
// An empty list renders a quiet "none" line, never a phantom blank row — a blank row appears only when
// the human deliberately ＋ Adds one. Blank/whitespace rows are trimmed out at save, so an all-blank add
// is not "dirty" and never round-trips a bogus entry to the validator.
function ReferenceReposEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const saved = project.referenceRepos ?? [];
  const [repos, setRepos] = useState<string[]>(saved);
  const [error, setError] = useState<string | null>(null);
  // The persisted candidate: trimmed, blanks dropped. Dirty (and the payload) both key off this, so a
  // stray empty row neither enables Save nor reaches the server.
  const clean = repos.map((r) => r.trim()).filter(Boolean);
  const dirty = JSON.stringify(clean) !== JSON.stringify(saved);

  const save = useMutation({
    // Opt out of main.tsx's global blocking window.alert — this editor already renders the server's
    // validation message inline (below), and the alert duplicated it on top of a modal the user had to
    // dismiss first. Missing since this editor shipped; found while building the registry editor's twin.
    meta: { inlineError: true },
    mutationFn: () => api.updateProject(project.id, { referenceRepos: clean }),
    onMutate: () => setError(null),
    // Sync local rows to what the server actually stored (the source of truth) so `dirty` settles cleanly.
    onSuccess: (updated) => { setRepos(updated.referenceRepos ?? []); qc.invalidateQueries({ queryKey: ["projects"] }); },
    onError: (e) => setError(errorText(e)),
  });

  // Any edit clears a stale server error so it never lingers past the input it referred to.
  const edit = (i: number, v: string) => { setError(null); setRepos((rs) => rs.map((r, j) => (j === i ? v : r))); };
  const remove = (i: number) => { setError(null); setRepos((rs) => rs.filter((_, j) => j !== i)); };
  const add = () => { setError(null); setRepos((rs) => [...rs, ""]); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <div>
        <SectionLabel style={{ margin: 0 }}>Reference repos</SectionLabel>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>read-only sibling repos · absolute git paths</span>
      </div>
      {repos.length === 0 ? (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "2px 0" }}>No reference repos.</span>
      ) : (
        repos.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Input placeholder="/absolute/path/to/repo" value={r} onChange={(e) => edit(i, e.target.value)}
              aria-label={`Reference repo ${i + 1}`} style={{ flex: 1 }} />
            <Button variant="ghost" title="Remove this reference repo" aria-label={`Remove reference repo ${i + 1}`}
              onClick={() => remove(i)} style={{ padding: "4px 9px" }}>✕</Button>
          </div>
        ))
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <Button onClick={add}>＋ Add repo</Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save reference repos"}
        </Button>
      </div>
      {error && (
        <span role="alert" style={{ fontFamily: font.mono, fontSize: 11, color: color.red, lineHeight: 1.5 }}>{error}</span>
      )}
    </div>
  );
}

// The WRITABLE multi-repo registry editor (multi-repo epic 49136451, phase 3). Sibling to
// ReferenceReposEditor above, and deliberately shaped the same way — but the two are NOT the same thing
// and the copy says so: a reference repo is READ-only (no worktree, no branch, no gate), while a registry
// entry is a full target a card can be routed at, with its own worktree/branch/gate. `repoPath` stays the
// PRIMARY repo and is NOT editable here (nor anywhere in the UI) — the registry is the editable
// multi-repo surface, and "primary" is a RESERVED key the server rejects.
//
// Before this editor existed the registry was REST-only: registering a repo meant hand-rolling a curl.
// That is the gap this closes. Same trust posture as the reference-repos editor — HUMAN REST only; each
// entry carries a `gateCommand` (host-RCE class), so no agent MCP surface may ever reach this.
//
// The server (`validateRepoRegistry`) is the ONLY validator — this editor deliberately re-implements
// none of its rules (unique key, reserved "primary", the [A-Za-z0-9._-] path-segment charset, absolute +
// existing-git-repo path, no aliasing repoPath/vaultPath/another entry). It just surfaces the server's
// FIRST-OFFENDER message verbatim, which names the entry that failed. It also stores the CANONICALIZED
// (realpath'd) path, so a saved row commonly differs from what was typed — `onSuccess` resyncs the rows
// from what the server actually stored, or `dirty` would never settle after a successful save.
function RepoRegistryEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const saved = project.repos ?? [];
  const [repos, setRepos] = useState<RepoRegistryEntry[]>(saved);
  const [error, setError] = useState<string | null>(null);
  // The persisted candidate: trimmed, fully-blank rows dropped, and a blank gateCommand/
  // ungatedLandingCheckCommand OMITTED rather than sent as "" (the validator rejects an empty-string
  // gateCommand, and "no gate"/"no check" is a real, distinct state — see the hint below).
  //
  // Card bd9a483b (CR round 3, ruling 2): SPREAD `r` rather than hand-copy named fields into a fresh
  // object — the hand-copy silently dropped every field it didn't name (it dropped
  // `ungatedLandingCheckCommand` outright the day that field shipped) AND rebuilt each entry's key order
  // from scratch, which could differ from `saved[i]`'s own server-serialized order and read `dirty:true`
  // on mount before any edit. Spreading `r` (whose own order traces back to `saved`, since `repos` seeds
  // from `saved`) fixes both at once. `noGateByDesign` (card 22629cb2) rides the spread too.
  const clean: RepoRegistryEntry[] = repos
    .map((r) => ({
      ...r,
      key: r.key.trim(),
      path: r.path.trim(),
      gateCommand: r.gateCommand?.trim() || undefined,
      ungatedLandingCheckCommand: r.ungatedLandingCheckCommand?.trim() || undefined,
    }))
    .filter((r) => r.key || r.path);
  const dirty = JSON.stringify(clean) !== JSON.stringify(saved);

  const save = useMutation({
    // Opt out of main.tsx's global blocking window.alert — this editor renders the server's
    // first-offender message inline (below), and a native alert on top of it would both duplicate the
    // message and wedge automation on a modal dialog.
    meta: { inlineError: true },
    mutationFn: () => api.updateProject(project.id, { repos: clean }),
    onMutate: () => setError(null),
    // Resync to what the server STORED (canonicalized paths), not what was typed — see the note above.
    onSuccess: (updated) => { setRepos(updated.repos ?? []); qc.invalidateQueries({ queryKey: ["projects"] }); },
    onError: (e) => setError(errorText(e)),
  });

  // Any edit clears a stale server error so it never lingers past the input it referred to.
  const edit = (i: number, patch: Partial<RepoRegistryEntry>) => {
    setError(null);
    setRepos((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => { setError(null); setRepos((rs) => rs.filter((_, j) => j !== i)); };
  const add = () => { setError(null); setRepos((rs) => [...rs, { key: "", path: "" }]); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, borderTop: `1px solid ${color.border}`, paddingTop: 8 }}>
      <div>
        <SectionLabel style={{ margin: 0 }}>Registered repos</SectionLabel>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>writable · a card targets one via its repo key</span>
      </div>
      <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, lineHeight: 1.5 }}>
        This project's own repo is the <span style={{ color: color.cyan }}>primary</span> target — no entry needed.
      </span>
      {repos.length === 0 ? (
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, padding: "2px 0" }}>No registered repos.</span>
      ) : (
        repos.map((r, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
              <Input placeholder="key" value={r.key} onChange={(e) => edit(i, { key: e.target.value })}
                aria-label={`Repo ${i + 1} key`} style={{ flex: "0 1 120px", minWidth: 0 }} />
              <Input placeholder="/absolute/path/to/repo" value={r.path} onChange={(e) => edit(i, { path: e.target.value })}
                aria-label={`Repo ${i + 1} path`} style={{ flex: "2 1 200px", minWidth: 0 }} />
              <Input placeholder="gate command (optional)" value={r.gateCommand ?? ""} onChange={(e) => edit(i, { gateCommand: e.target.value })}
                aria-label={`Repo ${i + 1} gate command`} style={{ flex: "2 1 200px", minWidth: 0 }} />
              <Button variant="ghost" title="Remove this repo" aria-label={`Remove repo ${i + 1}`}
                onClick={() => remove(i)} style={{ padding: "4px 9px" }}>✕</Button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap", paddingLeft: 126 }}>
              <Input placeholder="ungated landing check command (optional)" value={r.ungatedLandingCheckCommand ?? ""}
                onChange={(e) => edit(i, { ungatedLandingCheckCommand: e.target.value })}
                aria-label={`Repo ${i + 1} ungated landing check command`} style={{ flex: "2 1 200px", minWidth: 0 }} />
            </div>
            {!!r.ungatedLandingCheckCommand?.trim() && !r.gateCommand?.trim() && (
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.amber, lineHeight: 1.5, paddingLeft: 126 }}>
                no gate command set on this repo — the check is nested inside the same gate-skip logic, so it will never run without one.
              </span>
            )}
          </div>
        ))
      )}
      {/* The no-gate consequence, stated where the decision is made. A registry entry does NOT inherit the
          project-level gate command by design: a gate that exits 0 for an unrelated reason would report a
          FALSE green on code it never tested. Missing is honest ("unverified"); wrong looks verified. */}
      {repos.length > 0 && (
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, lineHeight: 1.5 }}>
          A repo with no gate command merges as <span style={{ color: color.amber }}>unverified</span> — it does not fall back to this project's gate command.
        </span>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <Button onClick={add}>＋ Register repo</Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save registered repos"}
        </Button>
      </div>
      {error && (
        <span role="alert" style={{ fontFamily: font.mono, fontSize: 11, color: color.red, lineHeight: 1.5 }}>{error}</span>
      )}
    </div>
  );
}
