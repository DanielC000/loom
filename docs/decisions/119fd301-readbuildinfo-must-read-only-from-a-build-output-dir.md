# 119fd301 — `readBuildInfo`'s baked file must live ONLY inside a build output dir

## Narrative

`readBuildInfo` reads `<distDir>/build-info.json` — the sha + dirty-flag `scripts/write-build-info.mjs` resolves at BUILD time. That baked file must exist ONLY inside a build OUTPUT dir (`packages/daemon/dist`, `packages/web/dist`) — NEVER anywhere a from-source run's own `__dirname` chain can reach (`src/`, the repo root).

A dev boot runs from source (`tsx watch`), so a from-source caller's `__dirname` naturally misses the file and this correctly degrades to `{sha:null, dirty:null}` — an HONEST gap, not a wrong answer.

That safety holds by STRUCTURE, not by a guard in the function body: nothing stops a future edit from breaking it — (1) making the function walk UP looking for the file, (2) writing `build-info.json` outside `dist/`, or (3) defaulting a `distDir` override to a resolved `dist` path regardless of runtime — any of which would make a from-source run silently report a STALE BAKE as if it were current: present, well-formed, and WRONG, which reads as MORE trustworthy than an honest gap.

## Do not

- Do not make `readBuildInfo` (or its caller) walk up the directory tree looking for `build-info.json`.
- Do not write `build-info.json` anywhere outside a `dist/` build output dir.
- Do not default a `distDir` override to a resolved `dist` path regardless of the actual runtime (source vs. built) — any of the three re-opens the "present, well-formed, and WRONG" failure mode this invariant exists to prevent.
- Do not make any of those three changes without re-deriving this invariant first — the safety holds by structure, not by a runtime guard, so nothing stops a future edit from silently breaking it.

## Source

Inline comment in `packages/daemon/src/deploy-staleness.ts` (`readBuildInfo`'s own doc), as of commit `7f437cda4ab4442656c935a8b2976f19bac504d9`. Relocated by card `4edb74d1` ("deploy-staleness.ts, tranche 2"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
