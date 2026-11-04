# b7d6b7f3 — mcp-imagenate's bump to 0.9.0 silently opens a video-generation spend surface; closed structurally, not by allowlist alone

## The finding

Card `b7d6b7f3` bumped `MCP_IMAGENATE_VERSION` (`capabilities/seed.ts`) from `0.2.1` to `0.9.0` to clear
two HIGH `zod` audit findings (GHSA-mrhx-c7xc-m3w5) in the committed lock — see
`docs/decisions/66ab2bc0-npm-pinned-lockfile-pin.md`'s "Accepted audit findings (2026-11-04)" section for
the full audit triage. The first version of this change reported `generate_video` and the new Reve
provider as "inert" the same way the pre-existing OpenAI/BFL providers are. That claim was wrong for
`generate_video` — caught by the project lead reading the real 0.9.0 source, not by any test.

**Quoted gating lines, from the real `mcp-imagenate@0.9.0` npm tarball:**

`dist/providers/registry.js` (the IMAGE registry — `generate_image`'s own model list):
```
const google = env.NANO_BANANA_API_KEY || env.GEMINI_API_KEY;
const openai = env.GPT_IMAGE_API_KEY || env.OPENAI_API_KEY;
const flux = env.BFL_API_KEY;
const reve = env.REVE_API_KEY || env.REVE_API_TOKEN;
...
if (keys.google) register(createGoogleProvider(keys.google));
if (keys.openai) register(createOpenAIProvider(keys.openai));
if (keys.flux) register(createFluxProvider(keys.flux));
if (keys.reve) register(createReveProvider(keys.reve));
```
`dist/providers/video-registry.js` (the VIDEO registry — a SEPARATE registry, built from the SAME `keys`):
```
if (keys.google) register(createOmniVideoProvider(keys.google));
```
`dist/index.js` (tool registration):
```
const videoRegistry = createVideoRegistry(keys);
...
if (videoRegistry.models.length > 0) { ... server.registerTool("generate_video", { ... }) ... }
```

Loom's `image-gen` row sets ONLY `GEMINI_API_KEY` (decision `a4058e7a` — deliberately never
`OPENAI_API_KEY`/`GPT_IMAGE_API_KEY`/`BFL_API_KEY`, and now never `REVE_API_KEY`/`REVE_API_TOKEN` either).
`keys.google` is populated from exactly that variable. So on every real `image-gen` grant:
`openai`/`flux`/`reve` stay falsy (OpenAI/BFL/Reve genuinely never register — the original "inert" claim
is CORRECT for these three) — but `keys.google` is ALWAYS truthy, so `videoRegistry.models.length > 0` is
ALWAYS true, and `generate_video` is ALWAYS registered and callable. It generates video on the owner's own
Gemini key — a materially different, costlier spend surface than image generation — that nobody opted
into merely by granting `image-gen`. No other new env var exists anywhere in the 0.9.0 tarball (verified
by diffing every `process.env.`/`env.` read in the whole `dist/` tree against 0.2.1's) — `generate_video`
is the one and only newly-live TOOL surface the bump opened. (A newly-live MODEL under an already-allowed
tool is a narrower, separate case — see "A newly-live model, not a newly-live tool" below.)

### A newly-live model, not a newly-live tool

0.9.0's Google provider (`providers/google.js` ~:82 in the real tarball) also registers a new model name
under the SAME `generate_image` tool: `"nano-banana-2.1": "gemini-nano-banana-2.1"`, alongside the
pre-existing `nano-banana-2`/`nano-banana-pro` entries. The DEFAULT stays `nano-banana-2` —
`registry.js`'s `DEFAULT_MODEL_PREFERENCE` names only `"gpt-image-2.5-flare"`, which never registers
without an OpenAI key Loom never sets, so `createRegistry` falls back to `models[0]` (Google's own
first-registered entry, unchanged from 0.2.1). This is a new selectable VALUE inside an
already-allowed tool's own input schema, not a new tool name — `toolAllowlistJson`/
`IMAGE_GEN_DISALLOWED_TOOLS` have no lever over which model an already-allowed tool call names, so there
is nothing to narrow or disallow here. Named for completeness (re-quoting every provider's gating line on
a bump, per "Do not" below, should surface this kind of addition too), not as a gap.

### Ambient provider keys (verified, fix round on this card)

Investigated whether an ambient `OPENAI_API_KEY`/`GPT_IMAGE_API_KEY`/`BFL_API_KEY`/`REVE_API_KEY`/
`REVE_API_TOKEN` sitting in the DAEMON's own process env could reach the `image-gen` MCP child and
silently activate one of the three providers Loom deliberately never sets a key for (decision `a4058e7a`).

Measured: a stdio MCP mount's real inherited env is claude's full process env merged with the mount's own
declared `env` (`pty/env-isolation.ts`'s own doc). But every non-http mount — `image-gen` included,
unconditionally, since card `fafae623`/`8d26596b`, both of which PREDATE this card — is rewritten at
`buildMcpServers`'s own final pass to launch through `assets/env-isolated-launch.mjs` instead of the real
target directly. That launcher rebuilds the real target's child env from a FIXED base allowlist
(`BASE_ALLOWLIST` — no provider-key-shaped name in it) plus ONLY the mount's own declared env keys
(`GEMINI_API_KEY` + the output-dir var) and that row's own `passEnv` (seeded `[]` for `image-gen`). None of
the five ambient provider keys above is in either set, so none of them reaches the real `mcp-imagenate`
process — proven by a real child-process spawn through the real launcher with all five planted ambient
(`test/image-gen-ambient-provider-keys.mjs`). **This is a pre-existing structural protection this card did
not have to add** — the gap named in this card's own triage note was already closed, by an earlier,
unrelated mechanism.

## Why the allowlist alone doesn't close it

Narrowing the seeded `toolAllowlistJson` from the whole-server wildcard `mcp__image-gen` to the single
`mcp__image-gen__generate_image` tool name is necessary but NOT sufficient. An MCP tool the mounted server
advertises (via `tools/list`) but `--allowedTools` doesn't cover is not simply refused — it still triggers
claude's ordinary permission-approval flow, which a Loom-driven role (worker/setup/auditor/
workspace-auditor) can never answer (no human attached, `AskUserQuestion` itself disallowed). This is the
exact hazard `CODESCAPE_WRITE_TOOLS`'s own doc comment (`pty/host.ts`) already names: "a Loom-driven role
can never answer an unexpected permission prompt, so an unclassified ... tool wedges the turn until the
busy-stuck watchdog fires." An un-allowlisted-but-mounted `generate_video` would not be cleanly
unreachable — it would hang the turn.

## The containment

Two changes, both required:
1. `capabilities/seed.ts`: `image-gen`'s seeded `toolAllowlistJson` narrows to
   `["mcp__image-gen__generate_image"]` (was the whole-server wildcard).
2. `pty/host.ts`: a new `IMAGE_GEN_DISALLOWED_TOOLS = ["mcp__image-gen__generate_video"]`, unioned into
   `--disallowedTools` by `disallowedToolsForSpawn` whenever `mcpServers["image-gen"]` is mounted — the
   SAME proven pattern `PLAYWRIGHT_DISALLOWED_TOOLS` already uses for Playwright's RCE-equivalent
   `browser_run_code_unsafe` (also a wildcard-granted, dangerous tool). `--disallowedTools` overrides any
   `--allowedTools` shape, so the tool is structurally removed from the model's tool list, not merely
   un-allowlisted — no permission prompt is ever shown because the tool doesn't exist to the model.

This protects BOTH a fresh install (narrowed allowlist from seed) AND an already-migrated EXISTING
install (whose row may still carry the old wildcard allowlist forever, since
`migrateImageGenNpmPinnedVersionBump` only re-stamps `provisionJson.version`, never `toolAllowlistJson`):
the disallow union is computed at spawn time from whether `image-gen` is MOUNTED, never from the row's
own stored allowlist content, so it applies uniformly regardless of which allowlist shape a given
install's row happens to carry.

## Codex

Codex needs no separate lever here: granting ANY `capabilities` entry (image-gen included) is ALREADY
codex-incompatible (`codex-compat.ts`'s `codexStdioOffenders`, decision `7fa73e2c` — codex mounts only
`{type:"http"}` servers, never a stdio one like `image-gen`). A codex-harness session can never have
`image-gen` mounted at all, so `generate_video` is unreachable there by construction, independent of this
card's fix. (`createCodexPty` also has no `--disallowedTools`-equivalent lever at all, so if this
precondition ever changed, a new fix would be needed from scratch — see `pty/host.ts`'s own doc on that
method for the general codex-parity gap.)

