# 8b13a61e — `redactedExcerpt` withholds the hash below a minimum excerpt length

## Narrative

`redactedExcerpt` (`pty/host.ts`, card `16c93a50`) is the owner-ruled chokepoint every content-bearing
diagnostic in the file routes through so raw session text never reaches the rotated, multi-tenant
`daemon-output.log`. With the flag OFF it used to emit `<redacted len=N hash=fnv1a32(x)>` unconditionally.

That guarantee silently failed for a SHORT excerpt: `fnv1a32` is a 32-bit, unsalted, PUBLIC hash, and
below roughly 4–5 printable-ASCII characters the input candidate space is small enough to brute-force in
well under a second — a hash of `"ok"` or `"yes"` discloses it about as plainly as the raw bytes would.
Every one of the function's 8 call sites in `pty/host.ts` (plus 1 in `sessions/service.ts`) slices to a
MAXIMUM length; none enforces a MINIMUM, so a short underlying message (a short reply, a code, a yes/no)
reached the log at its natural short length and got "redacted" into something still recoverable by
enumeration.

Three options were weighed (see card `8b13a61e` for the full table):
- **(a) Below a minimum length, emit `len` only, no hash.** Chosen. Simple, honest, and it only gives up
  cross-occurrence matching for excerpts short enough that the matching was never meaningfully protective
  in the first place — a hash discriminates content by definition only when its own domain is large
  enough not to be enumerable.
- **(b) Salt the hash.** Rejected for this fix: a per-daemon-run salt preserves byte-identity matching
  *within* a run but silently breaks it *across* restarts, and a fixed in-repo salt is worthless (the repo
  is public). Nothing in the doc comment currently promises a scope a salt could satisfy, and picking one
  would require deciding and documenting that scope as a separate, deliberate step — out of scope here.
- **(c) Widen the hash.** Rejected outright: the brute force is over the tiny INPUT domain, not the hash's
  OUTPUT space. A 256-bit hash of one character is exactly as recoverable as a 32-bit one.

`REDACTED_EXCERPT_MIN_HASH_LEN = 8` is a round, deliberately conservative margin above the ~4–5 char point
identified in the card's own candidate-space table (order-of-magnitude, not measured) — not a value tied
to a specific attack budget or measured brute-force benchmark. **Length is only a PROXY for entropy, not
entropy itself** — the card's own table is explicit that "with any structural prior (the value is a digit,
a yes/no, a known format) the practical bound is longer still": an 8-char all-digit excerpt has only
~10⁸ candidates (the card's own "seconds" row), so reaching the minimum length does not by itself certify
an excerpt as safe — it only rules out the *unstructured* worst case this fix targets. The flag-ON path
(`isLogMessageContentEnabled()` true) is untouched at every length — it must stay byte-identical to
`JSON.stringify(excerpt)`, the explicit pre-`16c93a50` promise in the function's own doc comment.

This changes BEHAVIOR only, inside the chokepoint — it adds and removes no call site, so
`test/log-message-content-gate.mjs`'s exact-count census (`hostCalls === 8`, `serviceCalls === 1`) is
unaffected by design.

### Do not

- Do not widen the hash itself (option c) to try to close this exposure further — it is bounded by the
  *input* domain, not the hash's *output* domain, so a wider hash of a short excerpt is exactly as
  recoverable as a narrow one.
- Do not raise `REDACTED_EXCERPT_MIN_HASH_LEN` casually "to be safer" — it is a round, deliberately
  conservative number, not derived from a measured benchmark, so there is headroom to raise it; but doing
  so trades away MORE cross-occurrence hash-matching (real diagnostic value for anything below the new
  threshold), for a length-as-entropy-proxy bound that a structured/low-entropy excerpt (see the entropy
  caveat above) does not fully back anyway — re-read this record's entropy note before changing it.
- Do not add a salt to `fnv1a32`/`redactedExcerpt` without first deciding and documenting (in this record
  and the function's own doc comment) whether the promised scope is per-run or cross-restart — a silent
  choice here would contradict the doc comment's own byte-identity claim for whichever scope isn't picked.
- Do not fix a future short-excerpt disclosure by adding per-call-site truncation/padding logic instead —
  the whole point of routing every content-bearing diagnostic through this one chokepoint (card `16c93a50`)
  is that the policy lives here, not at N call sites.

## Sources

`pty/host.ts`: `REDACTED_EXCERPT_MIN_HASH_LEN`, `redactedExcerpt`. Card `8b13a61e`, filed by lead `gen 354`
2026-09-21 while reviewing card `b1cc4f01`'s branch at the merge gate; card `16c93a50` (request `0eb43216`)
is the original owner ruling this record refines, not reopens.
