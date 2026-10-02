# 8d26596b — every stdio MCP mount gets `LOOM_MCP_TOKEN` forced blank, at one chokepoint, both platforms

## Background

`discoveredFrom 2be634f2`'s Code Review (2026-10-02). Since `a50b8afd`, on win32 the per-session
`LOOM_MCP_TOKEN` rides `claude`'s own process env (a deliberate, accepted move — see that record's "win32
env inheritance, noted and accepted" section). `a50b8afd` reasoned this was safe because it's "that SAME
session's own short-lived token, already fully available to that session via its own MCP tool calls" — but
that reasoning was built around the agent's own shell inheriting it, and never separately considered a
**third-party stdio MCP server** claude also spawns: a capability/connection binary (or even Loom's own
playwright/markitdown, which call back into nothing of Loom's) receiving this session's own bearer token
for no functional reason, since none of them talk to Loom's MCP HTTP surface at all.

## Live measurement (investigation phase, no source edits) — win32, real `claude 2.1.287`, one round only

Per the owner's account being near its weekly limit, this card did ONE round of real `claude` spawns
(a throwaway cwd + a tiny stdio probe logging only env-var NAMES + boolean match flags, never values) and
then built from that evidence — no further real spawns for the build/test phase; every test below is
hermetic (pure `buildMcpServers`, no `claude` spawn at all).

- **Negative control** (`LOOM_MCP_TOKEN` unset on claude's own env, no explicit `env` field on the stdio
  mount): probe sees `loomMcpTokenKeyPresent: false`.
- **Positive run** (`LOOM_MCP_TOKEN=<synthetic sentinel>` set on claude's own env, no explicit `env` field —
  the exact shape of a pre-card playwright/markitdown/no-secret-capability mount): probe sees
  `loomMcpTokenKeyPresent: true`, `loomMcpTokenMatchesSentinel: true`. **Confirms the premise: a stdio MCP
  child inherits the real token on win32 today, unmitigated.**
- **MERGE, not REPLACE, proven both directions:**
  - Mount's `env` = `{"LOOM_MCP_TOKEN": ""}` (claude's own env still carries the real sentinel): the child's
    env still contains every OTHER inherited parent var (full key list, same as the no-`env`-field case),
    but `LOOM_MCP_TOKEN` itself resolves to `""` (`loomMcpTokenIsEmptyString: true`,
    `loomMcpTokenMatchesSentinel: false`) — **an explicit per-key override wins.**
  - Mount's `env` = `{"SOME_OTHER_CAPABILITY_VAR": "marker-value"}` (no mention of `LOOM_MCP_TOKEN` at
    all): the child STILL gets `loomMcpTokenMatchesSentinel: true` — the real value leaks straight through
    alongside the unrelated var. **This is the decisive control: an explicit `env` block that doesn't name
    the token does NOT protect against it — today's real capability-secret mounts (which set
    `env[row.secretEnvVar] = secret` and nothing else) already leaked the token this way, in addition to
    the capability secret itself.**

Per-mount census at investigation time (unchanged by this card's build, restated here since it's the
rationale for "unconditional, no exceptions"): `loom-tasks`/`loom-orchestration`/`loom-platform`/
`loom-audit`/`loom-user-audit`/`loom-setup`/`loom-operator`/`loom-run` are the ONLY mounts that need the
token (http, `Authorization` header) and `codescape` is http with its own unrelated auth. EVERY stdio mount
— `playwright`, `markitdown`, and every `resolveCapabilityServer` result (node-package / python-venv /
bundled / command / github-binary) — has no legitimate use for it; none call back into Loom's MCP surface
(grepped `capabilities/registry.ts` for any Loom URL/port reference — zero hits).

