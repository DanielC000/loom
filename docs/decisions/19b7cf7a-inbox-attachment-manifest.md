# 19b7cf7a — the inbox attachment manifest: what each preview mode may render, and on which origin

Card `19b7cf7a`, child 4 of epic `7d1d66ab` (the owner picked **Direction B · Manifest** on request `0bbf7d1b`). Anchored from `packages/web/src/lib/questions.ts` (`AttachmentPreviewMode`) and read by `packages/web/src/components/requests.tsx`. Builds on child `432765ab` (the attachment store + the public `QuestionAttachment` shape) and child `8f050b79` (the serving route and its CSP).

## The shape, and why it is a manifest

One dense row per file (glyph · label + size · STATE · a visible `Open ↗`), plus ONE preview pane rendering whichever row is selected. The collapsed inbox row carries a typed count chip, never a thumbnail strip. Both properties are the point of the direction the owner picked: the panel holds its shape at 2 files or 20, exactly one image decodes at a time, and the panel's height never depends on the attachment count.

`STATE` is the opened-tracking surface, legible without hovering anything: `unavailable` → `new` → `opened <age>`. It reads `openedAt`, which is stamped ONLY by `POST /api/questions/:id/attachments/:attachmentId/opened` — i.e. by the human's own `Open ↗`. **Selecting a row to preview it deliberately does not stamp it**: a 232px thumbnail is not "you looked at this", so `new` keeps meaning "you have not opened this through the real route yet". If selection stamped it, the whole column would decay to "you have scrolled past this row".

## Preview modes, origin by origin

The serving route is Tier-1 (`gateway/trust-tier.ts`): reads are ungated on loopback and **Bearer-only on a remote origin**, and a browser attaches no `Authorization` header to an `<img src>`, an `<iframe src>`, or a top-level new-tab navigation. So the mode is a function of the attachment AND the origin, not of the attachment alone.

- **`image`** — a raster image. Loopback points `<img src>` straight at the route (the browser streams it). A remote origin fetches the bytes through the api client, with the credential `withGatewayAuth` attaches, and renders an object URL — the `components/VaultAsset.tsx` precedent, reused rather than re-derived. A same-origin blob is safe here BY CONSTRUCTION: `deriveAttachmentKind` (card `432765ab`) classifies `.svg` as `kind:"other"`, server-side, at copy time, so a scriptable image can never reach this branch as `"image"` — and the blob is still minted through `viewBlobType` (`lib/vaultAsset.ts`), which refuses a scriptable type anyway. Two independent fences, deliberately, because the first one lives in a different package.

- **`html`** — a sandboxed `<iframe src>` thumbnail, **loopback only**. Pointing at the real route is what keeps the route's own `Content-Security-Policy: sandbox allow-scripts; form-action 'none'; connect-src 'none'` (decision `8f050b79`) governing the document. The `sandbox="allow-scripts"` attribute is set on the element too, as belt and braces, and `allow-same-origin` is never set — so even if the header were ever lost, the document still lands in an opaque origin with no reach into this origin's `localStorage` (where the loopback and gateway tokens live). The frame is `pointer-events: none`: it is a thumbnail, and interacting with untrusted agent-authored bytes belongs in the new tab the `Open ↗` action gives you, under the full header CSP, not inside the answer dialog.

- **`html-needs-loopback`** — the same file on a REMOTE origin, deliberately NOT rendered. An `<iframe src>` 401s there, and the only two ways to get the bytes into a frame are the two this feature refuses: a `blob:` URL inherits the APP origin (and drops the header CSP), and `srcdoc` drops the header CSP too. The pane says plainly that HTML preview needs loopback access. A frame that silently failed to load would be worse than an honest refusal — it reads as "the mockup is broken", not "your origin can't fetch it".

- **`download`** — `kind:"other"`, which the route serves `Content-Disposition: attachment`. Nothing renders inline; the pane shows the kind plate and says it downloads on open.

- **`missing`** — `available:false` (the live `fs.existsSync` in `toQuestion`). The row **stays**, struck through, with the action disabled and the reason in the pane. A removed row would silently rewrite what the agent said it sent.

## No `message` listener, on purpose

Nothing in this feature registers a `window`/`message` listener for the preview. A sandboxed document without `allow-same-origin` posts with `origin: "null"`, which cannot be meaningfully verified, so there is no listener to harden — the absence is the defence. A future "the mockup wants to tell the host something" feature must design its own trust story from scratch rather than adding a listener here.

