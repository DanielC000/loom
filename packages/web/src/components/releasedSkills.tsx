import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@loom/shared";
import { api, type ReleasedSkill, type ReleasedSkillDiff } from "../lib/api";
import { errorText } from "../lib/loopbackCredential";
import {
  releaseReasonGloss, releaseReasonTone, releasedAgeLabel, shortFingerprint,
  trackedBadgeLabel, trackedBlockReason,
} from "../lib/releasedSkills";
import { LineDiff } from "./LineDiff";
import { Badge, Button, Panel, SectionLabel } from "./ui";
import { color, font, radius, fs } from "../theme";

// Released skill copies at ONE project's shared doctrine dir, over card 8b38b920's three human-only REST
// routes. Loom injects its skills into each session's `<cwd>/.claude/skills`; when it can no longer prove
// a copy there is still its own, it stops overwriting it — correct for data safety, but until this panel
// existed nothing TOLD anyone, so a project's doctrine could sit frozen for weeks with only a line in the
// daemon's rotating stdout to say so. This is that record, read.
//
// @decision 75ea3f73 — the re-adopt POST must send the fingerprint from the diff the human ACTUALLY
// REVIEWED (the `reviewed` snapshot below), never one refetched at click time; and the re-adopt button
// stays INSIDE the expanded diff body, never a sibling of the list row.
export function ReleasedSkillsPanel({ project }: { project: Project | null }) {
  if (!project) {
    return (
      <Panel>
        <Prose>No active project. Pick one in the header to see what Loom stopped managing there.</Prose>
      </Panel>
    );
  }
  // Keyed by id so switching projects remounts rather than carrying the open diff + its reviewed
  // fingerprint across — a fingerprint is only ever valid for the project it was read from.
  return <ReleasedSkillsBody key={project.id} project={project} />;
}