**Codex / POSIX, re-confirmed by code inspection (no new spawns needed):** only two assignment sites for
`MCP_TOKEN_ENV_VAR` exist in `packages/daemon/src` — `host.ts`'s `applyMcpTokenEnv` (gated on
`mcpTokenRidesEnv()`, win32-only for claude) and `createCodexPty` (unconditional, both platforms, for
codex's OWN `bearer_token_env_var` http mounts). POSIX claude never puts the token on its own env at all
(and `buildSpawnEnv` scrubs any inherited stray value), so there is nothing for a POSIX-claude stdio child
to inherit via this mechanism. Codex sets it unconditionally but **never mounts stdio servers at all** —
`@decision 7fa73e2c` (`codex-compat.ts`): "browserTesting/documentConversion/capabilities all resolve to
stdio MCP; codex mounts only http," and all three fall a session back to the claude harness instead. So
codex has no path where this token reaches a third-party child via stdio inheritance (its only residual is
the separately-tracked whole-process POSIX env-read, `docs/decisions/2e7373ab-codex-mcp-token-posix-env-residual.md`
— a different exposure class, unaffected by this card).

## The decision: build option (a), unconditionally, at ONE chokepoint

`buildMcpServers` (`host.ts`), at the very end, loops over every entry it has already built and, for every
mount that is **not** `type: "http"` (`blanksMcpToken`, Code Review round 2 — keyed on NOT-http rather than
on the `"stdio"` literal, since claude treats a TYPE-LESS `{command,args}` entry as stdio too), merges
`{[MCP_TOKEN_ENV_VAR]: ""}` onto whatever `env` it already carries (creating one if the mount had none).
This reuses the MERGE semantics proven above: the blank wins over whatever claude would otherwise merge in
from its own inherited env, while every OTHER key the mount set for its own reasons (a capability secret,
an `outputDirEnvVar` scratch path) is left completely alone.

**ONE chokepoint, not per-producer:** `playwrightMcpServer`, `markitdownMcpServer`, and
`resolveCapabilityServer` are all left untouched — they still omit `env` entirely when they have nothing of
their own to put there. The blank is applied AFTER all of them return, over the whole assembled map, so a
future stdio mount added anywhere above in `buildMcpServers` inherits the blank automatically and can't
forget it by omission.

**Why unconditional on BOTH platforms, never gated on `mcpTokenRidesEnv()`/`ridesEnv`:** on POSIX,
`LOOM_MCP_TOKEN` is never present on claude's own env in the first place (see above), so forcing it to `""`
there is an inert no-op — there is nothing to protect against, but also nothing it could break. Skipping a
platform conditional here removes one more call site that could regress by "forgetting the gate" — the
exact footgun class `a50b8afd`'s own `applyMcpTokenEnv` extraction (Code Review round 3) was built to stop
for a DIFFERENT call site; this card deliberately has no equivalent conditional to forget in the first
place.

**Why the blank is harmless to existing secret-handling code:** `collectMcpEnvSecrets`'s sweep is
`if (v) out.push(v)` — a falsy empty string is never collected. So the blank never registers as a "secret"
for `mcpConfigHasSecret` (file-vs-inline mode) or `redactSecrets` purposes; it rides as an ordinary,
inert env entry. (Real spawns already force file mode via `!!mcpToken` regardless, so this was never
load-bearing for that decision anyway — see `a50b8afd`'s own note on that.)

## What this closes, and what it does NOT

This removes the **passive-inheritance** path — a third-party stdio binary no longer receives the token
merely because claude happened to pass its own env down. It does **not** close same-user **extraction**:
on win32, a hostile stdio binary can still deliberately `OpenProcess`+`ReadProcessMemory` claude's own PEB
to read `LOOM_MCP_TOKEN` straight out of its env block — the exact residual `a50b8afd`'s own "Residual
ceiling" section already names for a cross-process reader. This card narrows WHO receives the value
passively; it does not raise the bar against a binary that goes looking for it.

## The hooks (claude-settings.ts command hooks) are a SEPARATE, EXPLICITLY-NOT-FIXED exposure

claude's `--settings` hook commands (`hook-relay.mjs`, and the decision-records/vault-lint/comment-anchor-lint
hook scripts, all wired in `claude-settings.ts` as `{type:"command", command: ...}`) are spawned by claude
the SAME way — as a child with no explicit `env` override — so they structurally inherit `LOOM_MCP_TOKEN`
on win32 too, by the identical mechanism this card fixes for MCP stdio mounts. **This card deliberately does
NOT touch them.** Unlike a stdio MCP mount, every one of these hook scripts is Loom-owned, not third-party,
and already sits within `a50b8afd`'s accepted "session's own token, already available to that session via
its own sanctioned channels" posture (none of them need the token themselves — `hook-relay.mjs` carries its
own separate hook token, not the MCP one — but their inheriting it is the same accepted class as the
agent's own Bash inheriting it, not the third-party-binary class this card is about). Left as a named,
explicit non-fix rather than silently out of scope.

## Do not

- Do not emit a stdio mount anywhere in `buildMcpServers` without the `LOOM_MCP_TOKEN` blank reaching it —
  the blank is applied in ONE final pass over the whole assembled map specifically so a new mount added
  above inherits it automatically; do not special-case a new mount's own producer to skip that pass.
- Do not gate the blank on `mcpTokenRidesEnv()`/`ridesEnv`/platform — it is unconditional on both platforms
  by design (see "why unconditional" above); a platform conditional here would only reintroduce a call site
  that could regress by being forgotten, for zero behavioral benefit (the blank is already an inert no-op
  on POSIX).
- Do not read an explicit `env` block on a stdio mount as sufficient protection on its own — MERGE
  semantics mean a mount's `env` block that sets OTHER keys (a capability secret, an `outputDirEnvVar`) but
  never mentions `LOOM_MCP_TOKEN` still leaks the real value through unless the blank is explicitly present
  (live-verified above). This is why the fix is a dedicated final pass, not "remember to add the blank
  wherever a mount sets its own `env`."
- Do not treat this card as closing the hooks exposure (`hook-relay.mjs` and friends) — see the dedicated
  section above; that is a separate, Loom-owned, already-accepted exposure class, explicitly not fixed
  here.
- Do not re-litigate `2be634f2`'s own rejection (generalizing the mcpToken *placeholder* pattern to
  capability secrets) as if this card reopens it — this card never puts a capability secret on claude's own
  env; it only blanks the UNRELATED `LOOM_MCP_TOKEN` key on the stdio mount's own env block, which is a
  completely different mechanism from the placeholder-plus-env pattern `2be634f2` rejected.
