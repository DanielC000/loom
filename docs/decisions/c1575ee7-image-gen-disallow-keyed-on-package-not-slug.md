# c1575ee7 — the image-gen `generate_video` disallow union is keyed on the resolved npm package, never on a mount slug

## The finding

Follow-up from the `b7d6b7f3` Code Review (taskless reviewer `22cd6466`, snapshot `79efc7b3`). `b7d6b7f3`
added `IMAGE_GEN_DISALLOWED_TOOLS`'s union into `--disallowedTools`, gated at the `createPty` call site
(`pty/host.ts`) on `!!mcpServers["image-gen"]` — the literal `mcpServers` map key Loom's own seeded
"image-gen" row happens to mount under (`mcpServers[def.slug] = server`, where `def.slug` is that row's
own, Loom-reserved slug).

That key is correct for Loom's own seeded row (its slug is fixed and reserved — see `RESERVED_CAPABILITY_SLUGS`,
decision `42e9caf9`), but it is NOT a structural property of "this spawn will run `mcp-imagenate`" — it is
a structural property of "a row happens to be mounted under the exact string `\"image-gen\"`". An
owner-added catalog row, created under ANY other (non-reserved) slug, whose own `provision` happens to
resolve the SAME dangerous npm package (`mcp-imagenate`), would mount at a DIFFERENT `mcpServers` key, so
`!!mcpServers["image-gen"]` stays `false` for that spawn even though that row's OWN `generate_video` tool
(under ITS OWN tool-name prefix) is live and reachable. A Loom-driven role would then hang on the
unanswerable permission prompt; on manager/platform a human could approve the spend without realizing the
video-generation surface was opened.

## The fix

`capabilityGrantsMountKeysForPackage(grants, catalog, pkg)` (`pty/host.ts`) scans every GRANTED
capability's own resolved catalog row (the same `catalog.find((c) => c.slug === grant.slug)` lookup
`capabilityToolAllowlist` already does) and returns the mount key (`grant.slug`, identical to the
`mcpServers` key that row resolves to) of every row whose `provision.package === pkg` — parsed from that
row's own `provisionJson` — instead of checking one literal `mcpServers` key. The `createPty` call site
now computes `imageGenMountKeys` via `capabilityGrantsMountKeysForPackage(resolveProfileCapabilities(opts),
capabilityCatalog, "mcp-imagenate")` and passes that ARRAY into `disallowedToolsForSpawn`.

`disallowedToolsForSpawn`'s own `imageGenMounted` parameter now accepts EITHER its original `boolean`
shape (preserved for every existing caller — `true` is treated as exactly the single legacy key
`"image-gen"`, byte-identical to before) OR a `readonly string[]` of mount keys: for each key, it unions
`mcp__<key>__generate_video` into `--disallowedTools`, not just the one fixed
`"mcp__image-gen__generate_video"` string. So an owner-added row resolving `mcp-imagenate` under slug
`"my-video-thing"` gets ITS OWN `mcp__my-video-thing__generate_video` disallowed too — the real tool name
that row actually exposes — not a disallow entry for a tool name that row never advertises.

**The `createPty` call site UNIONS `imageGenPackageKeys` with the literal `"image-gen"` slug fallback,
de-duplicated — it never uses the package-match leg alone.** The call site is:

```ts
const imageGenPackageKeys = capabilityGrantsMountKeysForPackage(resolveProfileCapabilities(opts), capabilityCatalog, "mcp-imagenate");
const imageGenMountKeys = mcpServers["image-gen"] && !imageGenPackageKeys.includes("image-gen")
  ? [...imageGenPackageKeys, "image-gen"]
  : imageGenPackageKeys;
```

The slug leg stays load-bearing because `capabilityGrantsMountKeysForPackage` is a pure read over each
GRANTED row's own `provisionJson` — a seeded/re-created "image-gen" row whose provision carries NO
`package` field at all (a `bundled`/`command` row — the two kinds `validateCapabilityDefInput` actually
lets an owner author under that slug, e.g. a re-created row running `npx -y mcp-imagenate@0.9.0`, or a
customized legacy row the npm-pinned migration skipped) resolves zero package matches, so without the
slug fallback that row's `generate_video` goes entirely undisallowed — reopening the exact `b7d6b7f3` gap
for the ONE row shape an owner is most likely to actually hit (see "Code Review fix round" below).

