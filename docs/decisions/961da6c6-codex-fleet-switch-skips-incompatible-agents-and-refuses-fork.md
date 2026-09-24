# 961da6c6 — a default-derived codex harness skips codex-incompatible agents; per-role allowlist; codex fork refuses

Card `961da6c6` (C5 of the codex non-worker parity design; gate card `4c4eb9af`; default-harness config card `66b1b40d`).

## 1. The fail-open this closes

`resolveAgentSpawn` (`sessions/service.ts`) fills an UNSET profile `harness` from the human `harness.default` (project ?? platform ?? claude, `worker` only). `validateProfile`'s codex rejections (`profiles/validate.ts`: `restrictedTools`, and the stdio-only `browserTesting`/`documentConversion`/`capabilities`) fire ONLY at profile-save time for a profile that explicitly says `harness:"codex"`. A default-derived codex harness never passes through them.

Checked at source (card `961da6c6`, this worktree): **codex ignores `restrictedTools` entirely.** `git grep -n restrictedTools -- packages/daemon/src/pty` returns hits only in the `SpawnOpts` field, `RESTRICTED_NATIVE_TOOLS`/`disallowedToolsForSpawn`, and its single call site in the CLAUDE `createPty` path (`host.ts` ~6058, after the `if (opts.harness === "codex") { this.spawnCodexProcess(opts); return; }` dispatch at ~4411). Nothing in `createCodexPty` (~4802-4940) or `spawnCodexProcess` reads it. Positive control: the same pattern DOES hit the claude call site. So a restricted worker under a codex default would run with codex's full workspace-write shell/file access while its profile still read "restricted" — the gap `validate.ts`'s own doc comment names as the reason for the save-time rejection, reachable through the default layer instead.

The other three stdio fields are dropped at `mcpServersToCodexArgs` and reported via `onCodexUnsupportedCapability`.

## 2. Decision: skip-and-record

`defaultHarnessForSpawn` applies a default-derived codex harness only when `codexIncompatibilities(...)` (`profiles/codex-compat.ts`, the ONE source of the reason strings for the profile fields, shared with `validate.ts`) is empty for the resolved profile. An incompatible agent stays claude; the reasons are returned as `harnessDefaultSkipped` and the FRESH-spawn caller (`spawnWorker`) files a durable `harness_default_skipped` orchestration event with exact attribution (`managerSessionId` = the spawning manager, `workerSessionId` = the new session — filed after the row exists, never at resolve time, since resume/fork/recycle also call the resolver). An EXPLICIT `harness:"codex"` profile is unchanged (human-chosen; validate-rejected; spawn-time signal remains as defense-in-depth per `b987f086`).

**Codescape is deliberately NOT a skip reason** (manager ruling, code-review of card `961da6c6`): it is fail-CLOSED — simply not mounted for codex (decisions `7fbd1ba5`, `d7657543`) and already reported loudly at spawn via `onCodexUnsupportedCapability` (`CODEX_CODESCAPE_REASON`, `pty/host.ts`). Skipping on it would make a codex default a no-op on every codescape-enabled project, Loom itself included. Only FAIL-OPEN items (`restrictedTools`) and PURPOSE-DEFEATING ones (the stdio capabilities: a browser/document rig without its browser/converter cannot do its job) keep a worker on claude.

A human "+New" (`startNew`) on a worker-role agent takes the same default and the same guard, and files the event with manager = the session itself; `worker_spawn`'s result carries `harnessDefaultSkipped:{items,note}` (additive) so the spawning manager sees it without searching events.

Rejected: refusing at config-write time (a global knob would refuse over one agent of N), and signal-only (fail-open for `restrictedTools`).

## 3. Per-role allowlist (`HARNESS_FLEET_ROLES`, shared/config.ts)

One shared const read by BOTH the `scope:"fleet"` validator refinement and `harnessDefaultForRole`, so they cannot diverge. It is `["worker"]` — identical to today's behaviour; this card widens nothing. A free-form `roles` config key was rejected: roles are the security spine, not user toggles.

Note: the "plain" role (`undefined`) has no representation in a `SessionRole[]` allowlist, so it needs one designed before it can be listed. Intended rollout SEQUENCE (not a commitment; each widening is its own card and may need an owner Request): worker (today) → plain/run → manager, assistant (after a doctrine-parity + fork/codescape-degrade card) → setup, auditor, workspace-auditor (they carry safety doctrine — last) → platform lead (human-driven, elevated — very last).

## 4. Fork on codex refuses

Codex has no `--fork-session` equivalent (memory `codex-fork-has-no-engine-equivalent`); `createCodexPty` falls through to a fresh spawn. A "fork" that silently becomes a fresh empty conversation is worse than an honest error, so `SessionService.forkSession` REFUSES a codex-pinned source with a clear error and creates nothing. Exhaustive caller check: the only production caller is `POST /api/sessions/:id/fork` (`gateway/server.ts`); the web callers (`useSessionActions.ts`, `Overview.tsx`) go through `api.forkSession` → `post`, which throws the daemon's message, and `main.tsx`'s global `MutationCache.onError` surfaces it — no web change needed. The `console.warn` in `createCodexPty` stays as defense-in-depth.

## Do not

- Do not apply a default-derived codex harness without the compatibility check and rely on the spawn-time `onCodexUnsupportedCapability` report — it is a signal, and codex silently ignores `restrictedTools`.
- Do not add codescape (fail-closed) back to the skip list.
- Do not copy the reason strings; import them from `profiles/codex-compat.ts` so validate, spawn and the default guard cannot drift.
- Do not widen `HARNESS_FLEET_ROLES` in an unrelated change, or add a free-form roles config key.
- Do not turn the codex-fork refusal back into a degrade-to-fresh-spawn on the human route.
