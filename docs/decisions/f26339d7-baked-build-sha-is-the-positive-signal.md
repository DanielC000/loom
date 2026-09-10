# f26339d7 — the baked build sha is the missing POSITIVE signal; split into dist/process fields (Amendment 1)

## Narrative

Every other signal in this module is DERIVED (clocks + a live git read), so a single fault class — a turbo cache-replay that advances dist's mtime without rebuilding from current source (the `aad5fff3` footgun documented in this repo's `CLAUDE.md`) — can make every one of them agree, and all be wrong at once. `distBuiltSha`/`processBuiltSha` are the missing POSITIVE signal: the actual `git rev-parse HEAD` an artifact was compiled from, baked into `dist/build-info.json` at BUILD time by `scripts/write-build-info.mjs` (never at runtime).

## Amendment 1 — a per-process cache is a race, not a baked signal

An earlier draft had ONE cached `builtSha` field, read once per dist dir and frozen. That was wrong for a subtle reason: a per-process/per-distDir cache is "read once at FIRST USE", not "read once at PROCESS START" — if the first call into this module happens to land AFTER a rebuild landed on disk (a real, if narrow, window), the cache poisons itself with the NEW sha even though the process has been running the OLD code the whole time, permanently. A value that can be wrong depending on WHEN it happens to be first read is not a baked signal, it is a race.

The fix: split "what's on disk" from "what this process is running" into two fields with two different lifetimes — `distBuiltSha` (a fresh read on every call, answers "what's on disk right now") and `processBuiltSha` (captured EXACTLY ONCE, at PROCESS START, by the caller — `served-status.ts`'s own top-level capture — and threaded in via an option; this module stays pure and never reads or caches it itself, which keeps the existing `distDir` test seam testing it trivially, with no module-level state of its own to reset between test sections).

They are deliberately allowed to diverge: `distBuiltShaDiffersFromProcess` is the content-based, direct answer to "has a rebuild landed that this process hasn't picked up yet"; `deploySignatureMismatch` is fed from `processBuiltSha` specifically (not `distBuiltSha`) because the question it answers is "what is THIS PROCESS running" — the two diverge only in the "process is currently running old code, on-disk already has the fix" case, where `processBuiltSha` is the honest one to ask.

## Do not

- Do not cache `processBuiltSha` inside this module itself, "read once at first use" — that reintroduces the exact race Amendment 1 fixed. It must be captured once at process START by the caller and passed in.
- Do not feed `deploySignatureMismatch` from `distBuiltSha` — it must read `processBuiltSha`, the honest answer to "what is this process running".

## Source

Inline module-doc comment in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
