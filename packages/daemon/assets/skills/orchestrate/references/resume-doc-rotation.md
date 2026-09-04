# Resume-doc rotation — procedure & provenance

The core doctrine (the loop, step 8) carries the binding rule — active doc ~150 lines / hard-cap
~400, check size BEFORE each rewrite, rotate rather than trim-and-lose. This file carries the exact
procedure and the incident behind the budget.

Keep the ACTIVE doc comfortably inside ONE `Read` page: target ~150 lines, hard-cap ~400 lines
(~40KB), well under the 256KB / ~25k-token Read caps — a doc that exceeds them breaks a successor's
very first read (real incident: an Orchestrator Log grew to 266KB / 906 lines of mostly-superseded
provenance and broke `Read` twice, blocking cold resume until hand-trimmed). **Count lines from the
`Read` tool's own line numbers** — if you've already opened the doc, the correct total is right there
at zero extra cost — or the file size in bytes; a shell line-count may report only non-empty lines, so
verify what yours counts before trusting it. Carry forward only CURRENT state. **Check size BEFORE
each rewrite, not after:** before you write, glance at whether the doc is already near the hard-cap —
if it is, ROTATE FIRST, then write the new content into the fresh doc. Don't wait for the write that
finally crosses the cap; by then a cold successor may already be reading a broken file.
**When a rewrite would push the doc past the budget, ROTATE rather than trim-and-lose:** (1) move the
current doc to a dated archive sibling — `<name>.archive/<YYYY-MM-DD>-NN.md` — old notes preserved
intact, nothing deleted; (2) start a FRESH active doc holding only the live state plus a one-line
pointer ("older provenance in `<name>.archive/`, newest first"). A successor always reads the small
active doc; the history stays retrievable in the archive.

**"The rotation is where rules die."** A rewrite can silently drop a durable rule that was only ever
carried as a line in this doc — nobody notices until a successor needs it and it's gone. If your project
has configured a protected-marker set (`orchestration.rotationMarkers`, and optionally
`rotationLiveCommitmentsHeading`/`rotationLiveCommitmentsFloor` on a numbered "live commitments"-style
section), call the **`resume_doc_check`** MCP tool before promoting a rotated doc — it resolves and
reads YOUR resume doc itself (no path to get wrong) and refuses (`ok:false`, naming the missing token)
if the new doc silently dropped one. Call it with no arguments any time, not just at a rotation. **Read
its response before trusting a green:** `configured:false` means this project hasn't set up any
protection yet — that's not a pass, it's nothing having been checked at all. And even a real pass is a
narrow one — its own `honestLimitNote` says why: every check is an exact-substring grep, proving a
token's literal text survived, never that no meaning survived a rewording.

**Read the per-leg fields too, not just the overall `ok`.** `archiveCheck` and `byteCheck` report on an
archive path / a pre-edit byte count you optionally supplied, and both DO drive the overall `ok` when
checked. `rulesCheck` reports whether an optional rules-file union source you supplied was actually read
— it deliberately does NOT drive `ok`, so a green overall `ok` never proves the rules file was consulted;
only `rulesCheck: {checked:true, ok:true}` does that. `markerSources` names which text satisfied each
marker (`"active"` or `"rules"`) — a `"rules"` source is positive proof that file was read, but only when
at least one marker is exclusive to the rules file; if every marker also lives in the active doc, every
source reads `"active"` and tells you nothing. If nothing is configured yet
and you want this protection, add markers via your own project's config (additive-only from a manager
session — you can grow the list but not shrink it; ask the human/Lead for a removal). This is a Loom
daemon capability, not a doc convention — you don't need to build anything to use it.

**Before adding a new rule to this file, check it against one axis: does it have its own moment of need
that fires independently of a rotation being due?** A procedure you follow *when you rotate* fits here.
A standing obligation — something that must hold on every rewrite of the doc, with no trigger of its own
— does not: this file is read on demand, only when a rotation comes due, so a rule whose real moment of
need is unrelated to that event may never get read at all. That kind belongs in the core doctrine itself,
even as just a line or two, not here.