function ReleasedSkillsBody({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);

  // A vault-only project has no doctrine dir to have released anything FROM. The route answers
  // `{released:[]}` for it, indistinguishable from a healthy empty list — so this is read off the
  // project row, which is the only place the difference exists.
  const bound = !!project.repoPath;

  const list = useQuery({
    queryKey: ["releasedSkills", project.id],
    queryFn: () => api.releasedSkills(project.id),
    enabled: bound,
  });
  const released = list.data?.released ?? [];

  if (!bound) {
    return (
      <Panel>
        <Prose>
          This project has no repository bound, so it has no shared doctrine directory for Loom to inject
          skills into — and nothing to release. Bind a repository under Repository Binding above.
        </Prose>
      </Panel>
    );
  }

  return (
    <div data-testid="released-skills" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Panel>
        <Prose>
          Loom copies its own skills into this project's
          <code style={{ color: color.info }}> .claude/skills</code> so every session here reads the same
          doctrine. When it can no longer prove a copy is still the one it placed, it stops overwriting it
          — your edit is safe, but that skill is now <strong style={{ color: color.text }}>frozen</strong>:
          it will never pick up a Loom update again until you hand it back.
        </Prose>
        <Prose style={{ marginTop: 8 }}>
          Re-adopting replaces the copy on disk with the current store copy and resumes management. Review
          the diff first — whatever is on disk is overwritten, and that is not undoable from here.
        </Prose>
      </Panel>

      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <SectionLabel style={{ margin: 0 }}>Frozen copies ({released.length})</SectionLabel>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={list.isFetching}
            onClick={() => { setOpen(null); void list.refetch(); }}>
            {list.isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>

        {list.isLoading && <Prose>reading this project's doctrine directory…</Prose>}
        {list.isError && (
          <span data-testid="released-skills-list-error" style={{ color: color.danger, fontSize: fs.mono, fontFamily: font.mono }}>
            {errorText(list.error)}
          </span>
        )}

        {!list.isLoading && !list.isError && released.length === 0 && (
          <span data-testid="released-skills-empty" style={{ color: color.text3, fontSize: fs.body, fontFamily: font.mono }}>
            Nothing frozen — Loom is still managing every skill it injected here.
          </span>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {released.map((r) => (
            <ReleasedRow key={r.name} projectId={project.id} entry={r}
              open={open === r.name}
              onToggle={() => setOpen((cur) => (cur === r.name ? null : r.name))}
              onReadopted={() => {
                setOpen(null);
                void qc.invalidateQueries({ queryKey: ["releasedSkills", project.id] });
              }} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

// One frozen skill: its reason, its age, whether a re-adopt will be refused — and, expanded, the diff
// that is the structural precondition for the re-adopt button (the button is rendered ONLY inside the
// expanded body, never as a sibling of the row, so nobody can overwrite a copy they have not looked at).
function ReleasedRow({ projectId, entry, open, onToggle, onReadopted }: {
  projectId: string; entry: ReleasedSkill; open: boolean; onToggle: () => void; onReadopted: () => void;
}) {
  const reasonTone = releaseReasonTone(entry.reason);
  const trackedLabel = trackedBadgeLabel(entry.tracked);
  const blocked = trackedBlockReason(entry.tracked);
  return (
    <div data-testid={`released-skill-${entry.name}`}
      style={{ border: `1px solid ${open ? color.lineStrong : color.line}`, borderRadius: radius.sm, background: color.inset }}>
      {/* A disclosure control, so `aria-expanded` — and its accessible name is deliberately its own
          CONTENT (name + reason + age), not an aria-label: replacing that with a short label would hide
          the row's actual summary from a screen reader. The testid is what a spec locates it by. */}
      <button onClick={onToggle} className="loom-btn" aria-expanded={open}
        data-testid={`released-skill-toggle-${entry.name}`}
        title={open ? `Hide ${entry.name}` : `Review what differs in ${entry.name}`}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "8px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden style={{ color: color.text3, fontFamily: font.mono, fontSize: fs.mono, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        {/* WRAPPED, never truncated or clipped: the name is the identifier the reader needs in full to
            know which copy this row is (same reasoning as the reclaim panel's full worktree path). A
            `flexShrink: 0` here clipped a long name clean off the row at 390px. */}
        <span style={{ fontFamily: font.mono, fontSize: fs.body, color: color.text, wordBreak: "break-all", minWidth: 0 }}>{entry.name}</span>
        <Badge tone={reasonTone}>{entry.reason}</Badge>
        {trackedLabel && <Badge tone="danger">{trackedLabel}</Badge>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text2, flexShrink: 0 }}>
          {releasedAgeLabel(entry.firstSeenAt)}
        </span>
      </button>
      <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
        <Prose>{releaseReasonGloss(entry.reason)}</Prose>
        {blocked && (
          <span role="status" style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.danger, lineHeight: 1.5 }}>
            Re-adopting is refused: {blocked}.
          </span>
        )}
      </div>
      {open && <ReleasedDiff projectId={projectId} entry={entry} onReadopted={onReadopted} />}
    </div>
  );
}

// The diff, plus the confirm-to-re-adopt action it gates. Fetched only when the row is expanded.
function ReleasedDiff({ projectId, entry, onReadopted }: {
  projectId: string; entry: ReleasedSkill; onReadopted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // The snapshot the human is looking at. Captured from the diff response and then held in state, so the
  // fingerprint sent on click is provably the one whose content was rendered — see this file's header.
  const [reviewed, setReviewed] = useState<ReleasedSkillDiff | null>(null);

  const diff = useQuery({
    queryKey: ["releasedSkillDiff", projectId, entry.name],
    queryFn: () => api.releasedSkillDiff(projectId, entry.name),
    // Pinned deliberately: a background refetch would move the fingerprint out from under the content on
    // screen. "Re-read the copy" below is the ONE way this snapshot advances, and it is explicit.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => { if (diff.data) setReviewed(diff.data); }, [diff.data]);

  const readopt = useMutation({
    // REQUIRED, not decorative: main.tsx alerts every unhandled mutation error, so without this a 409
    // would render inline here AND pop a blocking modal over it. Every refusal belongs inline, beside
    // the diff it refers to.
    meta: { inlineError: true },
    mutationFn: () => api.readoptSkill(projectId, entry.name, reviewed!.currentFingerprint!),
    onSuccess: onReadopted,
    // DISARM on a refusal. Leaving the confirm armed stacked a red "this was refused" box directly above
    // a red "Replace this copy" button — and for the commonest refusal (a stale fingerprint) that button
    // would re-send the SAME reviewed fingerprint and fail identically. The way forward is the error
    // box's own "Re-open the diff"; re-arming afterwards should be a deliberate second act.
    // Not the thing decision record ad42a127 forbids: that bans an ALERTING call-site onError (a second
    // modal over the global one). This one only disarms local state, and `meta.inlineError` above
    // already returns the global handler early, so exactly one message reaches the reader — the inline
    // box below.
    onError: () => setConfirming(false),
  });

  // Any disarming change resets the confirm — a primed overwrite must never survive the thing it is
  // aimed at changing underneath it.
  const reReadCopy = () => {
    setConfirming(false);
    readopt.reset();
    void diff.refetch();
  };

  if (diff.isLoading) {
    return <Body><Prose>reading the copy on disk…</Prose></Body>;
  }
  if (diff.isError || !reviewed) {
    return (
      <Body>
        <span data-testid="released-skill-diff-error" style={{ color: color.danger, fontFamily: font.mono, fontSize: fs.mono }}>
          {errorText(diff.error) || "Couldn't read this copy."}
        </span>
      </Body>
    );
  }

  const changed = reviewed.files.filter((f) => f.differs);
  const blocked = trackedBlockReason(reviewed.tracked);
  // `currentFingerprint: null` means the dir could not be read, so there is nothing to vouch for — the
  // server would refuse anyway, and offering the button would be a lie about what we can prove.
  const canReadopt = !blocked && !!reviewed.currentFingerprint;

  return (
    <Body>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3 }}>
          on disk now: <span style={{ color: color.text2 }}>{shortFingerprint(reviewed.currentFingerprint)}</span>
        </span>
        <span data-testid="released-skill-diff-summary" style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3 }}>
          {reviewed.files.length === 1
            ? `${changed.length} of 1 file differs from the store`
            : `${changed.length} of ${reviewed.files.length} files differ from the store`}
        </span>
        <span style={{ flex: 1 }} />
        {/* Worded to MATCH the server's own stale-fingerprint message ("re-open the diff and try
            again"), which is shown verbatim on a refusal — a reader told to re-open the diff should
            find a control with that name, not have to infer that "re-read the copy" is the same act. */}
        <Button variant="ghost" disabled={diff.isFetching || readopt.isPending} onClick={reReadCopy}>
          {diff.isFetching ? "Re-opening…" : "Re-open the diff"}
        </Button>
      </div>

      {reviewed.files.length === 0 ? (
        <Prose>
          Neither the copy on disk nor the store holds any file for this skill. Re-adopting would have
          nothing to place.
        </Prose>
      ) : changed.length === 0 ? (
        <Prose>
          Every file matches the store copy byte for byte — this skill was frozen without its content
          diverging, which is what <code style={{ color: color.info }}>{reviewed.reason}</code> means here.
          Re-adopting changes no content; it just hands management back to Loom.
        </Prose>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {changed.map((f) => (
            <FileRow key={f.path} projectId={projectId} name={entry.name} path={f.path}
              open={openFile === f.path}
              onToggle={() => setOpenFile((cur) => (cur === f.path ? null : f.path))} />
          ))}
        </div>
      )}

      {/* Every refusal, verbatim from the server, WITH its own way out. The commonest one is the stale
          fingerprint, whose fix is to re-open the diff — so that action sits inside the message rather
          than only in the header above the diff, where a reader who just read the message is not
          looking. Never a silent no-op: the panel always says what the daemon refused and why. */}
      {readopt.error && (
        <div data-testid="readopt-error" role="status"
          style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            color: color.danger, fontFamily: font.mono, fontSize: fs.mono, lineHeight: 1.5,
            border: `1px solid ${color.danger}`, borderRadius: radius.sm, padding: "6px 8px" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{errorText(readopt.error)}</span>
          <Button variant="ghost" disabled={diff.isFetching} onClick={reReadCopy}>
            {diff.isFetching ? "Re-opening…" : "Re-open the diff"}
          </Button>
        </div>
      )}

      {!canReadopt ? (
        <Prose>
          {blocked
            ? `Re-adopting ${entry.name} is refused: ${blocked}. Resolve that in the repository, then check again.`
            : `Loom could not read a fingerprint for this copy, so it will not overwrite it. Check again once it can.`}
        </Prose>
      ) : confirming ? (
        // RED, and a `danger` confirm — the same treatment the node_modules reclaim panel gives its own
        // irreversible local write, and for the same reason: in the `modified` case the content being
        // replaced is a hand edit that exists in no commit (a git-tracked copy is refused outright), so
        // this really is unrecoverable from here. The amber "attention" tone would understate it.
        <div role="status" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8,
          border: `1px solid ${color.danger}`, borderRadius: radius.sm, background: color.surface }}>
          <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.danger, lineHeight: 1.5 }}>
            Replace this project's copy of <strong>{entry.name}</strong> with the current store copy?
            {changed.length === 1 && " The file above is overwritten, and that cannot be undone from here."}
            {changed.length > 1 && ` The ${changed.length} files above are overwritten, and that cannot be undone from here.`}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* Short, bounded labels: the name is already stated twice above (the row header and this
                sentence), and baking it into the button made a very wide control for a long name. */}
            <Button variant="danger" disabled={readopt.isPending}
              onClick={() => readopt.mutate()} data-testid="readopt-confirm">
              {readopt.isPending ? "Re-adopting…" : "Replace this copy"}
            </Button>
            <Button variant="ghost" disabled={readopt.isPending} onClick={() => setConfirming(false)}>Keep as is</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button disabled={readopt.isPending} onClick={() => { readopt.reset(); setConfirming(true); }}
            data-testid="readopt-start"
            title={`Hand ${entry.name} back to Loom, overwriting this project's copy`}>
            Re-adopt this copy
          </Button>
        </div>
      )}
    </Body>
  );
}

