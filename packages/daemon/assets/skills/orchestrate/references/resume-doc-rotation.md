# Resume-doc rotation — procedure & provenance

The core doctrine (the loop, step 8) carries the binding rule — active doc ~150 lines / hard-cap
~400, check size BEFORE each rewrite, rotate rather than trim-and-lose. This file carries the exact
procedure and the incident behind the budget.

Keep the ACTIVE doc inside ONE `Read` page: target ~150 lines, hard-cap ~400 lines (~40KB), well under
the 256KB / ~25k-token Read caps; a larger doc breaks a successor's very first read (a log that grew
to 266KB / 906 lines of superseded provenance broke `Read` twice and blocked cold resume). **Count
lines from the `Read` tool's own line numbers** (free if you've opened the doc) or the byte size; a
shell line-count may skip empty lines, so verify what yours counts. Carry forward only CURRENT state.
**Check size BEFORE each rewrite, not after:** if the doc is near the hard-cap, ROTATE FIRST, then
write into the fresh doc.
**When a rewrite would push the doc past the budget, ROTATE rather than trim-and-lose:** (1) move the
current doc to a dated archive sibling, `<name>.archive/<YYYY-MM-DD>-NN.md`, intact; (2) start a FRESH
active doc holding only live state plus a one-line pointer ("older provenance in `<name>.archive/`,
newest first").

**"The rotation is where rules die."** A rewrite can silently drop a durable rule that was only carried
as a line in this doc. If your project configured a protected-marker set (`orchestration.rotationMarkers`,
and optionally `rotationLiveCommitmentsHeading`/`rotationLiveCommitmentsFloor` on a numbered "live
commitments"-style section), call the **`resume_doc_check`** MCP tool before promoting a rotated doc.
It resolves and reads YOUR resume doc itself (no path to get wrong) and refuses (`ok:false`, naming the
missing token) if the new doc dropped one. Call it with no arguments any time. **Read its response
before trusting a green:** `configured:false` means nothing was checked, not a pass; and even a real
pass is narrow (its `honestLimitNote`): every check is an exact-substring grep, proving a token's text
survived, never that its meaning did.

**The LIVE-COMMITMENTS section is normally located by heading-text search, which has a hazard a marker
closes.** `rotationLiveCommitmentsHeading` matches the first heading line that CONTAINS it, so an
earlier heading that merely CITES that text can win and undercount. Set
`orchestration.rotationLiveCommitmentsMarker` (e.g. `<!-- loom:live-commitments -->`, on its own line
above the heading or inline) to anchor on that token. Once set, there is **NO fallback to heading
search**: a doc that dropped the marker fails loud. If the marker occurs more than once, the response
carries `liveCommitments.markerAmbiguous`/`markerOccurrences` plus `markerAmbiguityWarning`, never a
silent first-match.

**Read the per-leg fields, not just the overall `ok`.** `archiveCheck` and `byteCheck` (on an archive
path / pre-edit byte count you supplied) DO drive `ok`. `rulesCheck` (whether an optional rules-file
union source was read) deliberately does NOT: only `rulesCheck: {checked:true, ok:true}` proves the
rules file was consulted. `markerSources` names which text satisfied each marker (`"active"` or
`"rules"`); `"rules"` proves that file was read only when at least one marker is exclusive to it
(otherwise everything reads `"active"`).

**With a SECOND (or more) durable, non-rotating doctrine file** outside this rotating doc, pass all of
them as a `rulesPaths` array (alongside or instead of `rulesPath`); the union spans all, for markers
and the live-commitments section. Each gets its own `rulesChecks` entry, and `markerSources`/the
floor's `source` names that file's path. `rulesUnreadableWarning` is present whenever ANY supplied rules
file could not be read; like `rulesCheck` it does NOT drive `ok`. If nothing is configured and you want
this protection, add markers via your project's config (additive-only from a manager session; ask the
human/Lead to remove). It's a daemon capability; you build nothing.

**Before adding a rule to this file, ask whether it has its own moment of need independent of a
rotation being due.** A procedure you follow *when you rotate* fits here. A standing obligation that
holds on every rewrite does not (this file is read only when a rotation comes due), so it belongs in
the core doctrine, even as a line or two.
