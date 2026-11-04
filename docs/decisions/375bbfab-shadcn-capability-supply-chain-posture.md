# 375bbfab — the shadcn/ui capability: what shipped, and its supply-chain posture

Card `375bbfab` is the integration plan (`analyses/375bbfab-shadcn-integration.md`, Research Analyst,
2026-11-02, against `main` at `ac625b5b`). This record documents what the two prerequisite cards actually
shipped — `c3f9ce1f` (the capability seed and its dotenv-exfil mitigation) and `00a7d511` (the
`loom-shadcn` skill) — verified against the code at this sha, and notes where it differs from the plan.
Every `file:line` below was checked at this sha; see `docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md`
and `docs/decisions/31f997e7-capability-bound-skill-delivery-is-hygiene-not-a-boundary.md` for the full
narrative behind the two pieces this record only summarizes.

## What shipped

### The capability (MCP mount)

Seeded in `packages/daemon/src/capabilities/seed.ts:140-163`:

- slug `shadcn`, kind **`npm-pinned`** — not the plan's phase-1 "bundled"/bare-`npx` recommendation.
  `resolveNpmPinned` installs the exact pinned release once, under `<LOOM_HOME>/node/shadcn/<version>/`,
  and the spawn hot path then only ever does `node <installed bin> mcp` — never a bare `npx` re-resolve.
  Reason (`seed.ts:42-44`): card `5b1c19c0` measured a cold `npx` median of **18.0s** against an
  **~25-27s** effective MCP-connect cutoff — too little headroom — while the direct `node <bin> mcp`
  invocation this kind gives measured **~3.1s**.