Playwright's own `!!mcpServers.playwright` check at the same call site does NOT need this treatment:
unlike `def.slug`, the literal string `"playwright"` is ITSELF a Loom-reserved capability slug
(`RESERVED_CAPABILITY_SLUGS`, decision `42e9caf9`) — `validateCapabilityDefInput` refuses to create an
owner-added row under that exact slug, and `buildMcpServers`'s own defense-in-depth check (card `a6598c1e`)
refuses to mount one even if it somehow reached this far. So no owner-added catalog row can ever occupy
the `mcpServers.playwright` key — the check is already keyed on something non-owner-collidable, with no
package scan needed. (A `node-package` row pointed at the SAME `@playwright/mcp` npm package under a
DIFFERENT slug is a separate, narrower residual — see "Do not" below; it is out of this card's scope,
which asked only for a seam-capture TEST of the existing, already-correctly-keyed Playwright call site,
not a code change.)

## Code Review fix round

The first cut of this card's own fix (and its own test) had two defects, both found by Code Review:

1. **BLOCKING — a real coverage regression.** The first cut REPLACED the slug-keyed check with the
   package-keyed one instead of UNIONING them: `imageGenMountKeys` was set to
   `capabilityGrantsMountKeysForPackage(...)` alone, with no `mcpServers["image-gen"]` fallback. A row
   mounted under the literal slug `"image-gen"` whose own `provisionJson` carries no `package` field (a
   `bundled`/`command` row — the only two kinds `validateCapabilityDefInput` lets an owner actually author
   under that slug, since `"image-gen"` is reserved; see decision `42e9caf9`) then got NO `generate_video`
   disallow at all — before this card, `!!mcpServers["image-gen"]` alone caught it. The owner can reach
   this state: the seeded row is deletable (`gateway/server.ts`'s capability-delete route) and a
   re-created `bundled`/`command` row running e.g. `npx -y mcp-imagenate@0.9.0` carries no `package` field
   by construction; a customized legacy row the npm-pinned migration skipped also qualifies. Fixed by
   unioning the package-matched keys with `"image-gen"` whenever that literal key is actually mounted
   (de-duplicated) — see the call site quoted in "The fix" above.
   The fixture that hid this: the first cut's `igRowFixture` (cases 1-3 of
   `image-gen-disallow-createpty-chokepoint.mjs`) added a `package: "mcp-imagenate"` field on top of its
   pre-existing no-package `kind:"bundled"` shape — a shape no real "image-gen" row (seeded or
   owner-re-created) can ever actually carry — which made the package-match leg alone sufficient to pass
   every case, masking the dropped slug leg. The fixture is restored to its original no-package shape.
2. **Case (4) modeled an impossible row.** The first cut's `ownerVideoRowFixture` used `kind:"bundled"`
   with a `package` field in its `provisionJson` — owners can never author this: `validateCapabilityDefInput`'s
   "bundled" branch (`capabilities/registry.ts`) only reads/stores `command`/`args`/`outputDirEnvVar`, never
   `package`. Rebuilt as a `kind:"node-package"` row instead — the one owner-authorable kind whose
   provision actually declares a resolvable `package`.
3. **The package match must also fire on an ABSOLUTE path, not just the bare specifier.** A `node-package`
   row's `package` field is free-form owner text; `resolveNodePackage`'s `require.resolve(`${package}/package.json`)`
   accepts an absolute filesystem path exactly as readily as a bare npm specifier — e.g. an owner who
   manually installed `mcp-imagenate` somewhere under their own `LOOM_HOME` rather than relying on bare-
   specifier `node_modules` resolution, pointing `package` at something like
   `"<LOOM_HOME>/node/node_modules/mcp-imagenate"`. The original exact-string check
   (`provision.package === pkg`) missed this (confirmed empirically: it returned `[]` for exactly this
   shape). `capabilityGrantsMountKeysForPackage` now also matches when `package` is an absolute path whose
   own `path.basename(...)` equals `pkg`.
   **Named residuals — not closed by this fix, and not structurally detectable the same way:** a forked/
   renamed copy of the package (a different name on npm, or a locally-patched copy under a different
   directory name) resolves a `package`/basename that is neither `"mcp-imagenate"` nor matches by string
   at all — nothing here can key on package IDENTITY once the name itself changes. An `npm:` alias
   specifier (e.g. `package: "my-video-lib@npm:mcp-imagenate@0.9.0"`, a real pnpm/npm alias syntax) is also
   unmatched — the alias text itself doesn't equal `"mcp-imagenate"` and isn't an absolute path either, so
   neither leg of the check fires even though the installed code is byte-identical to the real package.

