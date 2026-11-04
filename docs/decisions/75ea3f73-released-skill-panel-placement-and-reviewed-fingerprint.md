# 75ea3f73 — the released-skill panel: where it lives, and why it sends the REVIEWED fingerprint

Surfaces card `8b38b920`'s three human-only REST routes to a human. That card deliberately shipped
daemon + REST only ("No MCP tool, no web panel — both are named follow-up cards"); this is the web half.

## Why project Settings, and not the Skills page

The Skills page (`/actors?tab=skills`) reads the **daemon-global store** (`GET /api/skills`,
`<LOOM_HOME>/skills/**`). It has no project dimension at all — no project id anywhere in its reads or
writes, and no project picker. Released records are the opposite: they are keyed to ONE project's
`repoPath`, and all three routes are `/api/projects/:id/skills/...`. Putting the panel there would mean
inventing a project selector for a page whose every other control is project-agnostic, and giving a
reader two different meanings of "which skill" on one screen.

Settings already has the rule that answers this, and it is not a judgement call: decision record
`595e2a47` fixes a section's `scope` as **the API call its own component MAKES**, never what its title
suggests. These are project calls, so the row is `scope: "project"`. Three consequences fall out of
using the existing `SETTINGS_SECTIONS` array rather than a bespoke mount:

- It renders on the Atlas project Settings node (the card's own suggestion) **and** on the classic
  Settings page, from one declaration — no `atlasOnly`, no second implementation.
- `e2e/atlas-settings-scope.spec.ts` parses that array out of the real source and sweeps EVERY row onto
  exactly one Atlas node, so the placement is asserted by an existing test the moment the row exists.
- The Overview board embed is untouched, as the card required.

Declaration position is immediately after `project-lifecycle` and before the daemon-global rows: it is
project-scoped housekeeping, and the classic page renders in declaration order, so it reads next to the
other project-scoped sections rather than among the workspace ones.

## The reviewed-fingerprint contract

`POST .../readopt` requires the `fingerprint` the caller was shown, and `reAdoptReleasedSkill` refuses
(`"fingerprint-mismatch"`, REST 409) when the on-disk copy has changed since. That guard only works if
the UI sends the fingerprint belonging to the content it actually rendered.

So `ReleasedDiff` copies the diff response into a `reviewed` state snapshot and the mutation reads
`reviewed.currentFingerprint`. The diff query pins `staleTime: Infinity` + `refetchOnWindowFocus: false`,
and `Re-read the copy` is the only path that advances the snapshot. A react-query default (window-focus
refetch) would otherwise swap the fingerprint under the content on screen: the human would review one
snapshot while the click vouched for another — turning a guard that REPORTS a concurrent hand edit into
one that silently launders it.

## Do not

- Do not read the fingerprint from the query cache (or refetch it) at click time, and do not drop the
  diff query's `staleTime: Infinity` / `refetchOnWindowFocus: false` pins. Either change makes the POST
  vouch for content the human never saw, which is exactly the overwrite card `8b38b920` built the
  fingerprint parameter to prevent. The `reviewed` snapshot is the mechanism, not a convenience.
- Do not render the re-adopt button as a sibling of the list row. It lives INSIDE the expanded diff
  body, so looking at what will be overwritten is structurally a precondition for overwriting it —
  the same rule card `c01fd791` established for the Skills page's own per-file discard.
- Do not word `abandoned` as an edit, or fold it into `modified`'s gloss. Card `8b38b920` made it a
  distinct reason precisely because the content may be byte-identical to what Loom placed; calling it a
  change sends a reader hunting for a diff that does not exist.
- Do not fold `tracked: "unknown"` into the `"tracked"` wording. "Has a git-tracked file" is a FALSE
  claim about a check that never completed — the daemon tri-stated this on purpose (that card's fix
  round 2), and the panel's own pre-click warning has to keep the two apart for the same reason.
- Do not switch exhaustively on `reason` in the UI. `releaseReasonGloss`/`releaseReasonTone` fall back
  for an unknown value so a reason added daemon-side renders (generically) instead of blanking the
  panel or crashing it.
- Do not decide "this project has nothing released" from the list response. A project with no
  `repoPath` has no doctrine dir and ALWAYS answers `{released:[]}`, indistinguishable from a healthy
  empty list; the panel reads `project.repoPath` for that case, which is the only place the difference
  exists.
- Do not drop `meta: { inlineError: true }` from the readopt mutation. `main.tsx` installs a global
  `MutationCache.onError` that `window.alert()`s every unhandled mutation failure, so without it each
  refusal renders inline AND pops a blocking modal over the diff it refers to.

## Changed by looking at it (the eyeball pass), not by reading the code

Five things only a rendered screenshot showed, each now fixed — recorded because the first three are
easy to regress and none of them would fail a test:

1. **A long skill name was CLIPPED off the row at 390px** — the name span carried `flexShrink: 0`. It
   now wraps (`wordBreak: "break-all"`, `minWidth: 0`), for the same reason the node_modules reclaim
   panel wraps a full worktree path rather than truncating it: the name is the identifier that tells a
   reader which copy this row is.
2. **The header control said "Re-read the copy" while the server's own refusal says "re-open the diff
   and try again"** (shown verbatim). A reader told to re-open the diff must find a control with that
   name; it is now "Re-open the diff", and the same action is rendered INSIDE the error box, where a
   reader who just read the message is actually looking.
3. **A refusal left the confirm armed**, stacking a red "this was refused" box directly above a red
   "Replace this copy" button — which, for the commonest refusal (a stale fingerprint), would re-send
   the SAME reviewed fingerprint and fail identically. `onError` now disarms the confirm.
4. **The confirm was amber with a `primary` button.** It is now red with a `danger` one, matching the
   reclaim panel's treatment of an irreversible local write — which this is: in the `modified` case the
   content being replaced is a hand edit in no commit, since a git-tracked copy is refused outright.
5. Grammar and width: "The 1 file above **are** overwritten", and a button labelled
   `Re-adopt <40-char-name>`. The buttons are now "Re-adopt this copy" / "Replace this copy"; the name
   is already stated in the row header and in the confirm sentence.

### Do not (from that pass)
- Do not re-arm the confirm on a refusal, and do not reword the header control away from the server's
  own "re-open the diff" phrasing — items 2 and 3 are a matched pair: the message tells the reader what
  to do, and the UI has to offer exactly that, once.
- Do not give the row's name span a fixed or non-shrinking width again.

## Reuse, not a second diff renderer

`LineDiff` and its LCS (`diffLines`/`collapse`) were private to `pages/Skills.tsx`. They moved
unchanged to `components/LineDiff.tsx` + `lib/lineDiff.ts` so both the Skills page's per-file compare
view and this panel render a diff through ONE component. `lib/lineDiff.ts` is a `.ts` module
deliberately: `test/lineDiff.mjs` imports it under Node's type stripping, which cannot load a `.tsx`
page. Nothing about the algorithm or the rendering changed in the move — `test/lineDiff.mjs` pins the
behaviour so a later edit to either half is a visible one.
