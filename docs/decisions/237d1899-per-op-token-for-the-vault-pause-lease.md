# 237d1899 — Per-op token for the vault auto-commit pause lease (follow-up to 614dfbef)

## Narrative

The pause lease from card 614dfbef is NOT ref-counted — two concurrent same-repo callers (e.g. two `GitWriter` ops on one repo, reachable from the REST/Platform/companion git-write surfaces with no cross-surface mutex) can overlap. Each `pauseVaultAutoCommit` call writes a fresh random `token` into the lease file (last writer wins the `until`/`token` pair) and returns it; the caller must pass that SAME token to `resumeVaultAutoCommit` so a resume only clears the lease it actually holds — see that function's own doc for the "resume-only-if-mine" check this enables. If the op holding the CURRENT token never calls `resume` at all (e.g. it crashes), the overlapping lease isn't stuck forever — it still survives only until 614dfbef's own clamped TTL (`MAX_VAULT_PAUSE_MS`) expires, the same backstop that bounds every lease.

## Do not

- Do not let one op's `resume` clear a lease a DIFFERENT, still-running op re-paused with a new token — always resolve via the token, not by bare presence of the lease file.

## Decision B (unrelated decision, same card id, `git/writer.ts`)

**Not the same decision as above.** `GitWriter.commit()`'s oversized-staged-file handling: WARN, never
refuse or silently unstage. `vault/versioner.ts`'s `commitVault` silently unstages a staged file above
`DEFAULT_MAX_VAULT_FILE_BYTES` (~95MB) before committing — correct there because that path is fully
automatic/unattended (no human in the loop, so overriding silently is the safe default). `GitWriter.commit()`
is instead a deliberate act by a human or agent on the project's code repo — silently unstaging (or
refusing outright) would override an intent that may be entirely legitimate (a large asset the repo
genuinely wants tracked). So this path commits the file as asked, but surfaces a non-blocking `warning`
on the result when a staged file exceeds the same shared threshold — enough signal that a caller isn't
blindsided by a push later wedging on a remote's object-size limit (e.g. GitHub's 100MB hard cap),
without taking the choice out of their hands. Detection is best-effort (a stat failure just skips that
file) and never blocks the commit itself.

### Do not (this section only)

- Do not unstage or refuse an oversized staged file in `GitWriter.commit()` — warn only; this path is a
  deliberate human/agent act, unlike `commitVault`'s fully-automatic path.