## What this UI deliberately does not show

`QuestionAttachment` carries no path — neither the asker's original absolute path nor the store path (`toQuestion` never maps either, mirroring how it never maps `secret_blob`). The reference mockup showed a source/root line ("project vault", "worker worktree") from its own richer fixture; reproducing it would mean inventing a fact the contract does not carry, so the manifest shows label, size, dimensions and kind only.

The mockup's `Download all` and `Open all N` bulk actions are also absent: there is no archive route to serve the first, and the second would need N popup-blocked tab opens. Neither is in the card's scope list.

## The e2e seed is the one place a question id reaches the filesystem

`/internal/test/seed`'s `questions[].attachments` block (`gateway/server.ts`) writes real bytes into `questionAttachmentDir(id)` so a seeded attachment is genuinely servable. That `path.join` makes an unvalidated `questions[].id` a path-traversal **write** primitive, not merely a bad row: `id: "../x"` resolves a directory outside `<LOOM_HOME>/attachments/` and the block would `mkdirSync` + `writeFileSync` into it. Code Review found this; the route being test-mode + loopback-only is a real mitigation, but it is still the first place a seed payload hands a value to `fs`.

The id is now checked against `QUESTION_ID_RE` — the same predicate the GET/POST attachment routes use — **before any fs touch**, and unconditionally rather than only inside the attachments branch, so the one value that can reach `fs` is never gated by a narrower rule than the one that reaches the DB. A generated `randomUUID()` always matches, so no existing caller changed. Every attachment `label` is likewise validated in a pass of its own **before the first write**: the previous validate-as-you-write loop rejected a bad label at index 1 only after index 0 had already landed a real file, leaving orphans behind a request row that was never inserted.

## Do not

- Do not render an HTML attachment through a `blob:`/`srcdoc`/`data:` document, on any origin. Each drops the serving route's own CSP, and a `blob:` URL additionally inherits the app origin where the loopback/gateway tokens live.
- Do not add `allow-same-origin` to the preview iframe's `sandbox`, and do not drop the `sandbox` attribute because the route already sends the header — the attribute is the one fence that survives a header regression, and it is the only fence at all if someone later introduces a non-route document source.
- Do not add a `message` listener for the preview frame. A sandboxed document's `origin` is `"null"` and cannot be verified; the absent listener is the defence.
- Do not stamp `openedAt` on row SELECTION. Only the explicit `Open ↗` may stamp it, or the STATE column stops distinguishing "opened" from "scrolled past".
- Do not drop or hide an `available:false` row. It keeps its place, struck through, with the action disabled — removing it rewrites what the agent said it sent.
- Do not render a path/root/"where this came from" line. The public attachment shape carries no path, by design.
- Do not let the collapsed inbox row grow a thumbnail strip, or any second line, as the attachment count rises. One line at any count is the direction's own rule.
- Do not let a `questions[].id` reach `questionAttachmentDir()` in the e2e seed without passing `QUESTION_ID_RE` first, and do not narrow that check to "only when attachments are present" — it is a path-traversal write primitive, and test-mode + loopback is a mitigation, not a substitute for validating the value.
- Do not validate an attachment `label` inside the write loop. Validate every entry first, or a late rejection leaves earlier entries' files orphaned in the store under a question row that was never inserted.

Tests: `packages/web/test/questions.mjs` (the pure helpers, including both origin polarities of `attachmentPreviewMode`/`attachmentOpenRefusal`), `packages/web/e2e/requests-inbox-attachments.spec.ts` (the manifest rendered and driven against a seeded request carrying 2 html + 2 png + 1 unavailable attachment, asserting the preview iframe's `sandbox` is exactly `allow-scripts`), and `packages/daemon/test/seed-endpoint.mjs` section (c) (the seed route's id/label validation, proven RED against the pre-fix code).

The REMOTE-origin branches — the credentialed image-blob path, the html-needs-loopback note (never an iframe), and `Open ↗` disabled with a reason — are now covered end-to-end too (card `76227b26`): `packages/web/e2e/requests-inbox-attachments-remote.spec.ts`, on the same trusted-proxy rig as `vault-remote-assets.spec.ts`, seeded via the SAME `fixtures/vault-remote-seed.mjs` (extended to also stage a question + attachments at the DB level, since every write route — `/internal/test/seed` included — is Tier-0 and unreachable from that origin). Each of its four assertions was proven RED against a targeted one-line break of its own branch, then restored byte-identical, before this record was last touched.
