# 8636f761 — `appendBody` exists because a Lead's triage verdict clobbered the reporter's evidence

## Narrative (DoD-1: why `appendBody` exists)

`appendBody` is an ADDITIVE alternative to `updateProjectTask`'s `body`: it appends a timestamped
"## Triage note — <ts>" section instead of replacing the whole body. It exists because `body` is a full
replace with no undo, and a Lead triaging a `platform_escalate` card was clobbering the reporter's
original evidence with its own verdict — the Lead's own doctrine ("preserve the original verbatim below")
was a manual workaround for exactly this default.

Mutually exclusive with `body` (both together is a whole-patch REJECT, nothing written — same convention
as every other guard in `updateProjectTask`): a replace and an append are different intents and mixing
them is never correct.

DELIBERATELY UNVERSIONED — unlike a caller-authored `body` replace, an append can never destructively
clobber a concurrent edit; the worst case under a race is two sections landing in a nondeterministic
order, never data loss (the same reasoning `bodyFoldPatch` relies on for its own additive write). The
version used for the actual write is computed from a fresh read taken immediately before appending, not
from the caller.

This does NOT disable the destructive-truncation guard: the computed body still flows through `patch.body`
and the ordinary guard, so a BUGGY append implementation that somehow shrinks the body is still caught —
a guard that can never fire on a correct append costs nothing, and removing it would blind the exact case
it exists for.

## Do not

- Do not let a caller pass both `body` and `appendBody` in the same patch — reject the whole patch, write
  nothing.
- Do not require `baseVersion` for `appendBody` — an append can't destructively clobber a concurrent edit
  the way a `body` replace can.
- Do not remove the destructive-truncation guard from the append path on the theory that "a correct
  append can't shrink the body" — the guard is what catches it if that assumption is ever wrong.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`updateProjectTask`'s `appendBody` param doc, lines
1134-1148 as of this tranche's HEAD).
