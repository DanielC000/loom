# 4b8f2b6e — `GateRejectionDetail` lets a manager tell a real test failure apart from a teardown flake

## Narrative

Diagnostic detail for a `reason:"gate"` rejection (card 4b8f2b6e) — populated ONLY when a configured gateCommand step actually failed, so a manager can tell a real test failure apart from an fs teardown flake or a self-wiped node_modules TS2688 without re-running the gate blind. `signal`/`timedOut` are carried through (not yet acted on) so a later change (card bcba83a1) can classify an OOM/SIGKILL kill distinctly from a genuine failure.

## What the old bare string discarded, and where the detail gets enriched

Before this card, the bare "build gate failed" string discarded the failing phase/step, the first failing test/assertion, and the child process's own output — a manager burned whole cycles blind-diagnosing (a real test failure vs. an `fs.rmSync` teardown flake vs. a self-wiped `node_modules` TS2688 all looked identical from that string alone). The fix enriches BOTH the sync result AND the `[loom:merge-rejected]` signal text with the same detail, rather than only one of the two channels a manager might be reading from.

## Do not

- Do not populate `GateRejectionDetail` for anything other than a genuinely FAILED configured gateCommand step — its whole purpose is letting a manager skip re-running the gate blind to tell a real failure apart from an fs teardown flake or a self-wiped node_modules TS2688.
- Do not enrich only the sync result or only the `[loom:merge-rejected]` nudge text with this detail — both channels carry it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`GateRejectionDetail`'s top-of-type doc): part of the lines-397-426 block, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The "old bare string / where enriched" section above is from the DIAGNOSTIC DETAIL comment in `confirmWorkerMerge`'s gate-rejection branch (as of this tranche's HEAD; current line numbers, main moves under every tranche). Condensed and reworded, not verbatim.
