# 712148f1 — which skill frontmatter/body forms the installed CLI accepts, and how the detector widened

From investigate-first card `712148f1`, itself from the 51a2462a Code Review (worker 389522be, finding
3). Decision record `51a2462a` turned `permissionWidening.ts`'s DISCLOSURE detector into a REFUSE/STRIP
gate; this card asked whether every frontmatter/body form Claude Code's skill loader honours is also a
form the detector catches. Cross-references: `87a51903` (the detector's own "disclose, never strip"
posture), `51a2462a` (the refuse/strip module this card's widening flows into).

**Round 2** (same card, a second worker pass after a Code Review of round 1) replaced round 1's
per-form DENYLIST widening with a class-level ALLOWLIST — see "Round 2" below for why and what changed;
read that section before trusting any round-1-only description elsewhere in this record as still current.

**CLI version read**: `claude.exe` 2.1.317 (Windows, `C:\Users\danie\.local\bin\claude.exe`), a
Bun-compiled single-file executable with its bundled JS string constants embedded as plain, readable
text (no bytecode-only opacity) — read via a byte-offset string scan, never by spawning the CLI. **Every
finding below is pinned to that one version.** The loader is Anthropic's own code and can change between
releases with no Loom-side signal; re-verify this record's claims (ideally by re-running the same
static-scan method against the installed binary) after any CLI upgrade, rather than trusting an old
scan's offsets or conclusions against new bytes.

**Round 3 note (out of scope for this round):** the installed `claude.exe` was updated 2026-11-03
~02:30Z — it may now be newer than the 2.1.317 build this record's per-form table is pinned to. The
CLI's two `---` closers / EOL requirement is carded separately; that card owns re-running this record's
own static-scan method against whatever build is installed when it picks the work up, not this round.

## Method (why this is evidence, not a guess)

The binary's string constant pool is plain UTF-8/latin1 text at fixed byte offsets — read with
`fs.readFileSync(path, "latin1")`, searched with `indexOf`/`.exec`, context pulled via byte-range reads.
Several REGEX LITERALS (not just error-message strings) were recovered this way, byte-for-byte, from
three independent call sites. Two decoys had to be ruled out before trusting a hit: a highlight.js-style
YAML *syntax-highlighting grammar* (tag/block-scalar/doc-separator patterns that look YAML-parser-shaped
but sit amid NASM/XQuery/XML language definitions — rendering, not parsing) and a personal-memory-document
"lenient" quoted-key line parser (a completely different subsystem, `stampNewMemoryContent`). No `claude`
process was ever started; `claude --version` (metadata only, not a model turn) was the one live command run.

## Per-form verdict

