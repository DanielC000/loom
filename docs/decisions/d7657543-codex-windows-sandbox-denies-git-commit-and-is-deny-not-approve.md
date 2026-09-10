# d7657543 — codex's Windows sandbox denies `.git` writes, and its approval model is deny-not-approve

## Correction: codex's permission model is deny-by-default, not approve-everything

An earlier comment asserted "codex's whole permission model is the two blanket `-a never -s workspace-write` flags, which approve every tool call, write tools included." FALSE, and the opposite of the real risk. VERIFIED (codex-cli 0.153.4, `codex --help`): `-a never` is documented as "Never ask for user approval. Execution failures are immediately returned to the model" — it never ESCALATES to a human, but anything needing approval is DENIED outright and reported back to the model as a failure, never silently auto-approved. Corroborated by a real pilot worker: its own `worker_report` call was REJECTED ("requires approval and approval policy is never" — `worker_report_get` → none recorded, `worker_list` → `reportedState: null`).

The same deny-not-approve shape holds for `-s workspace-write`'s filesystem sandbox: a real, enforced allow/deny boundary (an OS-level Windows restricted-token sandbox — ALLOW ACEs on the workdir + any `--add-dir` roots), not a blanket grant — proven by this card's own finding, below, that `.git` writes are DENIED even from INSIDE a granted writable root. "Approves everything" is backwards on both axes the earlier comment conflated: MCP-tool approval and filesystem writability are each closer to deny-by-default outside an explicit grant, with no human ever asked.

This correction leaves the decision to keep codescape unmounted for codex UNCHANGED (see card `7fa73e2c`'s own record for that decision) — "denies unless explicitly granted" is at least as strict as "approves everything" would have been, so withholding codescape errs the same safe direction either way.

**Evidence tier:** ESTABLISHED — `-a never`'s own documented semantics, and the pilot's corroborated `worker_report` denial. NOT ESTABLISHED — an exhaustive enumeration of exactly which MCP tools codex classifies as approval-requiring; this correction fixes the FALSE premise but does not close that broader audit.

## Finding: a codex worker on Windows can never `git commit` in its own worktree

`git add`/`git commit` fail with `"Unable to create '<gitdir>/index.lock': Permission denied"` because a worktree's real gitdir (`<repo>/.git/worktrees/<name>`, and the shared `<repo>/.git` objects/refs it points at) sits outside every writable sandbox root a codex spawn grants (the worktree itself, `:slash_tmp`, `:tmpdir`).

This card's kickoff hypothesized a per-spawn writable-roots lever might cure this — it exists (documented, top-level `--add-dir <DIR>`: "Additional directories that should be writable alongside the primary workspace"; superseding the kickoff's own INFERRED `-c sandbox_workspace_write.writable_roots=…` guess, never confirmed, now moot). **It does not work here.** REAL-SPAWN VERIFIED (codex-cli 0.153.4, this host, 2026-09-08): `--add-dir` for the worktree's gitdir, tried three ways on FRESH never-before-sandboxed worktrees (to rule out ACL residue from an earlier probe): (1) `--add-dir <repo>/.git`, (2) `--add-dir <repo>/.git/worktrees/<name>` (the leaf), (3) no add-dir at all in a PLAIN non-worktree repo where `.git` sits directly INSIDE the already-writable workdir root — ALL THREE fail identically with `"index.lock: Permission denied"`.

`--add-dir` demonstrably DOES grant write elsewhere (verified on an ordinary non-`.git` directory) — the failure is specific to `.git`. `icacls` on the denied directory shows why: codex's Windows sandbox applies an explicit, non-inherited DENY ACE for Write/Delete directly on `.git` (a direct DENY plus an inherit-only DENY for future children), which NTFS evaluates BEFORE the inherited ALLOW `--add-dir` produces — deny always wins. A strings scan of the bundled `codex-windows-sandbox-setup.exe` confirms this is deliberate: its sandbox payload carries a dedicated `deny_write_paths` field (distinct from `write_roots`) and logs `"applied deny ACE to protect "` for entries in it.

A `codex_git_commit` feature flag exists (`codex features list` → `stage: removed`) — plausibly a rolled-back attempt to allow this — but force-enabling it (`codex features enable codex_git_commit`) and re-testing on another fresh worktree changed nothing; still denied. (Every scratch `~/.codex/config.toml` trust block and the feature-flag toggle this investigation added were removed before the introducing commit.)

**Evidence tier:** ESTABLISHED on THIS host/version (codex-cli 0.153.4, Windows). NOT ESTABLISHED: whether the same hardcoded `.git` protection exists on codex's macOS (Seatbelt) or Linux (landlock/bwrap) sandboxes — only a Windows host was tested, and the mechanism is plausibly platform-specific (this exact binary is `codex-windows-sandbox-setup.exe`).

## Do not

- Do not treat `-a never -s workspace-write` as "approves every tool call" — deny-by-default outside an explicit grant, failures returned to the model, never a human asked.
- Do not attempt `--add-dir` on `.git` (repo root or the worktree's own gitdir leaf) as a fix for a worktree's `git commit` denial — verified insufficient three ways on Windows; the sandbox's DENY ACE on `.git` wins over any inherited ALLOW from `--add-dir`.
- Do not reach for `-s danger-full-access` or `--dangerously-bypass-approvals-and-sandbox` to route around this DELIBERATE protection — out of a worker's authority; report up instead.
- Do not assume this Windows finding generalizes to macOS/Linux without a fresh probe — plausibly platform-specific.

## Source

Inline comments in `packages/daemon/src/pty/host.ts` (the JSDoc above and inline comments within `createCodexPty`), as of this tranche's HEAD. Relocated by card `8dcf8521` (tranche 15 on `pty/host.ts`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `//` comment markers.
