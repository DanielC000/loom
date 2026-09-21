# d7657543 — codex's Windows sandbox denies `.git` writes, and its approval model is deny-not-approve

## Correction: codex's permission model is deny-by-default, not approve-everything

An earlier comment asserted "codex's whole permission model is the two blanket `-a never -s workspace-write` flags, which approve every tool call, write tools included." FALSE, and the opposite of the real risk. VERIFIED (codex-cli 0.153.4, `codex --help`): `-a never` is documented as "Never ask for user approval. Execution failures are immediately returned to the model" — it never escalates to a human, but anything needing approval is DENIED and reported back to the model as a failure, never silently auto-approved. Corroborated by a real pilot worker: its own `worker_report` call was REJECTED ("requires approval and approval policy is never").

The same deny-not-approve shape holds for `-s workspace-write`'s filesystem sandbox: a real, enforced allow/deny boundary (ALLOW ACEs on the workdir + any `--add-dir` roots), not a blanket grant — proven by this card's own `.git` finding below. Leaves the decision to keep codescape unmounted for codex UNCHANGED (card `7fa73e2c`) — "denies unless explicitly granted" errs the same safe direction either way.

**Evidence tier:** ESTABLISHED — `-a never`'s documented semantics, and the pilot's corroborated denial. NOT ESTABLISHED — an exhaustive enumeration of which MCP tools codex classifies as approval-requiring.

**Forward reference (card `702f2197`):** the `worker_report` denial cited above is now fixed — see `docs/decisions/702f2197-codex-mcp-server-approve-mode-bypasses-a-never-blanket-deny.md` for the source-verified mechanism (a per-server `default_tools_approval_mode` override) and the narrow, non-widening lever it applies to Loom's own first-party MCP servers.

## Finding: a codex worker on Windows can never `git commit` in its own worktree

`git add`/`git commit` fail with `"Unable to create '<gitdir>/index.lock': Permission denied"` because a worktree's real gitdir (`<repo>/.git/worktrees/<name>`, and the shared `<repo>/.git` objects/refs it points at) sits outside every writable sandbox root a codex spawn grants.

The per-spawn writable-roots lever `--add-dir <DIR>` **does not fix this.** REAL-SPAWN VERIFIED (codex-cli 0.153.4, 2026-09-08): tried three ways on FRESH worktrees — `--add-dir <repo>/.git`, `--add-dir` at the worktree's own gitdir leaf, and no add-dir at all in a plain non-worktree repo where `.git` sits directly inside the already-writable workdir — ALL THREE fail identically.

`--add-dir` demonstrably DOES grant write elsewhere — the failure is specific to `.git`. `icacls` on the denied directory shows why: codex's Windows sandbox applies an explicit, non-inherited DENY ACE for Write/Delete directly on `.git`, which NTFS evaluates BEFORE the inherited ALLOW `--add-dir` produces — deny always wins. A strings scan of the bundled `codex-windows-sandbox-setup.exe` confirms this is deliberate: its sandbox payload carries a dedicated `deny_write_paths` field and logs `"applied deny ACE to protect "` for entries in it.

A `codex_git_commit` feature flag exists (`stage: removed`) — plausibly a rolled-back attempt to allow this — but force-enabling it and re-testing changed nothing; still denied.

**Evidence tier:** ESTABLISHED on THIS host/version (codex-cli 0.153.4, Windows) — see the correction below for the cross-platform half.

## Correction: the `.git` block is NOT Windows-only — it's every platform, confirmed at source

Card `00a6cdd6` (owner request `54aba8b2`) later resolved the "plausibly platform-specific" question this record originally left open, by reading codex's own source rather than inferring from the `codex-windows-sandbox-setup.exe` filename. At the pinned version (`codex-cli 0.153.4`, tag `rust-v0.153.4`, commit `3d2ee51c`), `codex-rs/protocol/src/permissions.rs:32` defines `PROTECTED_METADATA_PATH_NAMES = [".git", ".agents", ".codex"]` — NOT platform-gated — and all three sandboxes consume that SAME constant, each translating it to its own OS primitive: Windows → the ACL DENY ACE this record documents · macOS → Seatbelt deny rules (`seatbelt.rs:8`) · Linux → bubblewrap read-only binds (`bwrap.rs:30`). Built as one coordinated cross-platform feature (PRs #19846/#19847/#19852, merged 2026-04-28/29), not a Windows quirk that spread, and there are real dated user reports of the identical failure on macOS and Linux. So: a codex worker cannot be a committing worker on ANY platform, by upstream design — this record's Windows-specific evidence stands, and the platform-specific caveat below it is retracted.

## Do not

- Do not treat `-a never -s workspace-write` as "approves every tool call" — deny-by-default outside an explicit grant, failures returned to the model, never a human asked.
- Do not attempt `--add-dir` on `.git` (repo root or the worktree's own gitdir leaf) as a fix for a worktree's `git commit` denial — verified insufficient three ways on Windows; the sandbox's DENY ACE on `.git` wins over any inherited ALLOW from `--add-dir`.
- Do not reach for `-s danger-full-access` or `--dangerously-bypass-approvals-and-sandbox` to route around this DELIBERATE protection — out of a worker's authority; report up instead.
- ⛔ RETRACTED (see the correction above): do NOT carry forward "this is plausibly Windows-only" — it is confirmed, at source, cross-platform.

## Source

Inline comments in `packages/daemon/src/pty/host.ts` (the JSDoc above and inline comments within `createCodexPty`), as of this tranche's HEAD. Relocated by card `8dcf8521` (tranche 15 on `pty/host.ts`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `//` comment markers.
