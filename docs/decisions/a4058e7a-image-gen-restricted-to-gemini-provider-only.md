# a4058e7a — image-gen deliberately restricted to Gemini/Imagen, despite the package being multi-provider

## Narrative

`mcp-imagenate`, the npm package backing the "image-gen" capability (`b93cfd10`), is technically multi-provider: it also supports OpenAI and BFL FLUX image models, not only Google Gemini/Imagen. Its model registry (`initRegistry` in the package's own `providers/registry.js`) only exposes whichever providers have a configured API key.

The OWNER-DECIDED provider (card `a4058e7a`) was to inject only `GEMINI_API_KEY` into that MCP subprocess — never `OPENAI_API_KEY`, `GPT_IMAGE_API_KEY`, or `BFL_API_KEY` — making Loom's image-gen capability a pure Gemini/Imagen ("nano-banana") image generator in practice, with no code path to any other provider ever reachable from Loom.

## Do not

- Do not inject `OPENAI_API_KEY`/`GPT_IMAGE_API_KEY`/`BFL_API_KEY` alongside `GEMINI_API_KEY` for this capability without revisiting this decision — doing so reopens the multi-provider surface the package already supports, which was deliberately left unused.

## Source

Inline comment in `packages/daemon/src/capabilities/seed.ts` (module header, lines 33-38 as of commit `038426a4`). Extraction-program tranche, card `1e8c2e16`.
