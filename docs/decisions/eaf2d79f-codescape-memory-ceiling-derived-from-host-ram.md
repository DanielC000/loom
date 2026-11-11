# eaf2d79f — the codescape serve memory-ceiling default is derived from host RAM

## Decision

With no human override, the supervised `codescape serve` memory ceiling is `clamp(round(0.25 × host RAM in MB), 2048, 8192)`. 16 GB gives 4096, 8 GB gives 2048 (floor), 32 GB and up gives 8192 (the old fixed default, now the cap). An explicit `integrations.codescape.memoryCeilingMb` keeps priority (still floored at 2048). The value is re-evaluated on every sample tick, as before.

Why: on a 16 GB host a fixed 8 GiB ceiling is half of RAM and never fires; serve was measured at 3.6 GB private with 680 MB free. A healthy serve is about 1.2 GB, so 25% on 16 GB leaves about 3x headroom without flapping, while the cap keeps owner-approved behaviour on big hosts.

`PATCH /api/platform/config` merges `integrations` two levels deep (integration, then field; `null` deletes), so a body with only `memoryCeilingMb` no longer drops `codescape.path`. This extends [[ba9ccd75]] (`docs/decisions/ba9ccd75-platform-config-patch-deep-merge-groups.md`): `integrations` is nested one level deeper than its groups, so adding it to `DEEP_MERGE_GROUPS` alone would still replace `codescape` wholesale. Consequence: a submitted `codescape:{}` no longer clears `path`; the PATCH schema makes each `integrations.codescape` field nullable, so `{codescape:{path:null}}` clears it (Settings no longer emits `integrations`, so nothing relied on the old wholesale replace). Refusing the PATCH was rejected because the owner's one-line PATCH is the only way to set the knob (card 503a30a0 keeps Codescape out of Settings).

## Do not

- Do not import `node:os` into `packages/shared`; it is bundled into the web package. The daemon passes `os.totalmem()` into `resolveCodescapeMemoryCeilingMb` / `defaultCodescapeMemoryCeilingMb`.
- Do not make `DEFAULT_CODESCAPE_MEMORY_CEILING_MB` a fixed default again; it is the cap of the derived value.
- Do not shallow-merge `integrations` in the PATCH handler; a partial `codescape` body would silently wipe `path`.
- Do not add a Codescape row to Settings (card 503a30a0).
