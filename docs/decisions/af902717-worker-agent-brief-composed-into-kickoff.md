# af902717 — a worker session's opening now composes its agent BASE BRIEF, not just the dynamic kickoff

## Narrative

Before this, a manager-spawned worker only ever received the dynamic text (the manager's kickoff on spawn, the `[loom:handoff]…` summary on recycle); its agent's `startupPrompt` (the Dev/Bugfix/Web Designer brief — "Step 0: run `/worker`", "CLAUDE.md is law", reproduce-first) was DEAD config in the orchestrated flow — configured but never actually reaching the worker. The manager path already composed its own brief (`composeManagerStartupPrompt`); `composeWorkerStartupPrompt` is the worker mirror, fixing the same class of gap on the worker side.

Composition order is deliberate: a worktree LOCATION block FIRST, then the agent BASE BRIEF, then the dynamic part (kickoff/handoff) — the location block names the worker's edit dir, the brief is the standing doctrine, the dynamic part is the specific task to act on. An empty/whitespace brief means the location block leads the dynamic part alone, never a bare dynamic-part-only prompt once `cwd` is set.

## Do not

- Do not let a worker's agent `startupPrompt` go unused in the orchestrated flow — compose it into the opening alongside the dynamic kickoff/handoff text, the same way the manager path already does.
- Do not reorder the composition — worktree location first, then the agent brief, then the dynamic part; the location block must lead even when the brief is empty, once a `cwd` is set.

## Source

JSDoc comment above `composeWorkerStartupPrompt` in `packages/daemon/src/sessions/worker-prompt.ts`: originally lines 74-85, as of this tranche's HEAD. Introduced by commit `343457d7ec3b671b1c006f6c366165ba68b6f76a` (`fix(sessions): compose worker agent brief into worker_spawn + recycle openings (base prompt never reaches workers)`). Relocated by card `36641df4` ("sessions prompt-composer files, tranche 1").
