# 8a230f60 — is codex's `.git` write-deny Windows-only, or all-platforms?

Worker investigation. `filesChanged` for this task is this document only — no `packages/` source touched, per the card's own fence.

## The one-sentence verdict

**ALL-PLATFORMS, at SOURCE-CONFIRMED tier — not Windows-only.** The protection that makes a worker unable to `git commit` inside a codex-sandboxed worktree comes from a single, platform-independent policy decision (`PROTECTED_METADATA_PATH_NAMES = [".git", ".agents", ".codex"]`, `codex-rs/protocol/src/permissions.rs`) that all three of codex's platform-specific sandbox backends — Windows, macOS Seatbelt, Linux bubblewrap — consume identically. The *mechanism* differs per platform (this is the part `d7657543` correctly flagged as plausible); the *outcome* — `.git` unwritable under a writable root, absent an explicit write carveout — does not.

## Evidence tier legend

- **MEASURED** — I ran the command / opened the file myself and quote its exact output.
- **THIRD-PARTY-OBSERVED** — a named, dated bug report on `openai/codex` describing a real run on a real platform, not from Loom.
- **INFERRED** — a conclusion I drew from the above, not itself independently run.

Per the card's own instruction, no claim below is drawn from a filename alone (the `codex-windows-sandbox-setup.exe` filename that started this question is treated as exactly what it is — zero evidentiary weight — and superseded entirely by what follows).

## What I checked, in the order the card ranked it

### 1. Codex's own open-source Rust source (strongest available tier)

`@openai/codex`'s own `package.json` on this host names its source: `"repository": {"url": "git+https://github.com/openai/codex.git", "directory": "codex-cli"}` (MEASURED: `C:\Users\danie\AppData\Roaming\npm\node_modules\@openai\codex\package.json`). I do not have a local clone; I fetched the public GitHub repo directly by raw URL + the GitHub REST API (`api.github.com`), which is unauthenticated read access to public source, not a community mirror.

