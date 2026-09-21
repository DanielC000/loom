# 90dc3c8c — `CODEX_AUTO_APPROVE_MCP_SERVER_IDS` widened to loom-setup/loom-operator/loom-platform, not all six

## The gap this closes

Card `702f2197` granted `default_tools_approval_mode=approve` to `loom-tasks` + `loom-orchestration` only — the two servers a WORKER mounts, which is all that card needed. But `harness` is profile-pinned and resolved on every role's spawn path, so a codex `setup`/`operator`/`platform`/`auditor`/`workspace-auditor`/`run` session was equally spawnable, and every tool call on that session's OWN first-party role surface was (and, for three of the six, still is) denied by `-a never` — the exact defect `702f2197` fixed, unfixed for the other six.

## Per-role analysis (the DoD this card required — reachability first, then claude parity)

**Reachability was established by code-reading `sessions/service.ts`'s six `start*` methods plus an empirical `validateProfile()` probe (not assumed):**

| role | mounts | reachable today? | why |
|---|---|---|---|
| setup | loom-setup | yes | ungated CORE profile ("Setup Assistant"/"Platform" operator), `role:"setup"` is a valid `profileSchema` enum member, `startSetup` threads `harness` through to `pty.spawn` |
| operator | loom-operator | yes | ungated CORE profile ("Elevated Operator"), flag-gated at spawn time (`platform.operatorEnabled`) not seed time, `role:"operator"` is a valid enum member, `startOperator` threads `harness` through |
| platform | loom-platform | yes (under `LOOM_DEV`) | "Platform-lead" bundled profile seeds only under `LOOM_DEV`, but when it does, `role:"platform"` is a valid enum member and `startPlatformLead` threads `harness` through |
| auditor | loom-audit | **no** | `profileSchema`'s `role` enum deliberately EXCLUDES `"auditor"`/`"workspace-auditor"` (profiles/validate.ts, by design — a profile must never confer either, only `startAuditor`'s explicit caller role can). The bundled "Platform-audit" profile carries `role:"auditor"` anyway (seeded outside that validator). `PUT /api/profiles/:id` merges `{...existing, ...patch}` then re-validates the WHOLE merged object — so ANY patch to this profile (including a harness-only one) re-validates `role:"auditor"` against the enum and 400s. Verified empirically: `validateProfile({..., role:"auditor", harness:"codex"})` → `{ok:false, error:"role: Invalid option..."}`, against a control (`role:"setup"`, same patch) → `{ok:true}`. `harness` can never be set on this profile via any live human action — only by editing the `BUNDLED_PROFILES` literal in `profiles/seed.ts` and redeploying. |
| workspace-auditor | loom-user-audit | **no** | same mechanism as auditor — "Workspace Auditor" is a CORE ungated profile, but `role:"workspace-auditor"` is equally excluded from the enum, so the same PUT-revalidation blocker applies. |
| run | loom-run | **no** | `sessions/service.ts#startRun` calls `resolveAgentSpawn(agent, config, "run")` but destructures only `{ model, skills }` from the result — `harness` is silently dropped and never reaches its `pty.spawn(...)` call. A "run" session boots as claude regardless of what an agent's profile pins `harness` to. (`createCodexPty` itself works fine for `role:"run"` when invoked directly — this is a gap in the SERVICE layer's wiring, not the PTY layer.) |

**Claude parity:** under claude, every role already boots unattended with `--permission-mode`+allowlist covering its own curated MCP surface — so claude already runs setup/operator/platform (and, if it were reachable, auditor/workspace-auditor/run) fully autonomously with no human approving individual tool calls. Codex has no per-tool mechanism, only this per-server lever (per `702f2197`'s own finding) — so for a REACHABLE role, "proportionate" reduces to a binary: either the whole already-curated, already-role-gated surface is usable under codex (matching claude), or the role is completely non-functional under codex. There is no narrower, safer middle ground available.

## The decision

Widened `CODEX_AUTO_APPROVE_MCP_SERVER_IDS` to `loom-tasks`, `loom-orchestration`, `loom-setup`, `loom-operator`, `loom-platform` — the five of eight first-party ids whose role is reachable today. `loom-platform` (Platform Lead) is the most privileged of the three added: CLAUDE.md already documents that this role is trusted, human-driven-but-unattended, to `git_checkout`/`git_commit`/`git_push`/`vault_write` as agent tools under claude — this grant does not create a new trust boundary, it extends an already-made one to a second harness.

**Deliberately NOT widened to `loom-audit`/`loom-user-audit`/`loom-run`** — not a proportionality judgement (parking that question), but because granting an unreachable role's auto-approve is dead code with zero present benefit, and the card's own instruction is "do NOT just add all six" without a concrete need. Revisit each once its OWN independent blocker is fixed (a future card):
- auditor / workspace-auditor: the `PUT /api/profiles/:id` merge-then-revalidate blocker above.
- run: thread `harness` through `startRun`'s `pty.spawn()` call.

## Do not

- Do not add `loom-audit`/`loom-user-audit`/`loom-run` to this set without first re-verifying their reachability has actually changed — the blockers above are structural, not incidental, and adding the id alone does nothing until the underlying gap is closed.
- Do not treat this widening as settling the loom-audit/loom-user-audit proportionality question — reachability made that question moot for now, not the underlying privilege judgement, which still needs its own per-role analysis once the profile-validation blocker is fixed.
- Do not restate the `.size ===` guard count or the six-role table here if either changes — re-derive from `codex-host-decisions.mjs` / `sessions/service.ts` directly; this record is a snapshot of the 2026-09-21 analysis, not a live source of truth for either.
