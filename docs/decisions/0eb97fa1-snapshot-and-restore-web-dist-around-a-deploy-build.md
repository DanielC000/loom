# 0eb97fa1 — snapshot + restore `packages/web/dist` around the deploy build's "build" step

## Narrative

Card 0eb97fa1 (done, merged `7f76188`): a consequence of card `61fa0950`'s fix, spotted by the manager at the merge gate — not a defect in that fix, but a new failure mode it introduced. `61fa0950` added a `clean` turbo task (`cache: false`) as a dependency of `build`, so `packages/web/dist` is wiped before EITHER a real build or a cache-hit restore — the correct and only place to fix `61fa0950`'s own orphaned-bundle bug, since a cache restore skips the build script entirely.

The new failure mode: previously, a failed build left the PREVIOUS `dist` intact and the daemon kept serving the last good bundle. After `61fa0950`, `clean` unconditionally wipes `dist`, the build then fails (typecheck error, test failure, OOM…), `dist` is left empty, and the daemon stays up (`daemon_restart` deliberately does not restart on a failed build — "stays up, fix it and retry") — now serving a wiped `dist`. A failed deploy degrades from "still serving the old UI" to "serving a broken/404 UI"; only the web viewport breaks, the daemon's REST/MCP surfaces are unaffected. Recovery is trivial (re-run `pnpm build`, or fix and re-deploy) but the operator has to know to do it — the symptom (blank/404 web UI, daemon otherwise healthy) doesn't obviously point at "your build failed and wiped dist."

Card `0eb97fa1` considered four options (accept + document; build into a temp dir and swap on success; snapshot/restore `dist` around the deploy build specifically; pre-flight the build before cleaning on the deploy path only) and its own recommendation was "(1) accept + document, for now." **What actually got built is option 3** — `snapshotWebDist`/`restoreWebDist` in `orchestration/restart.ts`, localised to the deploy path where a live daemon is actually serving the bundle.

**INTERRUPTED-DEPLOY CASE:** if the daemon process dies mid-build (after `snapshotWebDist`'s snapshot is taken but before the matching restore/discard in `buildDaemon` runs), the backup is simply left on disk. This is not a growing leak: `snapshotWebDist`'s first line unconditionally clears any existing backup before taking a new one, so the very next deploy attempt that reaches the build step overwrites the orphan with a fresh snapshot. Worst case is one extra dist-sized copy sitting under `LOOM_HOME` until then — never served, never user-visible, never accumulating. A crash between the wipe and a restore does mean the UI stays broken until that next deploy attempt (successful or not) resolves it; that gap needs a human to notice the crash and re-run the supervisor regardless (see `CLAUDE.md`'s self-hosting section), so it isn't made worse by this design.

## Do not

- Do NOT "fix" a build failure wiping the served UI by removing or weakening turbo's `clean` task — it exists to close a confirmed end-user-reachable leak vector (`61fa0950`, and the published-package audit `ffe0a82d` that followed from it). Serving a stale/orphaned bundle is strictly worse than serving none.
- Do NOT restructure the build (a temp-dir swap) for this — the snapshot/restore pair localised to the deploy path is the chosen fix; a rare, trivially-recoverable case doesn't justify a real build restructure.

## Source

Inline JSDoc on `snapshotWebDist` in `packages/daemon/src/orchestration/restart.ts`, as of commit `779f3ce7`. Relocated by card `0a525ae1` ("restart.ts, tranche 1"); no wording changed, `*`-prefixed JSDoc lines joined into flowing paragraphs.
