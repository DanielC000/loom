# a4145c7a — rebuild bare-ref-positional-argv-guard.mjs on the real TypeScript AST

## Do not

- Do not reintroduce hand-rolled bracket/quote/comment tracking in this guard. A real parser has no
  per-call quote/desync state to corrupt; if `ts.createSourceFile` cannot see a shape, that is a genuine,
  structural AST blind spot (see the guard's own "WHAT THIS GUARD DOES NOT SEE" section), not a parser bug
  to patch around with more heuristics.
- Do not reinstate the backward-char array-literal-vs-subscript heuristic or its fixed keyword list
  (the old `NON_SUBSCRIPT_KEYWORDS`/`isArrayLiteralStart`). The real parser distinguishes
  `ElementAccessExpression` from `ArrayLiteralExpression` structurally, in every syntactic position, with
  zero known exceptions — there is nothing left for a heuristic to approximate.
- Do not read the EOF canary (`CANARY_SNIPPET`) as still backstopping a quote/regex desync — that failure
  class no longer exists under a real parser. It is kept only as a cheap whole-file parse-and-scan sanity
  check (per this card's own DoD); don't read its presence as proof of anything more than that.

## Why

Card 868e0135's hand-rolled lexer went through three Code Review rounds, each finding one more hole: quote
state corrupted across lines, regex-vs-division ambiguity (an odd-backtick-count regex literal opening a
backtick-quote state that never reset at a newline, hiding the rest of the file), and keyword-context
misreads (`return [...]` etc. misclassified as subscript access, needing a growing fixed keyword list to
patch). Card a4145c7a replaced the whole lexer with `ts.createSourceFile`, walking real
`ArrayLiteralExpression` nodes, removing the bug class structurally instead of patching the next instance
of it.

The same round also closed two real coverage gaps found during the rewrite:

- `GLOBAL_OPTS_WITH_VALUE` (mirrored, by hand, from `bounded.ts`'s own set — card 62c4953a round 6) so a
  leading `-C`/`--git-dir`/etc. global option is skipped correctly when locating the subcommand — including
  the case where the option's VALUE happens to collide textually with a monitored subcommand's own name
  (the exact positional-collision shape 62c4953a round 6 fixed for `bounded.ts`'s own log redaction).
- Coverage for simple-git's typed `.revparse([...])` method, whose argv array carries no literal
  `"rev-parse"` token at all — the subcommand is implied by the method name, not by an array element — so
  the old lexer (which only ever looked for a literal subcommand string) could never have classified it.

Survey at the time of this card: no OTHER simple-git typed method (`.mergeBase`, `.lsTree`, etc.) is called
anywhere in `packages/daemon/src/git/**` with an array argument implying one of the four monitored
subcommands — only `.revparse` needed a special case. If that changes, add the new method the same way
`.revparse` was added (see `isRevparseArgArray` in the guard file).
