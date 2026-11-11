# 3da47390 — an image-only terminal paste forwards the CLI's image-paste key, chosen from the browser's platform

An image-only paste in a Loom terminal tile used to reach the pty as an empty bracketed paste (xterm.js 5.5.0 reads only `text/plain`, and `Terminal.tsx` swallows the raw `Ctrl+V`). The CLI attaches an image by reading the HOST's OS clipboard on its own key (`ESC v` on a Windows host, `0x16` elsewhere), so a capture-phase `paste` listener now sends that key instead. Text pastes and mixed text+image clipboards are untouched. Research: `docs/investigations/7874ebfd-image-paste/README.md`.

## Why the browser's platform, not a daemon field

No existing daemon read exposes the host OS (`/api/version` returns only the version; the deploy/update/orchestration status reads carry no OS field). Same-machine is already a precondition: the CLI reads the HOST clipboard, so the feature can only work when browser and daemon share a machine, and then their platforms are equal. The helper (`lib/imagePaste.ts`) prefers `navigator.userAgentData.platform` and falls back to the deprecated `navigator.platform`.

**Rejected: add `platform` to `GET /api/version`.** Correct for every browser, but it is a daemon change during the v0.32.0 freeze, and it would only fix the remote-browser case, where raw terminal stdin is read-only anyway. No upload route either: remote/phone paste was ruled "not important right now" by the owner.

## Do not

- **Do not add a daemon/`api.ts` platform field to make this work for remote browsers.** The case it serves cannot paste into a raw terminal at all.
- **Do not widen the listener beyond image-and-no-text.** Any `text/plain` content must reach xterm's own paste handler byte-identically.
- **Do not also send the key from the `Ctrl+V` keydown handler.** That handler returns `false` on purpose so the browser fires its native `paste`; the key is sent from the `paste` event, exactly once.
