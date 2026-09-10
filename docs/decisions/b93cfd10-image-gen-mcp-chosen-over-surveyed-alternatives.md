# b93cfd10 — `mcp-imagenate` chosen over several other Gemini-image MCPs surveyed

## Narrative

Board card `b93cfd10` added the "image-gen" bundled capability — a plain `npx`-resolved MCP, `mcp-imagenate` (npm, MIT, github.com/mimo-3/mcp-imagenate) — as the second capability seeded generically, alongside GitHub (`3b0c4aef`).

`mcp-imagenate` was chosen over several other Gemini-image MCPs surveyed at the time, for three reasons: (a) it writes generated images to disk unconditionally (`fs.promises.writeFile`, returning file paths — never base64/URL-only in its response), which is the hard requirement for the capability to be reviewable/feedable to a separate session at all; (b) its output path is sandboxed against symlink/traversal escape when `NANO_BANANA_OUTPUT_DIR` is set, via real `fs.realpathSync` containment checks rather than a string-prefix check alone; (c) it was actively maintained (MIT, ~15 GitHub stars, ~1k npm downloads/mo, last published within the month), unlike several higher-profile-looking alternatives whose GitHub source had gone 404 or sat unstarred/templated.

(The package's separate version-pinning rationale, `MCP_IMAGENATE_VERSION` in `capabilities/seed.ts`, lives in its own doc comment at that constant and is out of this record's scope.)

## Source

Inline comment in `packages/daemon/src/capabilities/seed.ts` (module header, lines 25-33 as of commit `038426a4`). Extraction-program tranche, card `1e8c2e16`.
