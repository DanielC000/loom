// Taskless guarded paths in Settings (card 7e15ff89, follow-up to a880c391). The daemon enforces; this edits the
// project's human-only `orchestration.tasklessGuardedPaths` list through the human config PATCH, with its OWN save
// (like the card-policy editor beside it). Pure shaping lives in lib/tasklessGuardedPaths.ts; the help text restates
// the semantics documented on `OrchestrationConfig.tasklessGuardedPaths` in packages/shared/src/config.ts.
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@loom/shared";
import { api } from "../lib/api";
import { errorText } from "../lib/loopbackCredential";
import {
  TASKLESS_GUARDED_PATHS_LIMITS, draftLines, guardedPathsConfigWrite, guardedPathsFromText, guardedPathsSeed,
  guardedPathsSignature,
} from "../lib/tasklessGuardedPaths";
import { color, font, fs, radius } from "../theme";
import { Button } from "./ui";

const storedOf = (p: Pick<Project, "config">): unknown =>
  (p.config?.orchestration as { tasklessGuardedPaths?: unknown } | undefined)?.tasklessGuardedPaths;

const code = { fontFamily: font.mono, fontSize: fs.xs, color: color.text2 } as const;

export function TasklessGuardedPathsEditor({ project }: { project: Project }) {
  const qc = useQueryClient();
  const inputId = useId();
  const helpId = useId();
  // Held in state, never a ref: the save re-seeds from what the daemon stored.
  const [seed, setSeed] = useState(() => guardedPathsSeed(storedOf(project)));
  const [text, setText] = useState(seed.text);
  const [baseline, setBaseline] = useState(() => guardedPathsSignature(draftLines(seed.text)));
  const [justSaved, setJustSaved] = useState(false);
  const draft = guardedPathsFromText(text);
  // A corrupt stored value is always saveable, even as an empty list: that save is the repair.
  const dirty = guardedPathsSignature(draftLines(text)) !== baseline || seed.error !== null;

  const adopt = (stored: unknown) => {
    const next = guardedPathsSeed(stored);
    setSeed(next);
    setText(next.text);
    setBaseline(guardedPathsSignature(draftLines(next.text)));
  };

  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: () => {
      if (!draft.ok) throw new Error(draft.error);
      const w = guardedPathsConfigWrite(draft.paths);
      return api.updateProjectConfig(project.id, w.override, w.unset);
    },
    onSuccess: (saved) => {
      adopt(storedOf(saved));
      setJustSaved(true);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const count = draft.ok ? draft.paths.length : null;
  return (
    <div data-testid="taskless-guarded-paths-editor" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p id={helpId} style={{ margin: 0, fontFamily: font.ui, fontSize: fs.sm, color: color.text2, lineHeight: 1.5, maxWidth: "70ch" }}>
        A worker spawned without a card matches no card policy. List the paths such a worker may not change: when its
        branch adds, edits, deletes or renames a matching file, merging it is refused and the manager is told to redo
        the work on a card. Workers on a card are not affected. Only you can set this list; agents cannot change it.
      </p>
      {seed.error && (
        <div role="alert" data-testid="taskless-guarded-paths-corrupt" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.busy, lineHeight: 1.5 }}>
          The stored list can’t be read ({seed.error}), so every merge from a worker without a card is refused. Saving
          below replaces it.
        </div>
      )}
      <label htmlFor={inputId} style={{ fontFamily: font.ui, fontSize: fs.sm, fontWeight: 600, color: color.text2 }}>
        Guarded paths <span style={{ fontWeight: 400, color: color.text3 }}>one glob per line</span>
      </label>
      <textarea id={inputId} data-testid="taskless-guarded-paths-input" aria-describedby={helpId} spellCheck={false}
        value={text} onChange={(e) => { setJustSaved(false); setText(e.target.value); }}
        placeholder={"packages/daemon/src/git/**\n.github/**\n*.lock"}
        style={{ width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 96, fontFamily: font.mono, fontSize: fs.body,
          lineHeight: 1.5, background: color.panel2, color: color.text, border: `1px solid ${draft.ok ? color.border : color.busy}`,
          borderRadius: radius.sm, padding: 8 }} />
      <ul style={{ margin: 0, paddingLeft: 18, fontFamily: font.ui, fontSize: fs.xs, color: color.text3, lineHeight: 1.6, maxWidth: "70ch" }}>
        <li>
          Repo-relative with forward slashes: no leading <span style={code}>/</span>, no <span style={code}>\</span> and
          no <span style={code}>..</span> segment. At most {TASKLESS_GUARDED_PATHS_LIMITS.maxEntries} paths of{" "}
          {TASKLESS_GUARDED_PATHS_LIMITS.maxEntryLen} characters each.
        </li>
        <li>
          <span style={code}>*</span> stays inside one folder, <span style={code}>**</span> crosses folders,{" "}
          <span style={code}>?</span> is one character. A pattern with no <span style={code}>/</span> that starts with{" "}
          <span style={code}>*</span>, like <span style={code}>*.lock</span>, matches at any depth.
        </li>
        <li>
          Matching ignores case, so <span style={code}>docs/**</span> also guards <span style={code}>DOCS/notes.md</span>.
          Moving a file out of a guarded path counts as changing it.
        </li>
        <li>An empty list guards nothing. A change applies to the next merge, without a restart.</li>
      </ul>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span data-testid="taskless-guarded-paths-count" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>
          {count === null ? "" : count === 0 ? "no guarded paths" : `${count} guarded path${count === 1 ? "" : "s"}`}
        </span>
        <span style={{ flex: 1 }} />
        {dirty && !draft.ok && (
          <span data-testid="taskless-guarded-paths-draft-error" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.busy }}>{draft.error}</span>
        )}
        {dirty && <Button onClick={() => { adopt(storedOf(project)); save.reset(); }} disabled={save.isPending}>Discard changes</Button>}
        {!dirty && justSaved && <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.liveText }}>saved</span>}
        <Button variant="primary" data-testid="taskless-guarded-paths-save" disabled={!dirty || !draft.ok || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save guarded paths"}
        </Button>
      </div>
      {save.error && (
        <span role="alert" data-testid="taskless-guarded-paths-save-error" style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.danger, lineHeight: 1.45 }}>
          {errorText(save.error)}
        </span>
      )}
    </div>
  );
}