## Do not

- Do not re-widen `image-gen`'s seeded `toolAllowlistJson` back to the bare `mcp__image-gen` wildcard.
  **Correction:** the original rationale here was wrong. With a wildcard, `generate_video` would be
  ALLOWED outright, not merely un-allowlisted-and-prompted — `--disallowedTools` removes it from the
  model's tool list regardless of the allowlist's shape, so widening the allowlist alone would never
  reopen the hang-on-unapproved-prompt hazard for THIS tool. The narrow allowlist's real value is
  default-deny for the NEXT, not-yet-reviewed tool a future `MCP_IMAGENATE_VERSION` bump adds — one the
  disallow union doesn't yet name — not `generate_video` specifically, which the union already covers no
  matter what the allowlist says.
- Do not remove `IMAGE_GEN_DISALLOWED_TOOLS`'s union into `--disallowedTools` — it is the ONLY lever that
  makes `generate_video` structurally unreachable rather than merely un-allowlisted-and-hanging. The
  allowlist narrowing alone is insufficient, verified above.
- Do not assume this stays current on a future `MCP_IMAGENATE_VERSION` bump. Re-quote every provider's
  gating line (`keysFromEnv`/`createRegistry`/`createVideoRegistry` or their then-current equivalents)
  against the NEW version's real tarball before trusting any "stays inert" claim — a provider that's
  inert today can start reusing an already-set key (exactly what happened here: `generate_video` reused
  `GEMINI_API_KEY` instead of needing its own).
