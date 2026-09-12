# abaaf16e — `DIST_TEXT_SCANNER_REPO_PATHS` was derived by hand, and no naive grep reproduces it

## Narrative

`computeEmitCompareGate` proves a changed compiled `.ts` file's COMPILED BEHAVIOR is unchanged by transpiling with `removeComments:true` forced (@decision `2154b6ad`), and on a match skips the ~668-test runtime suite. That proof is sound for ordinary runtime behavior — but some runtime tests never exercise compiled behavior at all: they `fs.readFileSync` real `dist/**` output and pattern-match its TEXT, and tsc keeps comments in the emit (no `removeComments` in this repo's tsconfig chain — only the proof-comparison above forces it). For such a test, a comment-only diff that adds or removes matching text can flip its verdict even though the transpile-comparison proved the diff behaviorally inert. `agent-runs-keys.mjs`'s "G3" check (a structural proof no compiled MCP router can mint/rotate API keys or flip `endpoint`) is the specimen: its own comment documents a boolean sentinel VALUE once collided with its pattern and re-broke it — not hypothetical, though the entityRowFields extraction that motivated card `abaaf16e` didn't trip it (G3 ran directly and passed).

## The sweep, and why a single grep can't replace it

Card `abaaf16e`'s own naive starting point — `grep -l "readFileSync(.*dist" packages/daemon/test/*.mjs` —
MISSES G3 entirely: `agent-runs-keys.mjs` builds its `mcpDir` path on one line and calls
`fs.readFileSync(path.join(mcpDir, f), "utf8")` on a later one, so `readFileSync(` and the literal `dist`
never share a line. A broader sweep (`readFileSync|readdirSync` plus a `dist` hit anywhere in the file)
over-shoots into ~180 files, almost all ordinary `await import("../dist/...")` loading — irrelevant, since
importing EXECUTES code and comments never reach the parser, unlike a text scan. The actual result — 10
files, refuting the kickoff's own hypothesis that G3 was the only member — came from reading every
candidate by hand against the membership criterion below.

## Membership criterion

A test belongs on `DIST_TEXT_SCANNER_REPO_PATHS` only if it does a RAW, UNSTRIPPED whole-file (or
large-region) text scan of real, compiled `dist/**` output, where a comment anywhere in it can change
what the scan matches — a judgement call, not grep-derivable, per the sweep above.

## The three excluded shapes

Three shapes also read compiled `dist/**` text but are comment-immune by construction, NOT on this list:

1. **Bounded, named-declaration extraction of DATA** — `task-deferred-items-migration.mjs`,
   `task-deferred-until-event-migration.mjs`, `task-manual-deferral-migration.mjs` each extract only the
   `` const SCHEMA = `...`; `` template-literal BODY via a bounded regex. A template literal's content is
   never comment syntax, so `removeComments` can't touch it regardless of any comment elsewhere.
2. **TS-compiler AST-narrowed function/method-body extraction** — `codescape-spawn-repopath-guard.mjs`,
   `loopback-write-guard.mjs` (§G), `task-version-guard.mjs` (§5), `project-memory-version-guard.mjs`. The
   anchor is a real DECLARED NAME found via the TypeScript compiler's own parser; the text check runs only
   against that extracted region. `loopback-write-guard.mjs`'s own comment documents it was once burned by
   comment-anchoring (a relocated heading comment zeroed its anchor) and was deliberately re-anchored on a
   real code token — precedent for this hardened shape. Residual risk is only an interior comment inside
   that function/method matching the check's pattern — several orders narrower than a whole-file scan,
   and out of scope here.
3. **Explicit comment-stripped whole-file scan** — `codescape-supervisor-shutdown-wiring.mjs` calls its own
   local `stripComments()` (with a sanity check that the stripper strips) before every assertion, sharing
   that discipline with `exit-code-verdict-guard.mjs` / `harness-adapter-claude-literal-guard.mjs` — both
   unconditional members of `STATIC_GUARD_REPO_PATHS`. Already immune by construction.
4. **Presence-only assertion of a real code token** — `loopback-secret.mjs` (D) reads compiled
   `dist/gateway/loopback-secret.js` and asserts `/timingSafeEqual\(/.test(src)`: the call site DOES
   exist. `computeEmitCompareGate`'s transpile-comparison guarantees a comment-only diff leaves every real
   code token unchanged, so a genuine `timingSafeEqual(` call already present stays present, byte-for-byte,
   regardless of any comment. A comment could only ADD a spurious occurrence, which for a PRESENCE check
   can only flip a fail toward a pass it doesn't need — never a pass to a fail. Mirror of shapes 1-3: those
   are immune by WHERE they look (data, a narrow region, stripped text); this one is immune by the
   POLARITY of what it asserts. Judgment call, not closed — a future dist-text reader shaped differently
   needs its own reasoning, not a fifth bullet by pattern-matching.

## Option (b) — complementary hardening, not a substitute (card `36afbbdd`)

Teaching the raw scanners above to strip comments the way shape (3) already does was considered as an
alternative to this list. All ten guard CODE SHAPE, not documentation — a comment that trips one is a
false positive on the check's own terms, so stripping comments first would make each scanner test more
precisely what it means to test, worth doing on its own merits. It does NOT substitute for this fix:
`buildReducedGateCommand` folding this list in is what gets a comment-only diff introducing matching text
CAUGHT AT THE REDUCED GATE, blaming the commit that introduced it, rather than surfacing later as a
confusing failure on an unrelated full gate — the actual defect this card closes (blame-routing, not
false-positive avoidance). Comment-stripping removes the false-positive risk but doesn't fix WHERE a real
hit gets reported. Carded as complementary hardening: `36afbbdd`.

## Required object, not positional defaults (Code Review MINOR)

Code Review flagged (MINOR): `buildReducedGateCommand`'s params were positional with defaults, letting a
caller silently drop one — its probe confirmed this: mutating the two admission-reclassification/batch
call sites to omit the 3rd argument tripped ZERO tests. The same latent shape already existed on
`changedAssetPaths`, so both were fixed together. The signature is now one REQUIRED object typed
`Pick<EmitCompareGateResult, "changedTestFiles" | "changedAssetPaths" | "changedTsPaths" |
"changedScriptFiles">` (not hand-typed), so a field renamed on `EmitCompareGateResult` fails this call
SITE, not silently.

## Do not

- Do not accept positional/defaulted arguments for `buildReducedGateCommand` — a default lets a caller
  silently drop one undetected (verified: omitting the 3rd argument at both call sites tripped zero
  tests). Use one required object instead.
- Do not re-derive `DIST_TEXT_SCANNER_REPO_PATHS` from a single grep for `readFileSync(.*dist` or any
  other literal — it misses G3 (its `dist` segment sits on an earlier line than `readFileSync(`) and a
  broader sweep over-shoots into module-loading imports irrelevant to this list.
- Do not add a test whose dist-text read is one of the four excluded shapes above "to be thorough" — each
  is comment-immune by construction, adding cost with no coverage gained. The shapes aren't exhaustive —
  don't treat a candidate's absence here as proof it belongs on the other list.
- Do not treat option (b) (comment-stripping the scanners) as a substitute for this list, or forbid it —
  it's complementary hardening (`36afbbdd`) removing a false-positive risk these ten carry, but it doesn't
  fix the blame-routing defect this card's fix (folding the list into `buildReducedGateCommand`) closes.

## Source

`packages/daemon/src/git/worktrees.ts`, `DIST_TEXT_SCANNER_REPO_PATHS`'s doc comment, as of the commit
that introduced it (card `abaaf16e`).
