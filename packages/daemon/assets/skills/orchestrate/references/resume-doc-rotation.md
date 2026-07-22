# Resume-doc rotation — procedure & provenance

The core doctrine (the loop, step 8) carries the binding rule — active doc ~150 lines / hard-cap
~400, check size BEFORE each rewrite, rotate rather than trim-and-lose. This file carries the exact
procedure and the incident behind the budget.

Keep the ACTIVE doc comfortably inside ONE `Read` page: target ~150 lines, hard-cap ~400, well under
the 256KB / ~25k-token Read caps — a doc that exceeds them breaks a successor's very first read (real
incident: an Orchestrator Log grew to 266KB / 906 lines of mostly-superseded provenance and broke
`Read` twice, blocking cold resume until hand-trimmed). Carry forward only CURRENT state. **Check size
BEFORE each rewrite, not after:** before you write, glance at whether the doc is already near the
hard-cap — if it is, ROTATE FIRST, then write the new content into the fresh doc. Don't wait for the
write that finally crosses the cap; by then a cold successor may already be reading a broken file.
**When a rewrite would push the doc past the budget, ROTATE rather than trim-and-lose:** (1) move the
current doc to a dated archive sibling — `<name>.archive/<YYYY-MM-DD>-NN.md` — old notes preserved
intact, nothing deleted; (2) start a FRESH active doc holding only the live state plus a one-line
pointer ("older provenance in `<name>.archive/`, newest first"). A successor always reads the small
active doc; the history stays retrievable in the archive.
