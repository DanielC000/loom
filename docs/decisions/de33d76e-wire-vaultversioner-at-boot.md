# sha:de33d76e — wire `VaultVersioner` at boot

Source: commit de33d76e, no board card ("fix(vault): wire VaultVersioner at boot — agent vault doc edits currently accrue NO git history (auto-commit is dead code)").

## Narrative

`startVaultVersioners` is factored out of `index.ts` specifically so the boot wiring itself is testable. The gap this commit fixes existed precisely because `VaultVersioner` was unit-tested in isolation while never actually wired into the daemon's boot sequence — so every agent vault-doc edit accrued NO git history at all, silently: the class worked, its tests passed, and none of that mattered because nothing at boot ever called it.

## Do not

- Do not treat a class's own unit tests as proof it is live — a class can be fully covered in isolation and never reach a real boot path. Factor boot wiring into its own testable function (as `startVaultVersioners` does) rather than leaving it as an untested tail of `index.ts`.
