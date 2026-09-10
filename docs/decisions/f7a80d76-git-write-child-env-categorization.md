# f7a80d76 — git-write child env: STRIPPED vs PASSED-THROUGH categorization

## Narrative

`GitWriter`'s child env for every git write is the inherited env (git needs PATH/HOME/etc.) minus a
strip list, plus the non-interactive overrides. Every var in scope is sorted by a two-part test: (1)
could a real host/session ambiently carry it, and (2) would any op in this file (log/branches/show/
checkout/commit/push — all captured stdio, never a real TTY) ever legitimately need it.

**STRIPPED — delegated to `git/bounded.ts`'s `scrubGitEnv`, since both tests say yes:**
GIT_EDITOR/GIT_SEQUENCE_EDITOR (no op here opens an editor; commit uses `-m`), EDITOR (the bare,
non-`GIT_`-prefixed form — a very common ambient shell export missed by the original two-key strip),
GIT_PAGER/PAGER (card 42544916: proved every git read/write 500s once either is set — this repo's own
worker/session spawn recipe sets both, see root `CLAUDE.md`; none of these ops ever page, piped stdio
not a TTY), GIT_EXTERNAL_DIFF (`show()`'s diff output must stay git's own parseable format, not an
arbitrary external tool's).

**PASSED THROUGH, EXPLICITLY ALLOWED (DoD-2 of this card, fixing M2 — this used to leave these
unhandled, which meant an ambient one made every git write throw):** GIT_CONFIG_GLOBAL /
GIT_CONFIG_SYSTEM / GIT_CONFIG / GIT_EXEC_PATH / PREFIX — one simple-git category
(`allowUnsafeConfigPaths`), applied at `boundedSimpleGit`'s construction chokepoint rather than
per-file, so `git/writer.ts` and `runs/snapshot.ts` can't drift from the same decision independently.
NOT stripped: card 54b839c5 (`vault/versioner.ts`) shows blind-stripping this family silently redirects
identity resolution to the host's real `~/.gitconfig` instead of failing loud — the same risk applies
here, so pass-through + explicit allowance is the correct fix, not removal.

## Do not

- Do not blanket-strip GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_CONFIG/GIT_EXEC_PATH/PREFIX — that
  silently redirects identity resolution to the host's real `~/.gitconfig` (card 54b839c5's finding),
  not a safe default.
- Do not re-add GIT_PAGER/PAGER to the child env — proved (card 42544916) to 500 every git read/write.
