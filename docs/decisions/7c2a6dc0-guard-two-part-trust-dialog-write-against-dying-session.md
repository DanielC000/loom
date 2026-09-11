# 7c2a6dc0 — guard the trust-dialog two-part write against a session dying mid-write

## Narrative

Code Review audit (card `7c2a6dc0`) on the trust-dialog answer write (card `353f6dc4`'s two-part `"1"` / delay / `"\r"` split, `pty/host.ts`'s `spawnCodexProcess` onData handler): the two-part write previously had NO alive/killed guard at all. A session that died or was hard-stopped between the two writes — or during the delay between them — would still be written to: the exact `Live.killed`-documented crash risk on a destroyed `_inSocket`.

Fix: guard both writes independently (`if (live.alive && !live.killed) pty.write(...)`) rather than guarding once before the pair, since the delay between them is a real gap the session can die or be killed in.

## Second site: guarding `submitCodex`'s chunked write against a stop/redirect mid-write

Card `7c2a6dc0` (unrelated call site, same audit card): `submitCodex` captures `live.busyStaleGen` NOW, before the chunked write (card `02e42746`) even begins — not after. A `stopCodex`/`interruptForRedirectCodex` landing anywhere in the write-then-wait window — whether mid-chunk (card `02e42746` widened this window from "near-instant" to however long the chunked write takes) or in the post-write `CODEX_SUBMIT_ENTER_DELAY_MS` gap — has nothing else to `clearTimeout` for THIS turn: bumping `busyStaleGen` is the only signal either of them can leave, and comparing against it once the whole write has landed is what stops this closure writing a stray `"\r"` into a session that was deliberately stopped or redirected mid-submit (the card's own "arguably the worse half" finding, for the redirect case) — this holds regardless of how long the chunked write itself takes.

## Do not

- Do not guard the two-part trust-dialog write with a single check before both writes — the delay between them is a real window for the session to die or be killed; each write needs its own guard.
- Do not capture `busyStaleGen` only after `submitCodex`'s chunked write completes — a stop/redirect landing mid-chunk would then have nothing to compare against, and the delayed-Enter closure could write a stray `"\r"` into an already-stopped or redirected session.

## `interruptForRedirectCodex`: two separate Code Review findings on the same method

Finding 1 (a doc correction, Code Review finding 5): `interruptForRedirectCodex`'s doc previously claimed the `spawnCodexProcess` onData handler "already calls `drainCodexPending` on that edge" on "the very next output chunk" after a redirect's Ctrl+C — false. `onData` only ever ARMS the staleness timer on a marker sighting; it never drains directly, and the drain is a bounded timeout later, not an immediate edge read.

Separately, a later Code Review (post-`7c2a6dc0`, BLOCKING, reproduced with a positive control) found that `interruptForRedirectCodex` cleared the armed staleness timer unconditionally on its COMMON path (a genuinely busy turn whose own Enter had already gone out, `!live.enterPending`) as part of the same `7c2a6dc0` cleanup `stopCodex` performs. On this path that left NOTHING that would ever drain the redirect: the timer just cleared was the only thing that would have called `drainCodexPending`, `retryCodexEnter` needs a fired timer to run at all, and `submitCodex`'s own delayed closure needs a drain to even be scheduled — so `busy` stayed pinned `true` forever, the exact hang this card exists to fix, moved onto the primary path `worker_redirect` actually targets.

Fixed by re-arming a FRESH timer (a valid generation, since `busyStaleGen` was just bumped) on that COMMON path: this turn's `lastBusyMarkerAt` is already `>= enterWrittenAt` from its own earlier real confirmation, so once codex's busy marker genuinely goes stale (documented absent once idle — it stops the instant the Ctrl+C takes effect) this lands in CASE 2 and drains, exactly as it would have without this card's neutralization ever touching the timer. This also gives codex a real `CODEX_BUSY_STALE_MS` window to actually process the interrupt before anything is written into its composer, rather than a synchronous write straight after `\x03`.

## Do not (2)

- Do not trust a doc claiming the onData handler "already drains on the next chunk" after a redirect — it only ARMS the staleness timer; draining is a bounded timeout later, not an immediate edge read.
- Do not clear `interruptForRedirectCodex`'s COMMON-path staleness timer without re-arming a fresh one — with nothing left to fire, `drainCodexPending`/`retryCodexEnter`/`submitCodex`'s delayed closure all become unreachable and `busy` stays pinned true forever.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `codexTrustDialogLock.withLock` callback inside `spawnCodexProcess`'s onData handler), as of commit 624ec86b6. Extracted by card `5bf5327f` (tranche 16 on `pty/host.ts`).

A second site records the generation-capture guard on `submitCodex`'s own chunked write: `pty/host.ts`, inside `submitCodex`, immediately before the call to `writeChunkedCodex`, as of this tranche's HEAD. Extracted by card `677c79cd` (tranche 17 on `pty/host.ts`).

A third site records the `interruptForRedirectCodex` regression fix and the Code Review finding 5 correction above: `pty/host.ts`, inside `interruptForRedirectCodex`'s own method doc, as of this tranche's HEAD. Extracted by card `85b87619` (tranche 56 on `pty/host.ts`).
