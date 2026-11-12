# 7c1d6dbf — the vault auto-commit exemption is an explicit human-only list, never layout inference

Card `7c1d6dbf`, split from `a09b81a0`. `a09b81a0` exempted a repo from the vault auto-commit code-repo-collision refusal when it was "some project's vault root", inferred from layout (another project's `vaultPath` lives inside it). Round-3 review proved that gameable: any project Q pointing its `vaultPath` inside a code repo C made C "exempt", and the auto-committer committed C's source. Owner answered request `f7cc5951` with option B: a human-only platform list of shared vault roots.

## The design

- `PlatformConfig.sharedVaultRoots: string[]` (default `[]`), HUMAN-only: present only in the platform override/patch schemas (`mcp/platform.ts`), written only by the human REST `PATCH /api/platform/config` (and the one-shot seed). No agent MCP tool calls `db.setPlatformConfig`; the agent and elevated-Lead project-config validators reject the key. Agents may READ it through `platform_config_get` (host-path data, same class as `obsidian.path`).
- ONE exported predicate, `isSharedVaultRoot` (`vault/shared-roots.ts`): the governing root must EQUAL a listed entry. A listed root vouches for itself only, never a subfolder, never a parent. Later cards (`c24dfd28`, `f098fbd9`) reuse it.
- Canonicalization is by realpath (case, junction, `\\?\`, trailing slash) on both sides.
- `versioner.ts`'s `isRecognizedVaultRoot` now just calls the predicate with the live list (provider `sharedVaultRoots()`), so a Settings edit applies to the next commit. Empty/unwired list means no exemption.
- A one-shot boot seed (`vault/shared-roots-seed.ts`) preserves the existing shared vault across the switch. The layout inference lives only there.

## Do not

- Do not reintroduce layout inference (a `vaultPath` at-or-under the root, self-exclusion, "some project's vault") as a runtime exemption, even narrowed. It is the hole this card removed.
- Do not canonicalize a list entry with `canonicalRepoLockKey`: it keys on the git TOPLEVEL, so a listed subfolder of a code repo would key to the whole repo and exempt it. Use `canonicalSharedRootKey` (realpath only).
- Do not match at-or-under or parent-of; equality only.
- Do not add `sharedVaultRoots` to any agent-facing schema, agent MCP tool, or `HUMAN_ONLY` bypass. `shared-vault-roots.mjs` pins the writer set and the router mentions.
- Do not hardcode a vault path in the seed (the repo is public). Do not leave the seed marker unstamped after a `none`/`ambiguous` evaluation (it must be a true one-shot; only a corrupt config row skips without stamping). Never overwrite a non-empty owner list or a corrupt config blob.
- Do not count projects instead of DISTINCT canonical vault paths in the seed (reserved homes duplicate rows over one path), and do not let a reserved row be a candidate voucher.
- Do not disqualify a root merely because a non-vaultOnly project's repo is the root: a "notes-repo" project (repo = root, vault inside it) is the real shape. Disqualify only a non-archived, non-vaultOnly project whose code is governed by the root while its own vault is NOT (or is empty).

## Seed rule and its residual

Candidates: git roots governing the vaultPaths of non-archived, non-reserved projects, needing >=2 distinct canonical vault paths. A root is disqualified by any project (archived INCLUDED, fail-closed like the guard's snapshot) that is non-vaultOnly, has code governed by the root, and whose own vault is not governed by it (or is empty). Seed only when exactly one root qualifies.

The seed is a TRUE one-shot: the `app_meta` marker is stamped after the FIRST evaluation of ANY outcome (seeded, none, ambiguous, owner-list-present). `none`/`ambiguous` write nothing and log loudly at boot; the owner adds roots in Settings. The only non-stamping outcome is a CORRUPT `platform_config` row (it exists but does not parse): nothing is written over it and the seed retries once the human fixes the config. A seed that re-ran on later boots would keep layout inference armed forever, which Do-not #1 forbids.

Residual (accepted, first-boot only): the rule cannot tell a real notes-repo project from a pre-planted notes-repo-shaped one (a code repo C plus a project with repo = C and vault inside C, and a second vault inside C), so on the FIRST boot after upgrade it could be fooled into seeding C. It never runs again after that boot; the seeded value is shown in Settings and the platform-config change history (actor `migration:7c1d6dbf`), and the owner can edit or clear it.

`isRecognizedVaultRoot` additionally requires the commitPath to be its own walked git toplevel before consulting the list, so a listed SUBFOLDER used as the rev-parse-failure fallback commitPath never matches.
