# 0e06ca9c — an owner can never CREATE a capability row at a seeded slug

## Narrative

Found by a Code Review on card `c1575ee7` (reviewer `b13ef0c5`, 2026-11-04): the seeded catalog slugs
(`"github"`, `"image-gen"`, `"shadcn"` — `capabilities/seed.ts`'s `bundledCapabilities()`) were absent
from `RESERVED_CAPABILITY_SLUGS` (`capabilities/registry.ts`). `DELETE /api/capabilities/:id` deletes a
seeded row unguarded, and `seedDefaultCapabilities` only seeds-if-absent-by-slug — so an owner could
delete a seeded row and `POST` a different provision at the exact same slug, and the catalog (and any
Profile grant already naming that slug) would silently retarget to it.

Investigation (this card) found most of the security/containment logic a seeded row's security posture
could be keyed on was already correctly keyed on `kind`/`package`, not `slug`/`name` — the github proxy-env
entitlement (`def.kind === "github-binary"`, `pty/host.ts`) and the shadcn dotenv-exfil `--import` redirect
(`provision.package === "shadcn"`, `registry.ts`'s `npm-pinned` branch) both already followed this
discipline, each citing "owner-collidable" as the reason. The one concrete exploitable channel was
`capabilityToolAllowlist` (`pty/host.ts`): it resolves a Profile's existing grant by slug against
whatever row the catalog currently has there, so a stale grant would silently inherit a swapped-in
provision's tool surface/connection requirements. The `IMAGE_GEN_DISALLOWED_TOOLS` spend-guard union
(`pty/host.ts`, keyed on the live `mcpServers["image-gen"]` mount key) was found to fail SAFE under slug
reuse (over-restricts an unrelated provision rather than under-restricting) — a separate, narrower gap
(an owner mounting the real `mcp-imagenate`/`@playwright/mcp` package under a DIFFERENT, non-reserved
slug) is card `c1575ee7`'s own scope, not this one.

## The fix

Adding the three seeded slugs to `RESERVED_CAPABILITY_SLUGS` was rejected — that list also gates (a) a
Profile capability grant naming the slug (`profiles/validate.ts`) and (b) the `buildMcpServers` mount-time
re-check (`pty/host.ts`), so widening it would make every existing `github`/`image-gen`/`shadcn` grant
invalid and stop the seeded rows from ever mounting.

Instead, a separate, narrower constant — `SEEDED_CAPABILITY_SLUGS` (`capabilities/registry.ts`), DERIVED
from `bundledCapabilities()`'s own slugs, never hand-typed — is checked ONLY at the one owner-create entry
point, `validateCapabilityDefInput`. It refuses a create at one of these slugs unconditionally, whether
or not the seeded row currently exists there. `DELETE` stays unguarded; `seedDefaultCapabilities`'s own
seed-if-absent-by-slug contract still refills a deleted seeded row on the next seed pass, since the slug
is never left occupied by anything else for Loom's own seed to see as "already taken."

## Consequence: closes the boot-migration lookalike gap too

`migrateGithubCapabilityToBinary`/`migrateImageGenCapabilityToNpmPinned` (`seed.ts`) narrow-match a row's
exact `kind`+`provisionJson` shape at the seeded slug. Before this card, an owner could type a `"bundled"`/
`"command"` row that exactly reproduced the legacy npx shape these migrations look for (both kinds are
owner-creatable), and the next boot would silently rewrite it. After this card, an owner can never create
ANY row at these slugs again — so this path is closed as a direct consequence of the create-time refusal
above, not by a separate migration change. No migration code was touched.

## Do not

- Do not fold `SEEDED_CAPABILITY_SLUGS` into `RESERVED_CAPABILITY_SLUGS` — the latter also gates a Profile
  grant and the mount-time re-check; doing so would invalidate every existing seeded-capability grant and
  stop the seeded rows from mounting at all.
- Do not hand-type `SEEDED_CAPABILITY_SLUGS` — derive it from `bundledCapabilities()` so it can never drift
  from the real seed list.
- Do not guard `deleteCapabilityDef`/`DELETE /api/capabilities/:id` — delete is intentionally still
  unguarded; only CREATE at a seeded slug is refused.
- Do not assume this closes `c1575ee7`'s gap (an owner-authored row running the real `mcp-imagenate`/
  `@playwright/mcp` package under a DIFFERENT, non-reserved slug) — that is the orthogonal "different
  slug, same dangerous package" problem; this card closes "same slug, different/dangerous provision."
- Do not re-litigate the github/shadcn kind/package-keyed hardening as still needed only because of slug
  collision — it was already correct defense-in-depth before this card and stays so for every slug other
  than these three seeded ones.