**Which commit, precisely.** The installed binary is `codex-cli 0.153.4` (MEASURED: `codex --version`, and the npm registry's own `time` field for `@openai/codex` — `"0.153.4": "2026-09-04T23:31:18.513Z"`). The git tag `rust-v0.153.4` (MEASURED via `GET /repos/openai/codex/git/refs/tags`) is an annotated tag object tagged `2026-09-04T22:41:05Z` by `rhan-oai` — 20 minutes before the npm publish timestamp — pointing at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. Every source quote below is fetched **at that exact commit**, not at `main` (which has since moved on), so this is the actual code that shipped in the version on this host, not a claim about "whatever `main` currently says."

**The shared, platform-independent policy primitive.** `codex-rs/protocol/src/permissions.rs` (MEASURED, at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`), lines 27–35:

```rust
const PROTECTED_METADATA_GIT_PATH_NAME: &str = ".git";
const PROTECTED_METADATA_AGENTS_PATH_NAME: &str = ".agents";
const PROTECTED_METADATA_CODEX_PATH_NAME: &str = ".codex";

pub const PROTECTED_METADATA_PATH_NAMES: &[&str] = &[
    PROTECTED_METADATA_GIT_PATH_NAME,
    PROTECTED_METADATA_AGENTS_PATH_NAME,
    PROTECTED_METADATA_CODEX_PATH_NAME,
];
```

No `#[cfg(target_os = ...)]` or `#[cfg(windows)]`/`#[cfg(unix)]` gate surrounds this constant or its containing module (MEASURED: I grepped the whole 4,468-line file for every `cfg(` occurrence — the nearest ones, at lines 2494+, gate unrelated platform-specific *test* helpers far below this declaration, not the constant itself or the `can_write_path`/`metadata_write_denial` functions that consume it at lines 970–1002). The actual deny decision lives in `metadata_write_denial` (lines 977–1002): a path under a writable root is denied if it falls under one of `PROTECTED_METADATA_PATH_NAMES` **unless** some other, more specific writable entry exists that itself descends from that protected path (i.e., an explicit, narrower write grant *inside* `.git` specifically — not merely a grant on its parent). This is the "unless the policy grants an explicit write rule for that metadata path" carveout referenced in the PRs below; a plain `--add-dir <parent>` grant does not create such an entry, which is consistent with `d7657543`'s own finding that `--add-dir` failed to unlock `.git` on Windows.

**All three platform adapters consume the exact same constant — MEASURED at the same commit, not `main`:**

- **Windows** — `codex-rs/windows-sandbox-rs/src/allow.rs`: line 36, `for read_only_subpath in writable_root.read_only_subpaths { ... }` (fed by the shared policy's resolved roots); test functions `denies_git_dir_inside_writable_root` (line 257) and `denies_git_file_inside_writable_root` (line 288) exist specifically to pin this behavior for both `.git`-as-directory and `.git`-as-file (the latter is the worktree/submodule shape).
- **macOS** — `codex-rs/sandboxing/src/seatbelt.rs`: line 8, `use codex_protocol::permissions::PROTECTED_METADATA_PATH_NAMES;`, consumed at lines 599–605 (`protected_metadata_names_for_writable_root`) and translated into Seatbelt deny rules via `seatbelt_protected_metadata_name_regex` (line 604 in the `main`-branch copy; function present, MEASURED, at the pinned commit too).
- **Linux** — `codex-rs/linux-sandbox/src/bwrap.rs`: line 30, `use codex_protocol::permissions::is_protected_metadata_name;`, consumed at lines 592–603 and 1096, translated into bubblewrap `--ro-bind` (read-only bind-mount) arguments for each protected metadata path under a writable root.

**Provenance of this shared logic — a coordinated, cross-platform PR stack, MEASURED via GitHub's PR API:**

| PR | Scope | Status | Merge date | Merge SHA |
|---|---|---|---|---|
| [#19846](https://github.com/openai/codex/pull/19846) | Core policy primitive (`FileSystemSandboxPolicy`, platform-independent) | Merged | 2026-04-28 | `0156b1e` |
| [#19847](https://github.com/openai/codex/pull/19847) | macOS Seatbelt adapter | Merged | 2026-04-28 | `0670d89` |
| [#19852](https://github.com/openai/codex/pull/19852) | Linux bubblewrap adapter | Merged | 2026-04-29 | `74f06dc` |

#19846's own description (MEASURED, quoted verbatim by GitHub's PR view): *"Make FileSystemSandboxPolicy the semantic source of truth for project root metadata protection. Under writable roots, `.git`, `.codex`, and `.agents` stay protected unless user policy grants an explicit write rule for that metadata path."* #19847's "Reviewer Focus" section states explicitly *"This PR only covers the macOS sandbox adapter"* and lists sibling PRs for the policy primitive, macOS, Linux, plus UX/propagation PRs — i.e. this was planned from the start as one cross-platform feature landing in four+ coordinated PRs, not a Windows fix that happened to also apply elsewhere. All three PRs merged **before** the `rust-v0.153.4` tag (2026-09-04) — five months of runway, not a same-day coincidence — so there is no live-at-tag-time ambiguity to hedge on.

### 2. Codex's own official docs

I did not find a docs page that discusses the `.git`/`.codex`/`.agents` metadata carveout directly (the public docs describe sandbox *modes* — `read-only`/`workspace-write`/`danger-full-access` — not this specific internal carveout). Recording this as a genuine gap rather than silently skipping it: **the official docs are silent on this point**, so tier 1 (source) and tier 3 (installed package, below) carry the whole finding; tier 2 contributes nothing either way here.

### 3. The installed package on this host

`C:\Users\danie\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\` contains only `codex-win32-x64` (MEASURED: directory listing) — npm's `optionalDependencies` resolution installed only the platform-matching binary, so I cannot inspect a macOS or Linux binary directly from this host. `package.json`'s `optionalDependencies` (MEASURED, quoted above) does list all six platform/arch variants (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`) as siblings of the exact same version, `0.153.4` — i.e. one release, six platform builds, not a Windows-specific package with the others trailing behind on an older codebase. This is consistent with (not independent proof beyond) the single-source-tree finding in §1.

## Corroboration: independent, third-party, dated bug reports on non-Windows platforms (THIRD-PARTY-OBSERVED)

Not relied upon alone — the card is explicit that a blog post is insufficient — but these are first-person `openai/codex` issue-tracker reports of real runs, not community blog commentary, and I cite them only as corroboration on top of the source-level finding above, never as the finding itself:

- **macOS** — [issue #7071](https://github.com/openai/codex/issues/7071): Darwin 24.6.0 arm64, `codex-cli 0.61.0`, error `"Unable to create '/path/.git/index.lock': Operation not permitted"` when committing — the same failure signature (down to the exact git internal error) as `d7657543`'s Windows finding (`"Unable to create '<gitdir>/index.lock': Permission denied"`), five months and one major platform apart.
- **Linux** — [issue #15505](https://github.com/openai/codex/issues/15505): Manjaro Linux, reports `.git` write failing with `"Read-only file system"` under `sandbox_mode = "workspace-write"` with the repo explicitly in `writable_roots` — the reporter's own diagnosis, *"a sandbox mount or policy issue, not a Unix permissions issue,"* matches the mechanism found in §1.
- **Linux, worktree-specific** — [issue #27418](https://github.com/openai/codex/issues/27418): Linux 6.8.0, `codex-cli 0.139.0`, *"the Linux sandbox remounts the resolved worktree gitdir read-only even when the Codex permission profile explicitly grants write access to the repository `.git` directory"* — this is the closest third-party analogue to Loom's own exact failure shape (a **git worktree's** separate gitdir, not a plain repo's inline `.git`), independently reproduced on Linux.

I did not find (and did not exhaustively search for) a third-party report of the identical worktree-gitdir shape on macOS specifically; the macOS corroboration I have (#7071) is for a plain repo, not a worktree. Flagging that gap rather than papering over it — see "What I could not check," below.

## What I could NOT check, and why

- **I cannot spawn codex on macOS or Linux.** This host is Windows only, and the card explicitly forbids treating an untested platform as verified. Everything above is source-level + third-party-report corroboration, never a spawn I ran myself on those platforms.
- **I did not verify the exact Loom failure shape (a fresh git worktree's gitdir, denied even with `--add-dir` pointed at it) on macOS or Linux end-to-end.** I verified: (a) the shared source-level policy is identical across all three platforms at the exact shipped commit, and (b) third-party reports confirm the *general* `.git`-under-workspace-write denial on both non-Windows platforms, and the *worktree-specific* variant on Linux. I did not find an independent report of the worktree-specific variant on macOS, and I have no way to produce one myself from this host.
- **I did not attempt to enumerate the "explicit write rule for that metadata path" carveout mechanism's exact CLI/config surface** (i.e., what a user would actually type to grant write access *inside* `.git` specifically, as opposed to a parent directory). This is out of scope for the card's one question and touches the "how would you route around it" territory the card and prior cards (`d7657543`) already fence off.
- **I did not check codex versions after `0.153.4`** (`0.154.0`+, already tagged as of this investigation) for a regression or reversal of this policy — out of scope, since `0.153.4` is what is actually installed on this host and what the commit-blocker finding (`d7657543`/`8f2025fc`) was established against.

## Answering the trap the card was filed to avoid

The lead's own hypothesis (Windows-only, because an ACL DENY ACE is a Windows-specific primitive with no direct POSIX equivalent) was reasoning about the *mechanism*, and that reasoning was correct as far as it went: the enforcement mechanism genuinely does differ per platform — an ACL deny entry on Windows, a Seatbelt profile deny rule on macOS, a bubblewrap read-only bind-mount on Linux. What the source shows is that all three mechanisms are driven by one shared, deliberately platform-independent policy decision, so the *outcome* — a worker cannot `git commit` inside a codex-sandboxed worktree — does not depend on which of the three it's running on. This is exactly the failure mode the card asked me to watch for: right about the mechanism, wrong about the answer if stated as "Windows-only." The verdict here is **ALL-PLATFORMS**, not "undetermined" and not "Windows-only" — the source evidence is specific (named constant, named file, named commit matching the installed version) rather than inferred from a filename or a single doc page, which is the bar the card set for moving past "undetermined."

## Do not

- Do not treat the `codex-windows-sandbox-setup.exe` filename as evidence of anything — it carries zero weight in this finding; the actual evidence is the shared `PROTECTED_METADATA_PATH_NAMES` source consumed identically by all three platform adapters at the commit tagged `rust-v0.153.4`.
- Do not read this finding as "the blocker is solved" or as unblocking this (Windows) host — it isn't, and the owner's trust-posture decision on that separate question is tracked at pending request `54aba8b2` (which supersedes the cancelled `78a09faa` — this document's own all-platforms verdict is why the earlier request was withdrawn and re-filed), not here.
- Do not assume the worktree-gitdir-specific shape is confirmed on macOS by a third party — only the general `.git`-under-workspace-write shape is (issue #7071); the worktree-specific shape is confirmed on Linux (#27418) and Windows (Loom's own `d7657543`), not macOS.
- Do not cite `main`-branch source as if it were what shipped in `0.153.4` — always pin to commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (tag `rust-v0.153.4`) when re-verifying any claim in this document, since `main` has moved on since.

## Source

- `codex-rs/protocol/src/permissions.rs`, `codex-rs/windows-sandbox-rs/src/allow.rs`, `codex-rs/sandboxing/src/seatbelt.rs`, `codex-rs/linux-sandbox/src/bwrap.rs` — `github.com/openai/codex` at commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (tag `rust-v0.153.4`).
- PRs [#19846](https://github.com/openai/codex/pull/19846), [#19847](https://github.com/openai/codex/pull/19847), [#19852](https://github.com/openai/codex/pull/19852).
- Issues [#7071](https://github.com/openai/codex/issues/7071) (macOS), [#15505](https://github.com/openai/codex/issues/15505) (Linux), [#27418](https://github.com/openai/codex/issues/27418) (Linux, worktree).
- `C:\Users\danie\AppData\Roaming\npm\node_modules\@openai\codex\package.json` (installed version, repo pointer, optionalDependencies list) and `npm` registry metadata for `@openai/codex` (publish timestamp).
- `docs/decisions/d7657543-codex-windows-sandbox-denies-git-commit-and-is-deny-not-approve.md` — the Windows-side finding this investigation extends.
- Project memory `run-the-third-partys-help-before-writing-structural` (v2) — read before forming a hypothesis, per the card.