- Do not assume `migrateImageGenNpmPinnedVersionBump` (seed.ts) also narrows an existing row's
  `toolAllowlistJson` — it doesn't, and shouldn't: that field is seed-time-only, and an already-migrated
  row's real protection is the disallow union (mount-keyed, not row-keyed), per "The containment" above.
  **The asymmetry this creates:** a pristine EXISTING row (migrated before this card landed, still
  carrying the old whole-server wildcard) keeps that wildcard forever, so a FUTURE
  `MCP_IMAGENATE_VERSION` bump's new tool is auto-ALLOWED on that row the instant it registers, unless
  that new tool is also added to `IMAGE_GEN_DISALLOWED_TOOLS` at the same time. A fresh install's narrow
  seeded allowlist doesn't have this exposure (an un-added new tool is simply absent from a non-wildcard
  allowlist) — but the disallow union is still the only thing making a dangerous tool structurally
  unreachable rather than merely un-allowlisted-and-prompted, for BOTH row shapes. This is exactly why
  Do-not #3's re-quote-on-every-bump is mandatory, not optional: it's the only check standing between a
  future bump and an existing row's auto-allowed new tool.
- Do not trust a claim that a provider/tool "stays inert the same way" as a sibling provider without
  independently re-checking THAT provider's own gating line — the original mistake this record documents
  was exactly this: assuming `generate_video` was inert "by the same mechanism" as OpenAI/BFL/Reve without
  re-reading its own, different, gating condition.
- Do not key the image-gen disallow union on `!!mcpServers["image-gen"]` (the literal mount slug) — card
  `c1575ee7` found this misses an owner-added catalog row, under any OTHER slug, whose own `provision`
  resolves the SAME `mcp-imagenate` package. The `createPty` call site now computes the mount KEYS via
  `capabilityGrantsMountKeysForPackage(resolveProfileCapabilities(opts), capabilityCatalog, "mcp-imagenate")`
  and disallows each key's OWN `mcp__<key>__generate_video` name, keyed on the row's own resolved
  `provision.package` instead of a fixed slug. See
  `docs/decisions/c1575ee7-image-gen-disallow-keyed-on-package-not-slug.md` for the full fix and its
  named residual (a `bundled`/`command` row running `mcp-imagenate` via a free-form wrapper command, with
  no `package` field to key on, is NOT caught by this).

## Verification

Test `image-gen-capability.mjs` (updated): the seeded row's `toolAllowlistJson` equals
`["mcp__image-gen__generate_image"]` exactly (no wildcard, no `generate_video`). New checks in the same
file assert `IMAGE_GEN_DISALLOWED_TOOLS` carries exactly `mcp__image-gen__generate_video`;
`disallowedToolsForSpawn` omits it when `image-gen` is unmounted and includes it when mounted (byte-
identical-off invariant preserved); and an end-to-end `buildSpawnArgs` call with the real fixture-mounted
`image-gen` server shows `mcp__image-gen__generate_video` actually landing in the `--disallowedTools`
argv, never in `--allowedTools`.

Fix round on this card added two more tests. `test/image-gen-disallow-createpty-chokepoint.mjs` drives the
REAL (unsubclassed) `createPty()` call site end to end against a fixture claude substitute, for a granted
worker spawn, an ungranted worker spawn, and a granted manager spawn — proven to catch a call-site mutant
(a literal `false` in place of `!!mcpServers["image-gen"]`, API unchanged) that `image-gen-capability.mjs`
and `proxy-env-isolation.mjs` both provably do not catch. `test/image-gen-ambient-provider-keys.mjs`
proves the ambient-key finding above: five planted ambient provider keys never reach the real
`mcp-imagenate` child through the real `env-isolated-launch.mjs`, while the real `GEMINI_API_KEY` secret
does.