- Do not key the blanking predicate on `type === "stdio"` — claude treats a TYPE-LESS `{command,args}`
  mcp-config entry as stdio too, so that literal check lets a future type-less producer silently skip the
  blank. Key on NOT being an http mount (`blanksMcpToken`, `host.ts`), and never inline that check at the
  `buildMcpServers` call site again.
- Do not read this as closing third-party-child access to the token: on win32 a hostile stdio binary can
  still PEB-read claude's own env (the `a50b8afd` residual) — this card removes passive inheritance, not
  same-user extraction.

## Tests

`packages/daemon/test/mcp-config-secret-lifecycle.mjs` (PART 1, the pure `buildMcpServers` block): asserts,
on BOTH forced platforms, that playwright / a capability with a secret / a capability with an
`outputDirEnvVar` / a capability with neither all carry the blank while keeping their own env keys intact,
that http mounts never get an `env` field at all, that the raw producers (`playwrightMcpServer`) never set
it themselves (chokepoint-only), and that `collectMcpEnvSecrets` never collects the blank. RED-proven:
reverting `host.ts` to its pre-card state (`git show HEAD:...`) reproduces exactly 8 failures on this block,
restoring the fix returns to green. `browser-testing-spawn.mjs`, `document-conversion-spawn.mjs`, and
`capability-registry.mjs` each got their pre-existing byte-identity/no-env assertions updated to account for
the blank (an `env` object is no longer `undefined` for a secret-free stdio mount; a chokepoint-vs-producer
comparison now accounts for the one added key) rather than asserting the old, now-superseded shape.

**Code Review round 2 (the `type === "stdio"` keying gap):** `blanksMcpToken` is directly asserted against
`{command,args}` with no `type` field at all (`true`), `{type:"stdio"}` (`true`), and `{type:"http"}`
(`false`) — no current producer emits a type-less entry, so the predicate is tested directly rather than
coaxed out of `buildMcpServers` end-to-end (the same reasoning `applyMcpTokenEnv` is tested directly,
above). RED-proven against the first build's tip (commit `4a27c81a`, keyed on `type === "stdio"` with no
`blanksMcpToken` export at all): re-running the suite against that commit throws `blanksMcpToken is not a
function` at the new assertions — restoring the fix returns to green, 104/104.
