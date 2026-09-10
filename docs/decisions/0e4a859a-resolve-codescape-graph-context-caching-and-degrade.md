# 0e4a859a — TWO decisions, one card id: graph-context caching, and the prompt-block asset location

This record anchors TWO distinct decisions from the same card, at two unrelated sites, merged into one
record because they share a card id (`resolveRecord`'s `.sort()[0]` over candidate filenames means a
second `0e4a859a-*.md` file would silently shadow one of these two decisions rather than adding to them).

## Decision A: graph-context resolution — cached project-id resolver, uncached freshness stamp

### Narrative

`resolveCodescapeGraphContext` resolves whether THIS host is actually serving a codescape graph for a project. `resolveProjectId` is this supervisor instance's own cached resolver (registration cache first, manifest fallback) — the SAME one `pty/host.ts` uses for the real mount, so this check can never diverge from what actually gets mounted. The freshness stamp (`resolveCodescapeLastIngested`) is a SEPARATE, uncached manifest read (cheap) that only runs once an id has already resolved, so a transient stamp-read hiccup degrades to an unstamped block rather than hiding the whole thing.

Card `badba5a8` changed this to a DISCRIMINATED result (`ok:true|false` instead of `{...}|undefined`) — same four conditions, same order, gate behavior unchanged — so `resolveCodescapeInjectionStatus` (and, via it, `resolveCodescapeBlockText`) can record WHICH condition failed rather than a bare miss. See `docs/decisions/badba5a8-codescape-injection-status-is-pure-and-unit-testable-without-the-real-asset.md` for the composition this result feeds.

### Do not

- Do not let this check diverge from the gate `codescapeHttpMcpServer` uses to decide whether to mount the MCP itself — it must stay presence-gated on purpose (codescape is a private product); see the guard left inline at the source for the full four-condition list.
- Do not make the freshness-stamp read block or fail the whole gate on a transient hiccup — it degrades to an unstamped block, never a hidden feature.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`resolveCodescapeGraphContext`'s doc): originally lines 2242-2258, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped. The privacy/presence-gate guard sentence stays inline at the source (class-A, compressed) — only the caching/freshness rationale and the badba5a8 cross-reference moved here.

## Decision B: the codescape discovery block's prose lives in a dev-only asset file, not `skill-fragments/` (unrelated decision, same card id)

### Narrative

The codescape discovery block's PROSE TEXT lives as a dev-only asset file — NOT a source string literal — inside the `codescape` skill dir (`assets/skills/codescape/prompt-block.md`), never under `skill-fragments/` (which ships to every user). `codescape/` is one of `DEV_ONLY_SKILLS` (`curate-release-skills.mjs`) and is entirely omitted from a published `loomctl` release, exactly like that dir's own `SKILL.md` — the same privacy posture the codescape-privacy-guard test (card `f3ce53f1`) already enforces for that dir. Read live from the package dir at manager/worker spawn time (`sessions/service.ts`'s `resolveCodescapeBlockText`); a missing/unreadable file (every non-dev, non-self-host build, where this dir was curated out) degrades to no block — never a fallback string embedded in source, which would defeat the whole point of moving it here.

### Do not

- Do not embed the discovery block's prose as a fallback string literal in source — a missing/unreadable asset file must degrade to no block, never to an embedded copy that would defeat the whole point of keeping the prose out of a shipped build.
- Do not move this asset under `skill-fragments/` — that dir ships to every user, unlike the dev-only `codescape/` skill dir.
- Do not change `prompt-block.md`'s own TEXT without recording a change boundary and disclosing to the Codescape peer unasked — see the standing-commitment guard left inline at the source.

### Source

Inline comment in `packages/daemon/src/paths.ts` (`CODESCAPE_PROMPT_BLOCK_ASSET`'s doc): originally lines 251-267, as of this tranche's HEAD (paths.ts tranche 1). Introducing commit `f41885da07def92e4cd273d093248683737a7c87` ("feat(sessions): surface codescape in manager and worker prompt blocks"). The standing-commitment guard on the asset's own TEXT stays inline at the source (class-A, compressed) — this section carries the fuller "why a separate dev-only asset file" rationale.
