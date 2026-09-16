# 3fba0cd2 — `installEpipeTolerantStdio` needs BOTH the write-wrapper and the `.on("error")` listener; the listener is the one that actually fires

## Narrative

The daemon crashed twice on an `EPIPE` when its stdout pipe was severed — once from inside a live node-pty event handler, nowhere near shutdown. The crash record's stack (`Socket._write -> writeOrBuffer -> _write -> Writable.write -> console.value -> console.log`) reads as a synchronous throw escaping `console.log`, and the card that authorized this fix accepted a correction asserting exactly that: "a plain `process.stdout.on(\"error\")` listener would NOT have caught the real failure … not an async stream `\"error\"` event."

**That correction is WRONG, and was refuted by direct reproduction before this landed.** A real child process was spawned with its stdout piped, the parent destroyed the read end of that pipe immediately (`child.stdout.destroy()`), and the child then called `console.log()` in a loop. This reproduces the EXACT stack trace in the crash record, byte-for-byte, against `net.Socket`-backed stdout. The result:

- **write-wrapper alone** (`try { original(...args) } catch { … EPIPE … }` around `stream.write`): **still crashes.** `Socket.write()` does not throw synchronously here — it returns normally, and the failure surfaces later as an asynchronous `"error"` event.
- **`.on("error")` listener alone**: **survives**, all iterations complete.
- **both together** (the shipped fix): survives, same as listener-alone.

The stack frames naming `Writable.write -> console.value -> console.log` are the call stack **captured at the point Node constructs the error**, not the call stack of the eventual synchronous throw — Node defers the actual `"error"` emission to a later tick (`emitErrorNT`), and an `EventEmitter` emitting `"error"` with zero listeners is what Node treats as fatal. This is a well-known Node internals nuance that a stack trace alone does not reveal.

Code Review (independent re-derivation, confirmed the ablation above) adds: Node gives a process's stdio streams a no-op `destroy()`, so `destroyed` stays `false` forever on a severed one — every LATER write on that stream fires ANOTHER `"error"` event, which the listener swallows every time. The process therefore settles into a stable "every write on this stream fails quietly" state for the rest of its life, rather than drifting into some other failure mode after the first swallow.

## Do not

- Do not treat the `.on("error")` listener as merely theoretical "defence-in-depth" for an async case that "didn't happen" — for a `net.Socket`-backed stdout/stderr (the real shape in both production specimens), it is the ONLY one of the two guards that actually fires. The write-wrapper did not stop the reproduced crash by itself.
- Do not remove the write-wrapper on the theory that only the listener matters — a stream whose `.write()` genuinely throws synchronously (a different, untested-in-production shape) is still a real possibility this repo has not ruled out, and the wrapper is what covers it.
- Do not re-derive this from the crash record's stack trace alone — a stack trace names where an error was CONSTRUCTED, not necessarily where it was THROWN; verify with a real reproduction before trusting a stack shape to imply "synchronous throw."
- Do not widen either guard's swallow past `code === "EPIPE"`.
- Do not call `installEpipeTolerantStdio()` after `installCrashHandlers()`.

## How this was verified

Real pipe severance, not a synthetic property override: `spawn()` a child with `stdio: ["ignore", "pipe", "pipe"]`, `child.stdout.destroy()` immediately in the parent, signal the child to proceed, then have the child `console.log()` in a loop. An earlier attempt used a synthetic `process.stdout.write = () => { throw … }` override instead — that technique is a FALSE POSITIVE here: Node's global `console.log()` swallows a throw from a plain overridden `write` function unconditionally (regardless of error code), so it never reaches the wrapper's own catch at all and cannot distinguish "the fix works" from "nothing was ever tested." Only the real severed-pipe reproduction exercises the actual code path.

## Source

`packages/daemon/src/crashlog.ts`, `installEpipeTolerantStdio`. Reproduction: `packages/daemon/test/epipe-tolerant-stdio.mjs`.
