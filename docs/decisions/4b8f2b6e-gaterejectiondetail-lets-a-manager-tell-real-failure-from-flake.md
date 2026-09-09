# 4b8f2b6e — `GateRejectionDetail` lets a manager tell a real test failure apart from a teardown flake

## Narrative

Diagnostic detail for a `reason:"gate"` rejection (card 4b8f2b6e) — populated ONLY when a configured gateCommand step actually failed, so a manager can tell a real test failure apart from an fs teardown flake or a self-wiped node_modules TS2688 without re-running the gate blind. `signal`/`timedOut` are carried through (not yet acted on) so a later change (card bcba83a1) can classify an OOM/SIGKILL kill distinctly from a genuine failure.

## Do not

- Do not populate `GateRejectionDetail` for anything other than a genuinely FAILED configured gateCommand step — its whole purpose is letting a manager skip re-running the gate blind to tell a real failure apart from an fs teardown flake or a self-wiped node_modules TS2688.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateRejectionDetail`'s top-of-type doc): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