- Pinned version: `SHADCN_VERSION = "4.23.0"` (`seed.ts:94`); licence/commit verified at `seed.ts:45-47`
  ("Copyright (c) 2023 shadcn", MIT, `github.com/shadcn-ui/ui` at commit
  `4aaea19d9cff3e0908e12a8c1d504b8c5ec34610`, byte-identical after CRLF normalization against the npm
  tarball's own `LICENSE.md`).
- `provisionJson` carries `args: ["mcp"]` (`seed.ts:146-152`) — the installed bin is a multi-command entry
  point (`init`/`add`/`mcp`/…), not a single-purpose MCP server the way `image-gen`'s is, so card `c3f9ce1f`
  extended the `npm-pinned` kind's own shape to carry an optional trailing `args` array
  (`registry.ts:636-650`; additive — a row with no `args`, i.e. `image-gen`, keeps its exact pre-existing
  `[bin]` shape).
- `toolAllowlistJson: ["mcp__shadcn"]`; `requiresConnection: false`; `secretEnvVar: null` — no credential.
- `passEnv: []` at seed time (`seed.ts:162`) — see the env-exposure section below.

### `shadcn add` as the code-entry point

The `mcp__shadcn` tools (upstream's own 7: `get_project_registries`, `list_items_in_registries`,
`search_items_in_registries`, `view_items_in_registries`, `get_item_examples_from_registries`,
`get_add_command_for_items`, `get_audit_checklist`) are **read-only** — none of them installs anything, and
Loom grants the whole server via one allowlist entry, so there is no narrower slice to further restrict.
Component **code** only ever enters a repo when the agent runs the CLI's own `shadcn add` itself, in its
own shell, under the session's ordinary permission mode — the capability adds no new write path of its
own.

### The merge gate as the backstop

Whatever `shadcn add` writes lands on the worker's own branch like any other edit and goes through Loom's
ordinary worker-branch review and merge gate. Loom's capability/skill code cannot vet third-party registry
content — the merge gate is the only real check on code a `shadcn add` pulls in from a registry.

### Env-exposure finding (card `5b1c19c0`) — no proxy env reaches shadcn's child, by design

shadcn's own registry client expands `${VAR}` from its process env into registry URLs/headers named by a
repo-controlled `components.json` — so any env key reaching the mounted MCP's child process is a potential
exfiltration target to a URL an attacker names in that file.

Every Loom-built stdio MCP mount (card `fafae623`) launches through
`packages/daemon/assets/env-isolated-launch.mjs`, which rebuilds the child's env from a fixed
`BASE_ALLOWLIST` (`PATH`, `HOME`, `TEMP`, locale/cert vars, etc. — `env-isolated-launch.mjs:16-30`) plus a
per-mount `--allow` list. `NO_PROXY` is in that base; `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` are
deliberately **not** (card `188d6a8c`), and `npm_config_registry` is deliberately not either (card
`3faaab0d`) — both can carry `user:pass@host` userinfo. The shadcn row's seeded `passEnv` is `[]`
(`seed.ts:157-162`), so it gets nothing beyond that shared base — the row reaches registries with **no**
proxy configured, on purpose, not as an oversight.

This is a seed-time *default*, not a permanent lock: a human can widen it later via
`PATCH /api/capabilities/:id` (the owner-only `passEnv` escape hatch every capability row has). Every key
added that way becomes reachable the same `${VAR}`-expansion way — a deliberate, informed trade a human
makes with the exposure already in view, not a property this seed guarantees stays empty forever.

### A mitigation the plan didn't anticipate: the dotenv-exfil redirect (card `c3f9ce1f`)

Beyond env *inheritance*, shadcn's `mcp` command also reads `.env*` files directly off its own cwd's disk
before serving (`loadEnvFiles`, via a dynamic `import("@dotenvx/dotenvx")`) — a vector no env-allowlist can
bound, since it's the child reading its own filesystem, not inheriting anything. The plan's own "Unverified"
section named only the env-*inheritance* leg as something to check; it never named this second, disk-read
vector.

Closed by a `node --import` preload (`packages/daemon/assets/shadcn-no-dotenv-preload.mjs`) that
intercepts resolution of `@dotenvx/dotenvx` and redirects it to a Loom-owned no-op stub whose `config()`
matches the real library's shape but loads and mutates nothing. `registry.ts`'s `npm-pinned` branch
(`registry.ts:648`) prepends `--import <preload>` keyed on `provision.package === "shadcn"` — never on
`row.slug`/`row.name` (both owner-collidable: delete the seeded row, recreate one with the same
slug/name) — safe because `"npm-pinned"` is itself seed-only and no PATCH route touches `provisionJson`.
Full mechanism, the rejected refusal-shape alternative, and the Node-version residual (prefers
`registerHooks` for CJS+ESM coverage on Node ≥22.15; falls back to ESM-only `register()`, with a known gap,
on Node 22.0–22.14):
`docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md`.

### The skill

`packages/daemon/assets/skills/loom-shadcn/SKILL.md` — named `loom-shadcn`, not plain `shadcn` (the plan
left the name an open question; the owner's call landed on the non-colliding name, so a user's own
personal `shadcn` skill, if they install one via `skills add`, never silently overrides Loom's).

Delivered only to a session granted the `shadcn` capability, through a new, generic mechanism (card
`31f997e7`): `CAPABILITY_BOUND_SKILLS` in `packages/daemon/src/skills/inject.ts:195-197`
(`{"loom-shadcn": "shadcn"}`). The gate requires **both** the capability grant **and** a worktree-isolated
cwd (`isWorktreeCwd`) before withholding/delivering — not grant alone, as the plan's §3b sketch implied.
Three Code Review rounds on that card found and closed real data-loss and permanent-orphan hazards in the
withholding/cleanup logic (a dead session's claim going unclaimed forever on worktree reuse; deleting a
hand-edited copy; a live co-claimant's refresh reading as "hand-modified"); none of that narrative is
repeated here — see `docs/decisions/31f997e7-capability-bound-skill-delivery-is-hygiene-not-a-boundary.md`.
That record's own "Do not" list is explicit, and worth restating once: **a bound skill's presence (or
absence) is delivery hygiene, never a security boundary — the capability grant gating the MCP mount is the
real gate.**

Attribution lives in the skill's own `NOTICE` file: MIT, no upstream text reproduced verbatim (condensed,
original prose), and explicitly **not** carrying over upstream's own unpinned render-time shell command
(`` !`npx shadcn@latest info --json` ``) or its `allowed-tools` frontmatter grant — exactly the two hazards
the plan's §3b flagged as reasons not to vendor the upstream skill as-is.

## Where this differs from the plan (`analyses/375bbfab-shadcn-integration.md` §5/§6)

1. **Phase staging collapsed.** The plan's phase 1 recommended shipping the `bundled`/`npx` shape first and
   accepting cold-start risk, with a `npm-pinned` kind as a "separate epic decision" (§6, card 8) for
   later. What shipped went straight to `npm-pinned`. This was possible because that kind had *already*
   landed independently (`feat(capabilities): add an npm-pinned provision kind under LOOM_HOME`, predating
   the shadcn seed commit) for `image-gen`'s own migration off `bundled`/`npx` (card `e7d6e43b`) — by the
   time card `c3f9ce1f` shipped the shadcn row, the "separate epic" the plan deferred had already happened,
   so there was no reason to accept the plan's phase-1 cold-start risk at all. The `npm-pinned` kind itself
   needed one small, additive extension for shadcn (the optional trailing `args`, above) — not a new kind.
2. **Skill name decided.** `loom-shadcn`, settling the plan's open question (§6).
3. **The delivery-filter mechanism grew well past the plan's sketch.** §3b described "a small static map in
   `inject.ts`" with no isolation or cleanup discussion. What shipped (card `31f997e7`) added a worktree-
   isolation precondition and a content-fingerprinted cleanup pass, after Code Review reproduced real
   data-loss sequences the simple grant-only gate would have had. See that card's own record.
4. **A second supply-chain vector was found and closed that the plan never named.** The plan's "Unverified"
   section listed only env-*inheritance* as something to check. Card `c3f9ce1f` additionally found and
   closed a direct `.env*` disk-read vector (above) that inheritance controls alone cannot reach.
5. **Phase 2 card 6 (network badge + generalized per-capability provisioning UI) is not specific to this
   card, and was not blocked on it.** The plan proposed a new `CapabilitySummary.network: boolean` field.
   What actually shipped (card `cd9a78bc`, checked at `packages/web/src/lib/capabilityProvisioning.ts:104,115,119`)
   is **kind-based**, not a per-row flag: `KIND_FACTS["npm-pinned"] = {provisioned: true, network: true}`,
   so every `npm-pinned` row — shadcn included, automatically — already gets the muted "network" badge
   (`Profiles.tsx:756-757`) and a per-slug provisioning status row (`Profiles.tsx:795-803`, backed by
   `GET /api/capabilities/:slug/provisioning` and a retry route, `gateway/server.ts:1261-1265`) with no
   shadcn-specific work needed. Confirmed this isn't a false "shipped" claim by reading the actual
   `KIND_FACTS` table and the live route registrations, not by inference from the plan.
6. **Web Designer was not pre-ticked with the grant** — `packages/daemon/src/profiles/seed.ts` has no
   `shadcn` reference at all. Matches the plan's recommendation (§3a: "Leave Web Designer's seed
   untouched").

## Pin-bump procedure

1. Edit `SHADCN_VERSION` in `packages/daemon/src/capabilities/seed.ts` (currently `"4.23.0"`) — a
   deliberate, reviewed act, never automated.
2. No cleanup step is required for the old version: the install dir is version-namespaced
   (`<LOOM_HOME>/node/shadcn/<version>/`, `npm-pinned.ts`'s `loomNpmPinnedDir`), so a bump installs fresh on
   next provisioning and never overwrites the previous version in place.
3. **Before shipping the bump, re-run `packages/daemon/test/shadcn-dotenv-exfil-real-spawn.mjs` by hand**
   with `LOOM_NETWORK_SMOKE=1` set. This installs the real new release over the network and re-verifies the
   dotenv-exfil mitigation (above) still holds against whatever `loadEnvFiles`/`@dotenvx/dotenvx` import
   shape the new release actually has. The hermetic tests (`shadcn-no-dotenv-preload.mjs`,
   `shadcn-capability.mjs`) only prove the preload/stub *wiring* in isolation — they cannot catch a future
   shadcn release changing its import shape, and this real-spawn test is deliberately excluded from
   `guards`/the ordinary gate (it installs a real package over the network), so nothing else will run it
   for you. Treat this step as non-optional, not a formality — a version bump that skips it ships with an
   *unverified* mitigation, which is strictly worse than not knowing the mitigation needs re-checking.
4. If attribution in the skill's `NOTICE` is also being refreshed, note that the commit hash recorded there
   (`4aaea19d9cff3e0908e12a8c1d504b8c5ec34610`) is the `shadcn-ui/ui` *repo* commit the condensed skill text
   and the seed's own licence-hash check were verified against — it does not automatically track an npm
   version bump, and bumping one doesn't imply re-verifying the other.
5. If step 3 ever fails, that's the signal the mitigation needs rework, not that the test is stale — see
   `docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md`'s own "Do not" list before changing
   anything about how the redirect is wired.

## Pointers

- `docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md` — the dotenv mitigation, in full.
- `docs/decisions/31f997e7-capability-bound-skill-delivery-is-hygiene-not-a-boundary.md` — the capability-
  bound skill delivery mechanism, in full.
- `docs/decisions/fafae623-env-isolating-launcher-for-stdio-mcp-mounts.md` — the env-isolating launcher
  every stdio mount (shadcn included) launches through.
- `docs/decisions/e7d6e43b-npm-pinned-shell-true-and-pin-scope.md` — the `npm-pinned` provision kind's own
  atomicity/validation contract.
- `analyses/375bbfab-shadcn-integration.md` — the original integration plan this record checks against.