// One file's two sides, fetched on expand: the store copy as the base, the copy on disk as the change —
// so additions read as "what this project's copy adds on top of Loom's".
function FileRow({ projectId, name, path, open, onToggle }: {
  projectId: string; name: string; path: string; open: boolean; onToggle: () => void;
}) {
  const file = useQuery({
    queryKey: ["releasedSkillDiffFile", projectId, name, path],
    queryFn: () => api.releasedSkillDiffFile(projectId, name, path),
    enabled: open,
  });
  const d = file.data;
  return (
    <div style={{ border: `1px solid ${color.line}`, borderRadius: radius.sm, background: color.surface }}>
      <button onClick={onToggle} className="loom-btn" aria-expanded={open}
        data-testid={`released-file-toggle-${path}`}
        title={open ? `Hide ${path}` : `Show what differs in ${path}`}
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "6px 8px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden style={{ color: color.text3, fontFamily: font.mono, fontSize: fs.mono, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text }}>{path}</span>
      </button>
      {open && (
        <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {!d ? (
            file.isLoading
              ? <Prose>loading this file…</Prose>
              : <span style={{ color: color.danger, fontFamily: font.mono, fontSize: fs.mono }}>{errorText(file.error) || "Couldn't load this file."}</span>
          ) : (
            <>
              <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>
                Store copy → copy on disk
              </span>
              <LineDiff base={d.store ?? ""} shipped={d.onDisk ?? ""} />
              {d.store === null && <Prose>Only this project's copy has this file — the store does not, so re-adopting removes it.</Prose>}
              {d.onDisk === null && <Prose>Only the store has this file — re-adopting adds it to this project's copy.</Prose>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const Body = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
);

const Prose = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <p style={{ color: color.text3, fontSize: fs.mono, margin: 0, fontFamily: font.mono, lineHeight: 1.55, ...style }}>
    {children}
  </p>
);
