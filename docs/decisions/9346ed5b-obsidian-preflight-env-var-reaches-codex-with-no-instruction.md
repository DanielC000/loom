# 9346ed5b — codex's env carries `LOOM_OBSIDIAN_PREFLIGHT` with no instruction to run it

## Narrative

`createCodexPty` mirrors `createPty`'s own obsidian-preflight block: since card `8d828fa4` routed `createCodexPty`'s env build through the SAME shared `buildSpawnEnv` unit `createPty` uses (rather than a hand-rolled subset), `buildSpawnEnv`'s `opts.sessionEnv` merge means `LOOM_OBSIDIAN_AUTOSTART` now reaches a codex spawn's env where it previously never arrived at all. But `createCodexPty` never set the PARTNER path variable `createPty`'s own block sets — so a codex worker on an `obsidian.autoStart` project ends up with the flag SET (`LOOM_OBSIDIAN_AUTOSTART === "1"`) and the script path EMPTY (`LOOM_OBSIDIAN_PREFLIGHT` unset), while the obsidian-preflight skill FRAGMENT (`OBSIDIAN_FRAGMENT_SKILLS`, `skills/inject.ts`, gated on `opts.sessionEnv` directly, independent of this env build) still instructs the agent to `node "$LOOM_OBSIDIAN_PREFLIGHT"`.

The fix sets `env.LOOM_OBSIDIAN_PREFLIGHT = ENSURE_OBSIDIAN_SCRIPT` whenever `LOOM_OBSIDIAN_AUTOSTART === "1"` and the preflight var isn't already set — additive-when-off, same as `createPty`'s own block. This closes the "flag set, path empty" half of the gap, but NOT the whole asymmetry: codex has no skill file to append the `OBSIDIAN_FRAGMENT_SKILLS` instruction fragment to at all (see card `7fbd1ba5`'s own record — codex gets no skill-directory injection whatsoever), so an `obsidian.autoStart` codex worker now has a correctly-populated env var but still no agent-facing instruction telling it to run the script. A known, disclosed asymmetry, not new with this card.

## Do not

- Do not read setting `LOOM_OBSIDIAN_PREFLIGHT` here as having closed the whole gap — it only fixes the env-var half; codex still gets no instruction fragment telling an agent to use it (see card `7fbd1ba5`).
- Do not hand-roll a separate env subset for codex's obsidian vars — route through the same `buildSpawnEnv` unit `createPty` uses (card `8d828fa4`), so the two harnesses' env-building logic cannot drift apart.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the JSDoc above `createCodexPty` and the inline comment on its `LOOM_OBSIDIAN_AUTOSTART` block), as of this tranche's HEAD. Relocated by card `8dcf8521` (tranche 15 on `pty/host.ts`); wording unchanged beyond joining wrapped source lines into flowing paragraphs and stripping `*`/`//` comment markers.
