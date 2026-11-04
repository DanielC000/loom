# 36101180 — the bundled-skill permission-widening lint, and why it imports the real detector

Card `36101180`, from investigate-first card `28b2ca6f`. Sibling: card `87a51903`
(`skills/permissionWidening.ts`, the ONE detector this guard now calls into). Card `84893cab` later
retired this guard's own text-copy regexes in favor of importing the real module directly — see "Do not"
below for what that changed.

## Why this guard exists

A bundled skill under `packages/daemon/assets/skills/**` ships to every loomctl install with no
per-install review step. Card `28b2ca6f`'s probe
(`research/skill-frontmatter-permission-widening-2026-11-02.md` — the project's `research/` work dir, not
this repo) found three permission-widening vectors Claude Code's skill loader recognizes with no
workspace-trust gate:

- frontmatter `allowed-tools:` — pre-approves tools for the invoking turn; in `auto` mode (Loom's
  default) it lets a body `!` command run at render with no classifier pass at all (P3 vs P4).
- frontmatter `hooks:` — registers a shell hook that keeps firing for the rest of the session. Not a
  tool, so `--disallowedTools`/a companion's `restrictedTools` deny list cannot contain it (P9).
- a body inline `` !`cmd` `` or a fenced ` ```! ` block — runs a shell command at render time, before any
  model turn, deferred to the classifier only when no `allowed-tools` grant covers it (P1/P2).

Measured 0/14 bundled skill dirs used any of the three at the time (card `28b2ca6f`, re-verified by this
guard's own real scan). Merge review is the actual gate; this lint makes a future addition a deliberate
review point instead of a silent one.

SCOPE: every `packages/daemon/assets/skills/<name>/SKILL.md`, plus every file under
`packages/daemon/assets/skills/<name>/references/**`, recursively. Deliberately excludes `scripts/**`
executable helpers (e.g. `orchestrate/scripts/`, `web-design/scripts/`) and any other top-level file
(e.g. `web-design/NOTICE`) — neither is loaded as skill frontmatter/body by Claude Code's skill renderer,
so neither vector applies to them.

## Do not

- Do not re-add a text-copy of the detection patterns here. `@decision 87a51903` forbids a second copy of
  these patterns existing anywhere; this guard dynamic-imports `../dist/skills/permissionWidening.js` and
  calls `detectPermissionWidening` directly (card `84893cab`) rather than re-deriving
  `FRONTMATTER_RE`/`INLINE_SHELL_RE`/etc. by hand, the way it originally did.
- Do not resurrect `skill-permission-widening-lockstep.mjs`. It existed only to prove this guard's own
  text-copy regexes stayed byte-identical to the real module's exports (round-trip constant equality plus
  a differential run of the guard's own extracted `frontmatterUnrecognizedSyntax`/
  `frontmatterFenceUnrecognized` logic). Once card `84893cab` deleted the copy, there was nothing left to
  compare in either direction, so the file was deleted outright rather than left as dead weight. If this
  guard ever grows its own copy of anything the real module already exports, re-derive a differential/
  lockstep check from scratch rather than assuming the deleted file's shape still fits.
- Do not treat `VECTOR_LABEL` (the guard's small id→prose map) as a second copy of the patterns — it only
  renders the vector ids `detectPermissionWidening` already returns into the same human-readable strings
  this file's self-tests have always asserted. The detection logic itself lives solely in
  `skills/permissionWidening.ts` now.
- Do not move this guard off `ASSET_READING_TEST_REPO_PATHS` (`packages/daemon/src/git/worktrees.ts`) on
  the premise that it now imports compiled output — its PRIMARY invalidator is still real asset content
  under `packages/daemon/assets/skills/**`, and a real edit to `permissionWidening.ts` itself already
  fails `computeEmitCompareGate`'s transpile-identity check and forces the full gate, where this guard
  runs anyway via the corpus walk (the same `STATIC_GUARD_REPO_PATHS` membership ground
  `codescape-privacy-guard.mjs` already documents). See that array's own entry for this guard for the
  full reasoning.