## Do not

- Do not drop the slug-fallback leg of the `imageGenMountKeys` union at the `createPty` call site — i.e.
  do not set `imageGenMountKeys` to `capabilityGrantsMountKeysForPackage(...)` alone, with no
  `mcpServers["image-gen"]` fallback. That is EXACTLY the Code Review regression this card's own fix round
  found: it drops coverage for a seeded/re-created "image-gen" row with no `package` field, the row shape
  an owner is most likely to actually hit. Never revert to the ORIGINAL slug-only check either
  (`!!mcpServers["image-gen"]` alone, with no package-match leg) — that was the bug this card opened with.
  Both legs are load-bearing; the union is the fix.
- Do not assume this closes every possible owner-authored dodge. A `bundled`/`command` row mounted under
  some OTHER (non-`"image-gen"`) slug can run `mcp-imagenate` via an arbitrary wrapper (e.g.
  `npx -y mcp-imagenate@0.9.0`) whose `provisionJson` carries no `package` field at all —
  `capabilityGrantsMountKeysForPackage` cannot detect that shape (there is nothing structural to key on;
  the owner-typed command string is free-form), and the slug fallback only ever covers the literal
  `"image-gen"` key, not an arbitrary other slug. This fix closes the STRUCTURALLY DETECTABLE cases (the
  literal reserved slug, OR a `package` field matching `mcp-imagenate` by exact specifier or by absolute-
  path basename — what a `node-package`/`npm-pinned` row would carry), not every conceivable disguise. See
  "Code Review fix round" above for the forked-package/renamed-package/`npm:`-alias residuals specifically.
- Do not widen `capabilityGrantsMountKeysForPackage` to resolve/spawn anything — it is a pure read over
  already-injected `grants`/`catalog` data, mirroring `capabilityToolAllowlist`'s own shape. Keep it that
  way so it stays safely callable from the `createPty` hot path with no I/O.
- Do not assume `disallowedToolsForSpawn`'s `imageGenMounted` param's boolean shape is deprecated — every
  pre-existing test (`image-gen-capability.mjs`, and any future direct caller) still passes a plain
  boolean and gets byte-identical behavior (`true` ⇒ exactly `["mcp__image-gen__generate_video"]`). The
  array shape is additive, not a replacement; don't "clean up" the boolean branch away.
- Do not widen this same (array-of-mount-keys) treatment to Playwright's `playwrightMounted` param without
  a fresh decision — that would require first closing the SEPARATE `@playwright/mcp`-under-a-different-slug
  residual named above, which this card deliberately left open (out of scope; `"playwright"` itself stays
  non-owner-collidable either way).

## Verification

`image-gen-disallow-createpty-chokepoint.mjs` (fixed in the Code Review round): `igRowFixture` (cases
1-3) is restored to its ORIGINAL no-`package` shape, so a granted-worker (1) and granted-manager (3) spawn
now exercise the SLUG-FALLBACK leg specifically — RED-proved: temporarily reverting the call site to the
package-match leg alone reddens exactly cases 1 and 3 (both grant the no-package "image-gen" row), while
case 2 (ungranted) and case 4 (a different slug entirely) are untouched. `ownerVideoRowFixture` (case 4)
is rebuilt as a `kind:"node-package"` row — the one owner-authorable kind that actually carries a
`package` field — pointed at a REAL on-disk fixture package directory via an ABSOLUTE path ending in
`.../node_modules/mcp-imagenate`, so `resolveNodePackage`'s own `require.resolve` genuinely mounts it (no
stand-in), proving both that the row is realistically owner-authorable AND the absolute-path basename
match: RED-proved by temporarily reverting `capabilityGrantsMountKeysForPackage` to the exact-string
match alone, which reddens exactly case 4 and leaves cases 1/2/3 untouched. `image-gen-capability.mjs`
gained a dedicated pure-function section (`(mount-keys)`) exercising `capabilityGrantsMountKeysForPackage`
directly, platform-independently, with no real spawn: exact bare-specifier match, absolute-path basename
match, a different package (no match, both specifier shapes), malformed `provisionJson` (never throws),
and an unresolvable grant (skipped, never throws).
