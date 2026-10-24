import { type CSSProperties, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@loom/shared";
import { api } from "../lib/api";
import { Button } from "./ui";
import { color, font, radius } from "../theme";
import { errorText } from "../lib/loopbackCredential";
import { modEnterSubmit } from "../lib/modEnter";

// Reserved-home agent prompt editor (card 7cffd759) — the view/edit surface for a reserved-home agent's
// `startupPrompt`: the kickoff injected as the FIRST turn of that agent's NEXT new session (never on
// resume). Shown on the Platform page for each reserved-home agent — the dev Platform Lead + Auditor and
// the end-user operator ("Platform") + Workspace Auditor — closing the gap where startupPrompt was a
// human-only field with no editor (same family as the Settings repoPath field). Saves through the EXISTING
// human REST POST /api/agents/:id (api.updateAgent), the SAME agent-preset store the spawn path reads —
// NOT an agent MCP path (there is none for the prompt). Collapsed by default because these prompts run
// long; expand to read + edit. Inline error only (no window.alert, via meta.inlineError); a dirty flag
// gates Save, and a successful save re-reads the persisted prompt locally so the row flips to "saved"
// without waiting for the parent home query to refetch (mirrors RepoPathEditor's optimistic re-read).
//
// `homeKey` is the parent's home query key (["platformHome"] / ["setupHome"]) — invalidated on save so the
// agent list the page renders from picks up the new prompt. Key this component by agent id at the call site
// so switching agents re-seeds the draft.
//
// @decision b472645a — `readOnly` must hold the TEXTAREA, not just Save: the textarea's own Ctrl/Cmd+Enter
// handler is a second, independent save trigger, so a button-only gate still sends the request.
export function AgentPromptEditor({ agent, homeKey, readOnly = false }:
  { agent: Agent; homeKey: readonly unknown[];
    // True in a dev install's "View as: End-user" preview (PlatformView's `previewOnly`). The prompt stays
    // fully READABLE — expanding and reading it is the whole point of a preview — but nothing can be typed
    // or saved, so there is no draft to lose and no trigger left to fire.
    readOnly?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(agent.startupPrompt);
  // The persisted baseline the draft is diffed against. Bumped on a successful save so `dirty` clears
  // immediately, before the invalidated home query round-trips back.
  const [saved, setSaved] = useState(agent.startupPrompt);
  // `readOnly` kills every write trigger at the source, so `dirty` can never go true in a preview and
  // each disabled check below reads it rather than re-testing the flag.
  const dirty = !readOnly && draft !== saved;

  const save = useMutation({
    mutationFn: () => api.updateAgent(agent.id, { startupPrompt: draft }),
    // Render the failure inline below — opt out of main.tsx's global blocking window.alert.
    meta: { inlineError: true },
    onSuccess: (updated) => {
      setSaved(updated.startupPrompt);
      setDraft(updated.startupPrompt);
      qc.invalidateQueries({ queryKey: homeKey });
    },
  });

  const empty = saved.trim().length === 0;

  return (
    <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? "Collapse the startup prompt" : "View / edit the startup prompt"}
        style={headerBtn}>
        <span style={{ color: open ? color.phosphor : color.textDim, fontFamily: font.mono, fontSize: 12, width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, fontWeight: 700, color: color.textDim }}>
          Startup prompt
        </span>
        {dirty && <span style={{ color: color.amber, fontFamily: font.mono, fontSize: 10 }}>● unsaved</span>}
        {empty && !dirty && <span style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 10 }}>empty</span>}
      </button>

      {!open && (
        // Collapsed: a quiet two-line preview of the persisted prompt (read-only).
        <span title={saved || undefined}
          style={{ fontFamily: font.mono, fontSize: 11, color: empty ? color.textMuted : color.textDim, lineHeight: 1.45,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap" }}>
          {empty ? "No startup prompt — this agent boots inert until told what to do." : saved}
        </span>
      )}

      {open && (
        <>
          <p style={{ color: color.textMuted, fontSize: 11, margin: 0, fontFamily: font.mono, lineHeight: 1.5 }}>
            Injected as the first turn of this agent's NEXT new session (never on resume). Editing it does not
            touch a live session.
          </p>
          <textarea value={draft} rows={10} spellCheck={false} readOnly={readOnly}
            onChange={(e) => { if (!readOnly) setDraft(e.target.value); }}
            onKeyDown={modEnterSubmit(dirty && !save.isPending, () => save.mutate())}
            placeholder="The kickoff prompt this agent boots with…"
            className="loom-field" style={textareaStyle} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
              title="Save the startup prompt (⌘/Ctrl+Enter)">
              {save.isPending ? "Saving…" : "Save prompt"}
            </Button>
            <Button disabled={!dirty || save.isPending} onClick={() => setDraft(saved)}
              title="Discard unsaved edits">Revert</Button>
            {readOnly
              ? <span style={{ color: color.textMuted, fontSize: 11, fontFamily: font.mono }}>read-only in this preview</span>
              : dirty
                ? <span style={{ color: color.amber, fontSize: 11, fontFamily: font.mono }}>unsaved changes</span>
                : <span style={{ color: color.phosphor, fontSize: 11, fontFamily: font.mono }}>saved</span>}
            <span style={{ flex: 1 }} />
            {save.isError && (
              <span style={{ color: color.red, fontSize: 11, fontFamily: font.mono, textAlign: "right" }}>
                {errorText(save.error)}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const headerBtn: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 0,
  cursor: "pointer", textAlign: "left",
};

const textareaStyle: CSSProperties = {
  width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5,
  fontFamily: font.mono, fontSize: 12, color: color.text, background: color.panel2,
  border: `1px solid ${color.border}`, borderRadius: radius.sm, padding: "8px 10px",
};