| Form | Verdict | Evidence |
|---|---|---|
| Opening fence trailing whitespace (`"--- \n"`) | **CONFIRMED ACCEPTED** | `---[ \t]*\r?\n` found in 3 independent implementations (skill module, `propose_skills` tool, markdown search indexer) |
| `...` as a closing fence | **CONFIRMED NOT ACCEPTED** | every frontmatter-boundary regex found requires literal `---` to close; a combined `\n(?:---|\.\.\.)` search has 0 hits anywhere in the whole binary |
| Leading BOM | tolerated by at least one real implementation | `\uFEFF?` prefix in the `propose_skills` tool's own boundary regex |
| `~~~!` tilde fence | **CONFIRMED NOT RECOGNIZED** | 0 hits for the literal anywhere in the binary; the one real fenced-shell regex found requires literal triple-backtick |
| Fenced trigger (` ```! `) anchored to a line start | **CONFIRMED NOT ANCHORED in the real loader** | `` ```!\s*\n?([\s\S]*?)\n?``` `` and its boolean-test twin (immediately followed by the literal string `"[shell command execution disabled by policy]"`) carry no `^`, no leading-whitespace bound, no multiline flag |
| Inline trigger (`` !`cmd` ``) backtick-lookbehind (the triage note's case) | **RESOLVED — NOT a bypass** | real regex is `(?<=^|\s)!`([^`]+)`` ` — requires the `!` be preceded by start-of-string/content or whitespace. See "Triage-note resolution" below |
| Quoted frontmatter key (`"allowed-tools": Bash`, `'hooks': {}`) | UNCONFIRMED loader acceptance — round 2: fail-closed as unrecognized syntax (withheld whole), not merely a labeled vector | no key/value-interpretation regex found near any of the 3 boundary-regex call sites |
| Whitespace before the colon (`allowed-tools : Bash`) | UNCONFIRMED loader acceptance — ALLOWLISTED (still a plain top-level line; strips normally) | same gap as above |
| Flow-mapping frontmatter (`{name: x, allowed-tools: Bash}`, any line, single- or multi-line) | UNCONFIRMED loader acceptance — round 2: fail-closed as unrecognized syntax (withheld whole) | same gap as above |
| Explicit key (`? allowed-tools` / `: Bash`), tagged key (`!!str allowed-tools: Bash`), merge key (`<<: *a`), escaped-character quoted key (`"allowed\x2dtools": Bash`), an anchor/alias/tag VALUE (`base: &a`, `ref: *a`, `kind: !!str x`) | round 2: fail-closed as unrecognized syntax, by DESIGN — never evaluated against the loader (the allowlist rejects the SHAPE regardless of whether the real loader would honor it; see "Round 2" below) | n/a — the allowlist posture makes per-form loader acceptance irrelevant for anything it doesn't recognize |

## Triage-note resolution: the backtick-lookbehind case is NOT a bypass

The round-2 CR triage note (51a2462a) worried that `` `!`x` `` (a `!`x`` directly after a backtick) might
slip past the detector's `(?<!`)` exclusion if the real loader has no equivalent restriction. It does:
the real inline-trigger regex requires `(?<=^|\s)` — the `!` must be preceded by start-of-content or a
whitespace character. This is a strict SUBSET of `INLINE_SHELL_RE`'s own `(?<!`)` condition (anything but
a backtick): whitespace and string-start are never backticks, so whenever the real loader's condition
holds, Loom's detector's condition also holds — `claude-accepts ⟹ not-backtick-preceded ⟹ loom-detects`,
always. For the specific `` `!`x` `` case: the `!` there IS preceded by a backtick, so NEITHER the real
loader NOR the detector treats it as live — they agree it's inert. No widening needed; if anything the
detector's current pattern is already a superset of the real trigger condition on this one axis.

## What changed in `permissionWidening.ts`

1. **`FRONTMATTER_RE`** — opening fence widened to `^---[ \t]*\r?\n(...)`. The closing fence is
   deliberately NOT given a matching `...`-as-closer tolerance (confirmed not accepted — see table).
2. **`frontmatterReadIncomplete`'s own "did this open at all" check** — re-derived from `FRONTMATTER_RE`'s
   own `.source` (`FRONTMATTER_OPEN_RE`) rather than updated as a second hand-rolled literal, so the two
   can never drift apart again the way they would have if left as two independently-maintained patterns.
3. **`FRONTMATTER_KEY_LINE_RE`** — widened to `^["']?([A-Za-z0-9_-]+)["']?[ \t]*:`: an optional wrapping
   quote (the two quote marks need not match each other — over-inclusion is the safe direction, per
   `87a51903`'s own "a lookalike costs a sentence, a miss costs the whole point") and optional whitespace
   before the colon. Still anchored to column 0 — the "not a nested/nested key" guarantee is unchanged.
4. **`FLOW_MAPPING_KEY_RE`** (new export) — `[{,][ \t]*["']?([A-Za-z0-9_-]+)["']?[ \t]*:`, matching a key
   immediately after `{` or `,` inside a flow mapping. Deliberately NOT anchored to column 0 (a flow
   mapping packs several keys onto one line) and captures a key name generically rather than hardcoding
   `allowed-tools`/`hooks`, so a future vector needs no change here.
   - **Gated on the block containing a literal `{` at all** (`flowMappingFrontmatterKeys`'s own
     precondition). Without this gate, the `,`-led branch (needed to catch every key AFTER the first)
     has no way to require that comma sit inside actual braces — an ORDINARY frontmatter line whose plain
     scalar value merely contains a comma (`name: x, hooks: not a key`, no `{` anywhere in the block)
     false-positived before this gate was added. Caught during this card's own false-positive sweep, not
     by a reviewer — see "Named residual" below for what the gate does NOT close.
5. **`FENCED_SHELL_RE`** — anchor dropped entirely: `` /```!/ `` (was `/^[ \t]{0,3}```!/m`). Matches the
   real loader's own unanchored behaviour — an indented (4+ space), blockquoted, or mid-line ` ```! ` is
   confirmed live there and is now confirmed detected here too. `permissionGuard.ts`'s
   `FENCED_SHELL_RUN_RE` derives from this pattern's own `.source`, so the strip side picked up the same
   widening automatically with NO code change there — `stripShellTriggers`'s global `.replace()` was
   already position-agnostic.
6. **`detectPermissionWidening`** — merges `topLevelFrontmatterKeys(content)` and the new
   `flowMappingFrontmatterKeys(content)` before checking vector membership.

No second copy of any pattern was created; `permissionGuard.ts` (51a2462a) and
`skill-permission-widening-guard.mjs` (the bundled-asset lint, card `36101180`) both import or mirror the
SAME widened patterns from `permissionWidening.ts` — see "The build-independent guard copy" below for why
the lint keeps its own text copy rather than importing.

## What did NOT need a strip-side code change

- **Opening-fence whitespace, quoted key, space-before-colon**: `stripFrontmatterKeys`
  (`permissionGuard.ts`) already identifies a flagged key by walking `FRONTMATTER_KEY_LINE_RE` line by
  line and skipping the whole line; since that regex now recognizes these three forms as the SAME single
  top-level key line the plain form already was, strip removes them cleanly with zero changes to
  `stripFrontmatterKeys` itself. **Verified, not assumed**: `stripPermissionWidening` returns the
  byte-identical clean result for all three (see test fixtures below) — these are NOT withheld.
- **The three re-positioned fenced-trigger fixtures** (indented, blockquoted, mid-line): `stripShellTriggers`
  already does a global `.replace()` over the whole content with no anchor assumption of its own, so
  dropping `FENCED_SHELL_RE`'s anchor made both detection AND stripping correct for all three with zero
  additional code.

## Flow-mapping: the ONE form that genuinely cannot be surgically stripped (round 1 — see "Round 2" below)

Per the manager's explicit instruction, `stripFrontmatterKeys` was NOT given flow-mapping-aware logic.
A flow mapping packs the hazard key onto the SAME line as other (possibly legitimate) keys — the
line-based skip has nothing to cleanly remove without also dropping its siblings. Verified empirically:
`stripPermissionWidening("---\n{name: x, allowed-tools: Bash(*)}\n---\n\nbody\n")` returns `null` — the
REAL (non-mutant) fail-closed postcondition catches it because `flowMappingFrontmatterKeys` still reports
the vector after the (ineffective) strip attempt, same mechanism `51a2462a`'s round-3 `null` postcondition
already provides for every other vector. This is a NEW, non-mutant way to reach that branch with real
content — round 3's own whole-run strip had left no real combination of the four ORIGINAL vectors able
to reach it (hence that round's own deliberately-injected-detector test, PART D'/D" in
`skill-permission-guard.mjs`). The accepted outcome, per the manager: refuse at write (unaffected either
way — `permissionWideningRefusalError` reads `detectPermissionWidening` directly) plus withhold at
delivery (never a partially-stripped string). Confirmed on both paths — see test list below.

Round 2 generalizes this exact outcome (withhold, never a partial strip) to EVERY form the allowlist
rejects, not just a flow mapping specifically — see "Round 2" below. `stripFrontmatterKeys` itself is
still unchanged from round 1 (still no flow-mapping-aware logic); what changed is that
`stripPermissionWidening` now checks the allowlist FIRST and withholds before `stripFrontmatterKeys` is
even called, for any non-allowlisted line, not only a flow mapping.

## Round 2 — the ALLOWLIST (replacing the denylist widening above for quoted keys and flow mappings)

A Code Review of round 1 found it MAJOR-broken in two ways:

1. **Fail-open inside its own approved scope.** A MULTI-LINE flow mapping (the `{` on its own line) and
   an ESCAPED-CHARACTER quoted key (`"allowed\x2dtools": Bash` — the literal bytes never spell
   `allowed-tools`, only a YAML string-escape would resolve it) both slipped through round 1's
   `FLOW_MAPPING_KEY_RE`/quote-tolerant `FRONTMATTER_KEY_LINE_RE` undetected, `refuse:false`, delivered
   unchanged.
2. **A denylist of YAML key syntax can't converge.** An explicit key (`? allowed-tools` / `: Bash`), a
   tagged key (`!!str allowed-tools: Bash`), and a merge key (`<<: *a`) are all further forms a denylist
   would need yet another branch for — the enumeration never ends.

The fix (manager decision, gen 461) is a class-level pivot from DENYLIST to ALLOWLIST:
`frontmatterUnrecognizedSyntax` (`skills/permissionWidening.ts`) walks every non-blank frontmatter line
and accepts only three shapes — (i) a plain top-level `key: value` line (bare key, column 0, value not
starting with `&`/`*`/`!`), (ii) an indented continuation line, (iii) a column-0 YAML block-sequence item
directly continuing a key whose own value was empty. A blank line or a column-0 `#` comment is neutral.
**Anything else** — a quoted key (of any kind, including the escaped-character form), a flow mapping
(single- or multi-line: its own `{`/`[` at a key position never matches the plain-key shape), an explicit
key, a tagged key, a merge key, an anchor/alias/tag VALUE — fails the allowlist and is reported as the new
`frontmatter-unrecognized` vector, REGARDLESS of whether a specific hazardous key is also independently
labeled by the existing (unchanged) `topLevelFrontmatterKeys`/`flowMappingFrontmatterKeys` scans. Those
two scans keep running on every line unconditionally (for UI disclosure), but `detectPermissionWidening`
folds BOTH signals in — so a quoted `"allowed-tools"` key now reports `["allowed-tools",
"frontmatter-unrecognized"]`, not just `["allowed-tools"]` — and `permissionWideningRefusalError`/
`stripPermissionWidening` only ever need to check "is `detectPermissionWidening`'s result non-empty",
never the individual vector ids, so detect/refuse/strip provably agree on every one of these forms.

**Strip ordering is load-bearing.** `stripPermissionWidening` now checks `frontmatterUnrecognizedSyntax`
immediately after the initial "is this clean" check, BEFORE the `stripFrontmatterKeys`/`stripShellTriggers`
fixpoint loop ever runs, and returns `null` (withhold) immediately if it fires — never attempting to
strip the one non-allowlisted line. This was necessary, not merely tidy: `stripFrontmatterKeys` still
uses the quote-tolerant `FRONTMATTER_KEY_LINE_RE` to find a line to skip, so without the ordering fix it
would happily DELETE a quoted `"allowed-tools"` line (making it look surgically, successfully stripped)
instead of leaving the whole file withheld as round 2's design requires. Checking the allowlist first,
before any mutation is attempted, is what makes "no attempt to strip a non-allowlisted line" literally
true rather than true only after the fact.

**New exported constants** (`permissionWidening.ts`): `PLAIN_TOP_LEVEL_KEY_LINE_RE` (the strict,
never-quote-tolerant counterpart to `FRONTMATTER_KEY_LINE_RE`, used only by the allowlist classifier —
`FRONTMATTER_KEY_LINE_RE` itself is UNCHANGED and still quote-tolerant, for per-key labeling),
`SEQUENCE_ITEM_RE`, `FRONTMATTER_VALUE_START_FORBIDDEN_RE`. `FRONTMATTER_OPEN_RE` (NIT 6) is now the
PRIMARILY-authored constant with `FRONTMATTER_RE` built from it (`new RegExp(FRONTMATTER_OPEN_RE.source +
…)`), replacing the old fragile `.source.slice(0, .indexOf("("))` derivation, which ran in the opposite,
more fragile direction.

**`skill-permission-widening-guard.mjs`** (the build-independent bundled-asset lint) mirrors the same
allowlist in lockstep (its own `frontmatterUnrecognizedSyntax`/`PLAIN_TOP_LEVEL_KEY_LINE_RE`/
`SEQUENCE_ITEM_RE`/`FRONTMATTER_VALUE_START_FORBIDDEN_RE` text copies) and now folds it into `scanContent`,
so a bundled skill with unrecognized frontmatter syntax fails the bundled-asset scan too, not just the
real detector. A NEW file, `skill-permission-widening-lockstep.mjs`, is the dist-importing assertion that
every regex literal `skill-permission-widening-guard.mjs` keeps as its own text copy is byte-for-byte
identical (`.source`/`.flags`) to the real module's export — with ONE documented, pre-existing exception:
the guard's own `FRONTMATTER_RE` copy additionally consumes the newline after the closing fence
(`frontmatterBlockOf`'s own contract), which the real module's export deliberately leaves to its own
callers — the lockstep test asserts the guard's copy equals the real source PLUS exactly that trailing
`\r?\n?`, never bare equality, so this documented exception can never silently widen into a real drift.

False-positive measurement for round 2's allowlist is its own section below ("False-positive measurement
(round 2)") — read it alongside round 1's own measurement, which used a slightly different population
shape (counted `references/**` files inline rather than separately).

**YAML parser identification (time-boxed ~20 min, per the card):** a static byte-offset string scan of
the installed `claude.exe` (2.1.317) found the literal string `"Map keys must be unique"` — a distinctive
error message from the `eemeli/yaml` npm package's `Composer` — present somewhere in the binary. This is
suggestive that Claude Code bundles a real YAML parser SOMEWHERE in its dependency tree, but it does NOT
by itself establish that the skill-frontmatter LOADER (the specific code path this record's own method
section already searched) uses that parser for `allowed-tools`/`hooks` extraction — the original
per-call-site search near the three boundary-regex sites still found no key/value-interpretation regex,
consistent with a lenient, non-full-YAML frontmatter reader. Common markers for other candidate libraries
(`js-yaml`, `yaml-ast-parser`) were searched and NOT found. INCONCLUSIVE; not pursued further within the
time-box. Re-running this same string scan after a future CLI upgrade may settle it either way.

## False-positive measurement (round 1)

Measured across the SAME three populations `87a51903`'s own disclosure card measured: 14 bundled
(`packages/daemon/assets/skills`), 14 live store (`~/.loom/skills`), 7 personal (`~/.claude/skills`) — 66
files total. **0 hits** for the widened detector (including the flow-mapping scan, after the `{`-presence
gate above), with positive controls (synthetic fixtures for every new form) confirmed firing before
trusting the 0. Re-measured after the gate fix; still 0. The bundled-asset lint
(`skill-permission-widening-guard.mjs`) keeps its own text-copy patterns in lockstep (see "The
build-independent guard copy" below) and independently confirms 0 hits on the 14 bundled dirs as part of
its own run.

## False-positive measurement (round 2)

The round-2 allowlist (`frontmatterUnrecognizedSyntax`) was run (read-only) over every real SKILL.md
reachable without touching `~/.loom` except via a read-only copy into `$LOOM_SCRATCH_DIR` — 14 bundled
(`packages/daemon/assets/skills`), 14 live store (a read-only copy of `~/.loom/skills`), 6 live personal
(a read-only copy of `~/.claude/skills` — the 7th entry, `synced`, is an internal data-bucket directory
with no `SKILL.md` of its own, not a real skill). **0 hits** across all 34 files. The bundled
population's `references/**` files (14 more, scanned by `skill-permission-widening-guard.mjs`'s own
existing walk, now extended with the same allowlist — see "Round 2" above) are ALSO 0 hits — none carry a
frontmatter block at all (they open with a markdown `#` heading, not `---`), so
`frontmatterUnrecognizedSyntax` returns `false` immediately for every one of them. Positive controls
(synthetic fixtures for every round-2 form named in the table above) were confirmed firing BEFORE
trusting the 0 — see `skill-permission-widening-detector.mjs`'s `[712148f1][r2]` fixtures and
`skill-permission-guard.mjs`'s `WITHHELD_FIXTURES`. No real, legitimate skill's frontmatter was rejected;
nothing was blocked.

## The build-independent guard copy

`skill-permission-widening-guard.mjs` deliberately keeps its OWN copy of `FRONTMATTER_RE`,
`topLevelKeysOf`, `FENCED_SHELL_RE`, and (now) `FLOW_MAPPING_KEY_RE`/`flowMappingKeysOf` — it never
imports `permissionWidening.ts`, specifically so it can run with no build step (a bare `node test/*.mjs`
source-text scan). This predates, and is a narrow, intentional exception to, `87a51903`'s "do not copy
these regexes into a second file" rule. This card widened that copy IN LOCKSTEP with the real module's
patterns; a future change to either must update both, or this lint silently stops catching what the real
detector would catch.

## Named residual

The flow-mapping gate (requiring a literal `{` somewhere in the block before scanning) closes the
"ordinary line, no braces anywhere" false positive this card's own measurement surfaced, but does NOT
prove the matched comma sits INSIDE actual braces — only that braces exist SOMEWHERE in the block. A real
flow mapping whose own quoted STRING VALUE happens to contain a `, hooks:`-shaped substring (e.g.
`{name: x, note: "a, hooks: looking substring"}`) still over-matches. This is ACCEPTED, not a gap to
close: once a `{` is genuinely present, the block already looks enough like a flow mapping that the
`87a51903` "a lookalike costs a sentence" posture applies — a dedicated test fixture documents this exact
case (`skill-permission-widening-detector.mjs`, `[712148f1][trap]`) so it is never mistaken for a
regression later. (Round 2: that same line is now ALSO independently caught by the allowlist, since any
line starting with `{` fails `frontmatterUnrecognizedSyntax` outright — the over-match above is a
residual of the OLDER, narrower `flowMappingFrontmatterKeys` labeling scan, not of the allowlist, which
doesn't need to locate the comma at all to reject the line.)

Round 2's own residual, as CORRECTED by round 3 (round 2's original text here conflated two different
indentation cases — see "Round 3" below for the fix that separates them): `frontmatterUnrecognizedSyntax`
treats an indented line as a neutral continuation ONLY once a real top-level key has already been seen.
A hazardous key nested two levels deep under an allowlisted top-level key that IS already present (e.g.
`capabilities:\n  hooks: x`, already a pre-existing, accepted non-finding per `87a51903`'s own "a
different field that merely shares a name" posture) stays unflagged by DESIGN, same as round 1 — this
part of the residual is genuinely unchanged. What round 3 fixed is the OTHER case this paragraph used to
describe as the same thing: an indented line with NO preceding top-level key at all (the frontmatter
ROOT itself indented) — that is NOT the nested-key residual above; it is now "anything else" (unrecognized),
not a blanket continuation exemption. See "Round 3 — MAJOR 1" below.

## Round 3 — Code Review of round 2, five findings

A Code Review of round 2's own shipped shape found two MAJOR (blocking) issues, one MINOR, and two NITs.

### MAJOR 1 — an indented ROOT line was wrongly treated as a blanket-neutral continuation

`frontmatterUnrecognizedSyntax`'s rule (ii) read `/^[ \t]/.test(line)) continue` with no precondition —
ANY indented line was neutral, even BEFORE any top-level key had been seen at all. In real YAML the root
mapping of a block can itself be indented, so an entire frontmatter block consisting only of indented
lines (no column-0 key anywhere) was wrongly allowlisted as "just continuations," with nothing to
continue. Four repros, all previously undetected and previously stripped/passed through unchanged:
`"---\n  allowed-tools: Bash\n---"`, `'---\n  "allowed\x2dtools": Bash\n---'` (a real backslash in the
file), `'---\n# c\n  "hook\x73": {}\n---'`, `"---\n ? allowed-tools\n : Bash\n---"`.

**Fix:** track whether a top-level key has already been seen (`seenTopLevelKey`). An indented line is
neutral ONLY once that is true; otherwise it falls through to the same "anything else" branch a quoted/
flow/explicit/tagged/merge-key line already takes. A blank or column-0 `#` comment line stays neutral
unconditionally either way (it was never gated on `seenTopLevelKey` and still isn't — only indentation
needed the gate). Applied to BOTH copies in lockstep: `permissionWidening.ts`'s real export and
`skill-permission-widening-guard.mjs`'s own text copy. All four repros (+ a CRLF variant, + a regression
control proving a REAL top-level key is unaffected) are now fixtures through detect
(`skill-permission-widening-detector.mjs`), refuse+strip (`skill-permission-guard.mjs`'s
`WITHHELD_FIXTURES`), and the bundled-asset lint's own self-tests
(`skill-permission-widening-guard.mjs`).

This fix does NOT change the accepted round-2 residual for a nested key UNDER a real top-level key that
already exists (`capabilities:\n  hooks: x` still passes, by design) — see the corrected "Round 2's own
residual" paragraph above for why those are two different cases that round 2's text had conflated.

### MAJOR 2 — the cwd-skills scan's own vocabulary silently dropped `frontmatter-unrecognized`

`skills/permission-scan.ts`'s `SkillPermissionField`/`SCAN_FIELDS` was an INCLUDE allowlist of exactly
`["allowed-tools", "hooks"]` — the two vectors that existed when card 015fdb23 first wrote this scan.
When `frontmatter-unrecognized` was added to `SkillPermissionVector` (this same card, round 2), the scan
never updated its own allowlist, so a repo skill whose ONLY hazard was unrecognized frontmatter syntax
(no independently-labeled `allowed-tools`/`hooks` key) produced ZERO findings from this scan — silently
dropped, with no truncation, no incompleteness, nothing — even though the real shared detector
(`detectPermissionWidening`) genuinely flagged it. The same trap `frontmatterUnrecognizedSyntax` itself
was built to escape (an enumeration of named forms cannot converge) had quietly reappeared one layer up.

**Fix:** inverted the filter to EXCLUDE-shaped. `SkillPermissionField` is now
`Exclude<SkillPermissionVector, "shell-inline" | "shell-fenced">` — those two remain the only vectors
this scan deliberately omits (`disableSkillShellExecution` already neutralizes both for every
`LOOM_DRIVEN_ROLES` session; see card 979f29b9's own "already neutralized" note). The new exported
`isScannedPermissionField(v): v is SkillPermissionField` predicate IS the filter (`EXCLUDED_SCAN_VECTORS`
names only the two shell forms) — a brand-new vector added to `SkillPermissionVector` later needs no
change here to be scanned. `pty/host.ts`'s own console line (the one place `findings[].fields` is
rendered/logged) now maps each field through the new exported `SKILL_PERMISSION_FIELD_LABEL` —
`Record<SkillPermissionField, string>`, so a future vector this scan newly includes is a compile error
there until it's given a label, never a silent bare-id fallback. Fixtures:
`skill-permission-frontmatter-scan.mjs`'s PART 1b — a real skill whose only hazard is unrecognized
syntax now produces a genuine finding (where the old allowlist produced none), a skill with BOTH a
specific key and unrecognized syntax reports both fields additively, and a direct check of
`isScannedPermissionField` against a SYNTHETIC vector id that does not exist in today's union at all
(the "future vector" proof a real fixture can't otherwise give, since there is no real future vector to
construct one from).

### MINOR 3 — the lockstep test only ever compared regex CONSTANTS, never the guard's own LOGIC

`skill-permission-widening-lockstep.mjs` asserted every regex-literal constant
`skill-permission-widening-guard.mjs` copies is byte-identical to the real module's export — but
`frontmatterUnrecognizedSyntax` is a hand-rolled LOOP over those constants, duplicated as its own
function body in the guard file, and nothing ever compared that loop's own behavior to the real module's
export. A mutant that made e.g. quoted-key lines neutral in the GUARD's own copy, while leaving every
regex-literal const untouched, would have stayed green against every check that file had.

**Fix:** added a DIFFERENTIAL check to the same file — it extracts the guard's own `frontmatterBlockOf`/
`frontmatterUnrecognizedSyntax` function source text VERBATIM (via a column-0-closing-brace-anchored
regex, never re-authored by hand), rebuilds it as a closure over the guard's own already-extracted
regex-literal copies, and runs it side by side with the real module's own `frontmatterUnrecognizedSyntax`
export over one shared fixture corpus — every round-1/2/3 hazard form, the round-2 allowlist's own
benign/positive forms (literal/folded block scalars, quoted values, sequences, comments), and the four
MAJOR-1 repros — asserting identical outputs on every one. A non-vacuousness control confirms the corpus
actually produces both `true` and `false` under the real classifier, so the comparison isn't trivially
satisfied by an always-agreeing constant.

Also corrected: `skill-permission-widening-lockstep.mjs`'s own header (its lines 2-16) had begun to
overclaim "covers every pattern the guard mirrors" — the checks that header describes only ever compared
regex-literal CONSTANTS, never the guard's own hand-rolled `frontmatterUnrecognizedSyntax` LOGIC. Reworded
to "covers every REGEX-LITERAL CONSTANT the guard mirrors," with a pointer to the new differential check
(this is what actually backs the broader "the guard agrees with the real module" claim now). The header
stays inline narrative (class A, per the comment taxonomy) — no decision anchor needed for a wording fix.

### NIT 5 — two remaining, accepted over-matches, named for the record

Neither changed — fail-closed is acceptable for both, per `87a51903`'s "a lookalike costs a sentence, a
miss costs the whole point" posture — but neither was previously named anywhere in this record:

- `metadata: {hooks: y}` — `flowMappingFrontmatterKeys`'s block-wide (not line-scoped) scan matches the
  `{hooks:` substring regardless of which top-level key's VALUE the flow mapping sits under, so a
  `hooks:` key genuinely nested inside an unrelated top-level key's inline-mapping value is labeled as if
  it were the real top-level `hooks:` field. `frontmatterUnrecognizedSyntax` does NOT independently flag
  this line (a plain `key: {…}` line is an ordinary allowlisted top-level line to it, regardless of what
  the value itself looks like), so the sole signal is the over-labeled `hooks` vector — which still makes
  `stripPermissionWidening` withhold (the mislabeled `hooks` key never matches `metadata` on the
  line-based strip, so it survives the fixpoint loop and the content stays flagged, hence `null`).
- `hooks:{}` (no space after the colon) — `FRONTMATTER_KEY_LINE_RE`/`topLevelFrontmatterKeys` match the
  bare key name regardless of what its value is; an empty flow-mapping VALUE (`{}`, meaning "no hooks
  actually registered") is a legitimate, inert YAML shape, but the per-key scan labels the line as the
  hazardous `hooks` field anyway, and `stripFrontmatterKeys` then removes it as if it carried a real
  grant — a successful strip of a line that was never actually dangerous.

## Do not

- Do not re-derive the per-form verdicts in the table above by re-grepping the CLI binary from scratch
  without reading this record first — the method section above names the two decoys (the highlight.js
  grammar, the personal-memory lenient parser) that look like hits and are not; re-discovering them is
  wasted effort this record already paid for.
- Do not widen the closing fence to also accept `...` — confirmed not accepted by every real boundary
  regex found; see the table.
- Do not add `~~~!` tilde-fence handling to `FENCED_SHELL_RE` — confirmed not recognized by the real
  loader; see the table.
- Do not add a backtick-lookbehind-removal "fix" to `INLINE_SHELL_RE` on the premise that the triage note
  found a real bypass — it didn't; see "Triage-note resolution" above.
- Do not treat the quoted-key/space-before-colon/flow-mapping forms as confirmed loader behaviour —
  loader acceptance is still UNCONFIRMED for all of them, same posture as the BOM handling in
  `51a2462a`/`87a51903`. (Round 2 changed how UNCONFIRMED-but-exotic syntax is HANDLED — fail-closed via
  the allowlist rather than labeled via a denylist widening — not whether the underlying loader question
  is confirmed; it still isn't.) If a future static read of a newer CLI build settles the question either
  way, update this table and this "Do not" bullet, not just the code.
- Do not go back to enumerating YAML key syntax (a denylist) in `detectPermissionWidening`/
  `topLevelFrontmatterKeys`/`flowMappingFrontmatterKeys` to catch a new exotic form — round 2 replaced
  that approach specifically because it cannot converge (see "Round 2" above: an explicit key, a tagged
  key, and a merge key were three MORE forms found the moment the denylist widened to catch the first
  two). Extend `frontmatterUnrecognizedSyntax`'s ALLOWLIST instead, or — if a genuinely new BORING shape
  needs admitting — add it there, never add a new REJECTED-shape branch.
- Do not move the `frontmatterUnrecognizedSyntax` check in `stripPermissionWidening` to run AFTER the
  `stripFrontmatterKeys`/`stripShellTriggers` fixpoint loop — `stripFrontmatterKeys`'s own quote-tolerant
  key match would DELETE a quoted hazard line first, defeating round 2's "no attempt to strip a
  non-allowlisted line" requirement by making the deletion look like a successful surgical strip.
- Do not let `skill-permission-widening-guard.mjs`'s round-2 allowlist copy
  (`PLAIN_TOP_LEVEL_KEY_LINE_RE`/`SEQUENCE_ITEM_RE`/`FRONTMATTER_VALUE_START_FORBIDDEN_RE`/its own
  `frontmatterUnrecognizedSyntax`) drift from `permissionWidening.ts`'s real exports — widen both
  together, and let `skill-permission-widening-lockstep.mjs` prove they still match on every change.
- Do not give `stripFrontmatterKeys` flow-mapping-aware surgical removal logic — the manager's explicit
  call: refuse-at-write + withhold-at-delivery is the accepted outcome for this one exotic form; a
  surgical rewrite would be a second, harder-to-verify code path for a case the existing fail-closed
  postcondition already handles correctly.
- Do not remove the `{`-presence gate on `flowMappingFrontmatterKeys`/`flowMappingKeysOf` — without it, an
  ordinary frontmatter line whose plain scalar value merely contains a comma false-positives with no flow
  mapping present anywhere in the block (measured, not theoretical — this is what the gate was added to fix).
- Do not let `skill-permission-widening-guard.mjs`'s own copy of these patterns drift from
  `permissionWidening.ts`'s real ones — widen both together, every time either changes.
- Do not re-verify any of the per-form verdicts in this record by trusting an EARLIER scan's conclusions
  against a NEWER installed CLI build. Re-run the static-scan method (or a successor to it) against
  whatever `claude --version` reports at the time, and update this record's version line + table if
  anything has changed.
- Do not revert `frontmatterUnrecognizedSyntax`'s indentation rule back to an unconditional "any indented
  line is neutral" (round 3, MAJOR 1) — a frontmatter block's ROOT can itself be indented in real YAML,
  and the fix (gate indentation-is-neutral on `seenTopLevelKey`) is load-bearing for the four repros named
  above. Keep both copies (`permissionWidening.ts`, `skill-permission-widening-guard.mjs`) in lockstep.
- Do not go back to an INCLUDE-shaped `SkillPermissionField`/scan filter in `permission-scan.ts` (round 3,
  MAJOR 2) — `isScannedPermissionField`'s EXCLUDE shape (naming only the two shell forms
  `disableSkillShellExecution` already neutralizes) is what keeps a future `SkillPermissionVector` member
  in scope with no code change here; an allowlist of named vectors silently drops anything it doesn't
  already enumerate, exactly as it did for `frontmatter-unrecognized` before this fix.
- Do not render or log `findings[].fields` anywhere (e.g. a future `pty/host.ts` consumer) without routing
  each id through `SKILL_PERMISSION_FIELD_LABEL` — its `Record<SkillPermissionField, string>` shape is
  what makes a future vector a compile error here until it's given a label.
- Do not trust `skill-permission-widening-lockstep.mjs`'s regex-literal-only checks as proof the guard's
  own `frontmatterUnrecognizedSyntax` LOGIC still agrees with the real module (round 3, MINOR 3) — only
  the DIFFERENTIAL check (extracting and running the guard's real function source side by side with the
  real module's export) proves that; keep it in lockstep with any future change to either copy's logic,
  not just their constants.
- Do not "fix" the two NIT 5 over-matches (`metadata: {hooks: y}`; `hooks:{}`) — both are accepted,
  fail-closed residuals, not bugs; see "Round 3 — NIT 5" above for why each one is safe to leave as is.
