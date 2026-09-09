# 237d1899 — Per-op token for the vault auto-commit pause lease (follow-up to 614dfbef)

## Narrative

The pause lease from card 614dfbef is NOT ref-counted — two concurrent same-repo callers (e.g. two `GitWriter` ops on one repo, reachable from the REST/Platform/companion git-write surfaces with no cross-surface mutex) can overlap. Each `pauseVaultAutoCommit` call writes a fresh random `token` into the lease file (last writer wins the `until`/`token` pair) and returns it; the caller must pass that SAME token to `resumeVaultAutoCommit` so a resume only clears the lease it actually holds — see that function's own doc for the "resume-only-if-mine" check this enables.

## Do not

- Do not let one op's `resume` clear a lease a DIFFERENT, still-running op re-paused with a new token — always resolve via the token, not by bare presence of the lease file.
