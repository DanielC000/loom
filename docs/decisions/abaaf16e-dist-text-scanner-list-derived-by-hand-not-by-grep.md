# abaaf16e — `DIST_TEXT_SCANNER_REPO_PATHS` was derived by hand, and no naive grep reproduces it

## Narrative

`computeEmitCompareGate` proves a changed compiled `.ts` file's COMPILED BEHAVIOR is unchanged by
transpiling with `removeComments:true` forced (@decision `2154b6ad`) and, when identical, skips the
~668-test runtime suite. That proof is sound for ordinary runtime behavior — but a handful of runtime
tests don't exercise compiled behavior at all: they `fs.readFileSync` real `dist/**` output and
pattern-match its TEXT, and tsc keeps comments in the emit (no `removeComments` anywhere in this repo's
own tsconfig chain — only the isolated proof-comparison above forces it). For a member of this class, a
comment-only diff that introduces (or removes) matching text can flip the test's own verdict even though
the reduced gate's transpile-comparison correctly proved the diff behaviorally inert. `agent-runs-keys.mjs`'s
"G3" check (a structural proof that no compiled MCP router can mint/rotate API keys or flip `endpoint`) is
the specimen that surfaced this: its own inline comment documents that a boolean sentinel VALUE once
collided with its pattern and re-broke it — not hypothetical in kind, even though the entityRowFields
extraction run that motivated card `abaaf16e` did not actually trip it (G3 ran directly and passed).

## The sweep, and why a single grep can't replace it

Card `abaaf16e`'s own naive starting point — `grep -l "readFileSync(.*dist" packages/daemon/test/*.mjs`
— MISSES G3 entirely: `agent-runs-keys.mjs` builds its `mcpDir` path on one line and calls
`fs.readFileSync(path.join(mcpDir, f), "utf8")` on a later one, so `readFileSync(` and the literal `dist`
never share a line. A broader sweep (`readFileSync|readdirSync` combined with a `dist` hit anywhere in the
file) over-shoots into ~180 files, almost all of them ordinary `await import("../dist/...")` module
loading — irrelevant, since importing EXECUTES code and comments never reach the parser either way,
unlike a text scan. The list that actually resulted — 10 files, refuting the kickoff's own working
hypothesis that G3 was the only member — was built by reading every candidate by hand against the
membership criterion below.

## Membership criterion

A test belongs on `DIST_TEXT_SCANNER_REPO_PATHS` only if it does a RAW, UNSTRIPPED whole-file (or
large-region) text scan of real, compiled `dist/**` output, where a comment anywhere in the scanned region
can change what the scan matches. This is a judgement call, not a grep-derivable property, for the exact
reason the sweep above demonstrates.

## The three excluded shapes

Three shapes also read compiled `dist/**` text but are comment-immune by construction, so they are
deliberately NOT on this list:

1. **Bounded, named-declaration extraction of DATA** — `task-deferred-items-migration.mjs`,
   `task-deferred-until-event-migration.mjs`, `task-manual-deferral-migration.mjs` each extract only the
   `` const SCHEMA = `...`; `` template-literal BODY via a bounded regex. A template literal's string
   content is never comment syntax, so `removeComments` cannot touch it regardless of what any comment
   elsewhere in the file says.
2. **TS-compiler AST-narrowed function/method-body extraction** — `codescape-spawn-repopath-guard.mjs`,
   `loopback-write-guard.mjs` (§G), `task-version-guard.mjs` (§5), `project-memory-version-guard.mjs`. The
   anchor is a real DECLARED NAME found via the TypeScript compiler's own parser, and the text check runs
   only against that one extracted region. `loopback-write-guard.mjs`'s own inline comment documents it was
   burned by comment-anchoring once (a heading comment relocated by an unrelated extraction pass silently
   zeroed its anchor) and was deliberately re-anchored on a real code token — precedent that this shape is
   the intentionally-hardened one. Residual risk is only an interior comment inside that one extracted
   function/method matching the check's own pattern — several orders narrower than a whole-file scan, and
   out of scope for this card.
3. **Explicit comment-stripped whole-file scan** — `codescape-supervisor-shutdown-wiring.mjs` calls its own
   local `stripComments()` (with its own sanity check that the stripper actually strips) before every
   assertion, documented as sharing that per-line discipline with `exit-code-verdict-guard.mjs` /
   `harness-adapter-claude-literal-guard.mjs` — both already unconditional members of
   `STATIC_GUARD_REPO_PATHS`. Already immune by construction.
4. **Presence-only assertion of a real code token** — `loopback-secret.mjs` (D) reads compiled
   `dist/gateway/loopback-secret.js` and asserts `/timingSafeEqual\(/.test(src)`: the call site DOES
   exist. A comment-only diff is, by `computeEmitCompareGate`'s own transpile-comparison, one that leaves
   every real code token unchanged — so a genuine `timingSafeEqual(` call already present in code stays
   present, byte-for-byte, regardless of what any comment says. A comment could only ever ADD a spurious
   occurrence, which for a PRESENCE check can only flip a fail toward a pass it doesn't structurally need
   — never flip a pass to a fail. This is the mirror of shapes 1-3: those are immune because of WHERE they
   look (data, a narrow region, stripped text); this one is immune because of the POLARITY of what it
   asserts. This four-shape list is a judgment call, not a closed taxonomy — a future dist-text reader
   shaped some other way may need its own reasoning, not a fifth bullet appended by pattern-matching
   these four.

## Option (b) — complementary hardening, not a substitute (card `36afbbdd`)

Teaching the raw scanners above to strip comments the same way shape (3) already does was considered as an
alternative to this list. All ten guard CODE SHAPE, not documentation — a comment that happens to trip one
is a false positive on the check's own terms, so stripping comments before matching would make each
scanner more precisely test what it actually means to test, and is worth doing on its own merits. It does
NOT substitute for this card's fix, though: `buildReducedGateCommand` folding this list in is what makes a
comment-only diff that introduces matching text get CAUGHT AT THE REDUCED GATE, correctly blaming the
commit that introduced it, rather than surfacing later as a confusing failure on an unrelated full gate —
the actual defect this card closes (blame-routing, not false-positive avoidance). Comment-stripping the
scanners would remove the false-positive risk but wouldn't, by itself, fix WHERE a real hit gets reported.
Carded as complementary hardening: card `36afbbdd`.

## Do not

- Do not re-derive `DIST_TEXT_SCANNER_REPO_PATHS` from a single grep for `readFileSync(.*dist` or any other
  one literal — it misses G3 (the read's `dist` path segment sits on an earlier line than the
  `readFileSync(` call) and a broader sweep over-shoots into ordinary module-loading imports that are
  irrelevant to this list's concern.
- Do not add a test whose dist-text read is one of the four excluded shapes above "to be thorough" — each
  is comment-immune by construction, so adding it would only add cost with no coverage gained. The four
  shapes are not exhaustive, though — don't treat a new candidate's absence from this list as proof it
  belongs on the OTHER one; re-derive the judgment call.
- Do not treat option (b) (comment-stripping the scanners) as a substitute for this list, or forbid it —
  it's complementary hardening (card `36afbbdd`) that would remove a false-positive risk these ten still
  carry, but it doesn't fix the blame-routing defect this card's own fix (folding the list into
  `buildReducedGateCommand`) actually closes.

## Source

`packages/daemon/src/git/worktrees.ts`, `DIST_TEXT_SCANNER_REPO_PATHS`'s own doc comment, as of the commit
that introduced it (card `abaaf16e`).
