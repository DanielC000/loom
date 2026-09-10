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

## `bounded.ts`: the verified full strip list + the structural scrub chokepoint

`GIT_ENV_STRIP_KEYS` (`git/bounded.ts` — the actual STRIP half `GitWriter`'s own env delegates to, per
the STRIPPED categorization above) was verified by EXECUTING `@simple-git/argv-parser@1.1.1`'s real
`parseEnv` against the installed simple-git, one key at a time — not read from docs. This is the FULL
set: a prior audit's copy of "eight keys" undercounted the real refusal list by ten (matching the M1/M2
findings above, which measured two independent per-file copies covering only 2-of-18 and 6-of-18 of it).

`boundedSimpleGit` (the construction chokepoint) applies both this scrub AND the config-path pass-through
allowance (`unsafe.allowUnsafeConfigPaths`) unconditionally to whatever raw env a caller supplies — a
caller now passes a raw env (e.g. a `process.env` spread) and gets the same safety a caller that
pre-scrubbed would have. This is what makes "the caller must remember to scrub first" (the exact failure
mode behind the M1/M2 gap above) structurally impossible going forward: `git/writer.ts` and
`runs/snapshot.ts` (which needs `GIT_INDEX_FILE`) can no longer drift from the decision independently.
`vault/versioner.ts`'s `commitVault` is the one caller that opts OUT of this scrub entirely, by design, by
never passing an `env` argument at all — see the `54b839c5` record.

The `allowUnsafeConfigPaths` allowance is a no-op (simple-git's vulnerability check never runs) for the
many callers in this codebase that never pass `env` at all — it only takes effect for a caller that
explicitly hands simple-git an env, which is exactly the population that can carry the ambient
config-path var in the first place. It does NOT widen anything else: the category covers only
config-PATH redirection, never the arbitrary-command-exec categories (editor/pager/diff/askpass/ssh/
proxy) that `GIT_ENV_STRIP_KEYS` strips or that stay deliberately blocked (see that constant's own doc
for the full breakdown).

## Do not

- Do not blanket-strip GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_CONFIG/GIT_EXEC_PATH/PREFIX — that
  silently redirects identity resolution to the host's real `~/.gitconfig` (card 54b839c5's finding),
  not a safe default.
- Do not re-add GIT_PAGER/PAGER to the child env — proved (card 42544916) to 500 every git read/write.
- Do not require a caller to scrub its own env or pass `allowUnsafeConfigPaths` itself — `boundedSimpleGit`
  applies both unconditionally at its one construction chokepoint; a per-caller copy is exactly how the
  M1/M2 gap (2-of-18 and 6-of-18 coverage) happened.
