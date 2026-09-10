# 529b6f41 — `entityRowFields.ts`'s field-list sentinel is `Record<keyof T, 1>`, and `1` is deliberate, not `true`

## Narrative

### Compile-time totality over a hand-typed literal

`packages/daemon/src/mcp/entityRowFields.ts` writes each of `Project`/`Agent`/`Profile`'s field list ONCE, as a `Record<keyof T, 1>` sentinel (`PROJECT_FIELDS` etc.), rather than a hand-typed `const x: T = {...}` object literal. `keyof T` includes OPTIONAL keys too, unlike a hand-typed literal, which TypeScript only forces to name REQUIRED fields — an added `newThing?: X` on `T` compiles fine against a literal that never mentions it, so that shape alone would silently DROP a future optional field from the projection. This was caught the hard way on `Profile`, which is 7-of-15 fields optional (see git history for the version of this file that had that gap, and the guard's own history for how it was proven). A field added to `Project`/`Agent`/`Profile` in `@loom/shared` — required OR optional — now breaks the build at the matching sentinel until it's a deliberate, reviewed addition. ONE list per type, not two: the sentinel's own keys ARE the field list the runtime projection iterates, so there is nothing to keep in sync by hand.

### The sentinel value is the number `1`, never a boolean

⚠️ The sentinel value is the number `1`, not the boolean literal `true` — deliberately, and this section deliberately never spells out the colon-then-boolean sequence it's warning about, since `test/agent-runs-keys.mjs` (G3) textually scans every compiled `dist/mcp/*.js` file's raw source (comments included — it has no idea what a comment is) for that exact sequence on the `endpoint` field (an Agent Runs trust-boundary guard: no MCP path may flip an agent's `endpoint` field or mint an API key, only the loopback REST surface may). This sentinel's `endpoint` entry used to hold that boolean literal, and TypeScript compiles a `Record` object literal's key/value pairs straight into the `.js` output as literal text — so the sentinel's own meaning ("this field is projected") collided, purely textually, with the guard's real question ("does any MCP path SET that field to that value"). The guard is right to be this blunt (a false positive here is far cheaper than a false negative on a real trust-boundary leak) — so the fix is on this side: a numeric marker carries the exact same compile-time exhaustiveness guarantee (still `Record<keyof T, ...>`, still forces every key) without colliding with G3's pattern.

Both decisions share one introducing commit (`529b6f41`) and one subject — the shape of this file's field-list sentinel — so they're recorded together rather than as two files.

## Do not

- Do not replace a `Record<keyof T, 1>` sentinel with a hand-typed `const x: T = {...}` object literal — it compiles fine while silently dropping a future OPTIONAL field from the projection.
- Do not "tidy" the sentinel value back to a boolean (`true`) to match a different style — that silently re-breaks `test/agent-runs-keys.mjs` (G3)'s `endpoint`-flip guard on the next merge, and won't even show up locally unless you happen to run G3.

## Source

Inline comment in `packages/daemon/src/mcp/entityRowFields.ts` (file header), as of commit `24f7f64fb468a77258c85d2fc97961ca98abd5e2`. Introduced by commit `529b6f416d2930252bdc233ab791a92fc0eab836` (no board card cited anywhere in the block, the file, or the introducing commit message — sha-keyed per the extraction program's rule; verify with `git cat-file -t 529b6f41`). Relocated by card `13455de9` (tranche 1).
