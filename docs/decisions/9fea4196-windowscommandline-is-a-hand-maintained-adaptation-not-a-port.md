# 9fea4196 — `windowsCommandLine` is a hand-maintained ADAPTATION of node-pty's quoting, not a port

## Narrative

`windowsCommandLine` (`pty/host.ts`) is a behaviourally-equivalent ADAPTATION of node-pty's own
argv→command-line quoting (its `windowsPtyAgent.ts` `argsToCommandLine`, MIT-licensed, itself documented
as following the `CommandLineToArgvW` MSDN convention) — **not a byte-for-byte port**. Measured against
node-pty@1.1.0: 935 characters from node-pty's own function vs 831 from this adaptation, source-normalised.

It covers ONLY the array-args path node-pty takes when `args` is an array, which is every call this
daemon ever makes. node-pty's `isCommandLine` branch — `args` passed as a raw STRING, handled as
`argsToCommandLine(file, []) + " " + args` with no per-character quoting/escaping at all — is
deliberately NOT implemented here; a runtime guard turns that unimplemented case into a loud, named
error instead of silently mis-quoting it. A `readonly string[]` TYPE alone doesn't protect this
function: it's exported and reachable from compiled JS, where the type has already erased, so the
array-only assumption needs a real runtime check, not just a signature.

On the array-args path, this adaptation is verified byte-identical to node-pty's real output over a
branch-derived corpus (`test/node-pty-quoting-parity.mjs`, Windows-only) — a hand-maintained copy, not
an import, precisely so a future node-pty quoting change reds that TEST instead of silently drifting.

Deliberately NOT imported from the `node-pty` package in PRODUCTION: that function lives under its
compiled `lib/` path, not the package's public entrypoint, so importing it here would pin the real spawn
path to an unsupported internal surface a future node-pty bump could silently move or change. This is
our OWN copy, used purely to COMPUTE a length — it never spawns anything itself.

## Do not

- Do not import node-pty's internal `argsToCommandLine` from its compiled `lib/` path in production —
  that surface is unsupported and a future node-pty bump could silently move or change it.
- Do not treat the TS `readonly string[]` parameter type as sufficient protection against the raw-string
  `isCommandLine` case — compiled JS has no types; the runtime guard is load-bearing.
- Do not assume this adaptation is byte-for-byte identical to node-pty's own quoting in general — it is
  verified equivalent only on the array-args path, over the corpus `test/node-pty-quoting-parity.mjs`
  exercises.

## Source

Inline doc comment above `windowsCommandLine` in `packages/daemon/src/pty/host.ts`, as of main `afce859a`.
