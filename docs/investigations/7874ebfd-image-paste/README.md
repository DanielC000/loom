# Pasting an image into a Loom terminal (card 7874ebfd)

Research only. No product code. Written 2026-11-11 against repo commit `ae8fa63d`, Claude Code CLI `2.1.322` on the host (`claude --version`), xterm.js `5.5.0` (`packages/web/node_modules/@xterm/xterm/package.json`). Evidence labels: **[measured]** = I ran it and saw it; **[documented]** = vendor docs/changelog say so (source given); **[inferred]** = reasoned from code or docs, not run.

## Bottom line

1. **Claude Code does not receive image bytes from the terminal.** On a keypress (`chat:imagePaste`, bound to `Alt+V` on Windows, `Ctrl+V` elsewhere) the CLI reads the OS clipboard itself. A pasted or dragged image *file path* is the other route: the terminal only sends the path as text and the CLI attaches the file. **[documented]**
2. **In a Loom terminal today, `Ctrl+V` with an image on the clipboard sends nothing useful.** Loom swallows the `Ctrl+V` keystroke, and xterm.js's paste handler reads only `text/plain`, so an image-only paste reaches the pty as an empty bracketed paste. **[measured, web side]**
3. **`Alt+V` very likely already works on the owner's Windows host.** xterm.js turns `Alt+V` into `ESC v`, Loom's key handler lets it through, and the daemon writes it to the pty unchanged. The claude it reaches runs as the same interactive Windows user as the browser, so it can read the same clipboard. The web half is **[measured]**. That claude then attaches the image is **[inferred]**, and a 30-second owner check settles it (see Experiment E1). Expect Claude Code's own Windows `Alt+V` bugs to show up here too.
4. **Recommendation:** first, run E1 (no code). If it passes, build a small **web-only** change: on a `Ctrl+V` paste whose clipboard holds an image and no text, send the CLI's image-paste key instead of an empty paste, and add a hint. That is option (a). Only build the upload route (b) if remote/phone image paste is wanted. It needs a daemon endpoint, so it has to land before the v0.32.0 daemon freeze or wait for the Rust port.

## Q1. How native Claude Code pastes an image

| Finding | Label | Source |
| --- | --- | --- |
| `Ctrl+V` (or `Cmd+V` in iTerm2), or `Alt+V` on Windows and WSL, "Paste image from clipboard", inserts an `[Image #N]` chip at the cursor. On WSL both keys are bound. | documented | https://code.claude.com/docs/en/interactive-mode (General controls), retrieved 2026-11-11 |
| The action is `chat:imagePaste`, default "Ctrl+V (Alt+V on Windows and WSL)", and can be rebound in `~/.claude/keybindings.json`. `meta` = Alt on Windows/Linux. | documented | https://code.claude.com/docs/en/keybindings, retrieved 2026-11-11 |
| Three ways to add an image: drag and drop into the window, paste with `Ctrl+V`/`Alt+V`, or give a path ("Analyze this image: /path/to/your/image.png"). | documented | https://code.claude.com/docs/en/common-workflows ("Work with images"), retrieved 2026-11-11 |
| The CLI reads the OS clipboard itself, not a byte stream from the terminal. Evidence: per-OS clipboard backends in the changelog: Windows `Alt+V` added (1.0.93), Wayland `wl-paste` fallback, WSL2 PowerShell fallback and BMP support, and "pasting an image over SSH to a Linux machine doing nothing silently; the prompt now says to copy the file over and paste its path" (2.1.314). A terminal-transmitted image would work over SSH, so that failure only makes sense if the CLI reads its own host's clipboard. | documented (changelog), inference on mechanism | `CHANGELOG.md` in `anthropics/claude-code` (raw, fetched 2026-11-11), entries under 1.0.93, 2.1.141, 2.1.157, 2.1.314 |
| No OSC 52 / sixel / kitty-graphics *input* path for images is documented. OSC 52 appears only for clipboard *writes* (copy), and was replaced by PowerShell interop on WSL. | documented (absence in docs and changelog; not proof of absence in code) | same changelog: "copy-on-select … now uses PowerShell interop instead of OSC 52" |
| Pasting or dragging an image **path** attaches the image: "Read deny rules not applying to image paths pasted or dragged into the prompt" (2.1.290) and "Fixed pasting text that *mentions* an image file … attaching the image and dropping its path" (2.1.311). So a paste that *is* a path attaches, and a path inside other text no longer does. Terminal drag-and-drop is the terminal pasting the dropped file's path. | documented (changelog) | `CHANGELOG.md` 2.1.290, 2.1.311, 2.1.157 ("added support for dragging images from Windows Explorer") |
| Pasted images are saved to disk where Claude can open them as files (2.1.275) and downscaled over 2000px. | documented | `CHANGELOG.md` 2.1.275 and the "larger than 2000px" entry |
| **Windows reliability is mixed.** Open third-party reports from mid-2026 describe `Alt+V` failing ("no image found", first press fails, clipboard wiped on failure), and one on 2.1.251. These are user reports, not vendor statements. | contested / uncertain | e.g. https://claudeissues.com/issue/90657-bug-windows-clipboard-image-paste-broken-in-v2-1-251-no-image-found-in-clipboard, https://claudeissues.com/issue/61883-bug-alt-v-on-windows-wipes-clipboard-contents-when-image-paste-fails-data-loss-n (mirrors of GitHub issues; retrieved 2026-11-11) |

Codex (for comparison, low confidence): third-party sources say the Codex TUI also reads the clipboard on `Ctrl+V` (native Windows support added around Dec 2025) and accepts dragged files. I found no first-party doc in this pass. **[uncertain]**

## Q2. What happens today in a Loom terminal

### The path

- Web: `packages/web/src/components/Terminal.tsx:172-191`: `attachCustomKeyEventHandler` returns `false` for `Ctrl/Cmd+V`. That drops xterm's raw `0x16` but lets the browser fire its native `paste` event. `Alt` is **not** in the `mod` test (`e.ctrlKey || e.metaKey`), so `Alt+V` goes through xterm's normal key handling.
- xterm.js 5.5.0 `src/browser/Clipboard.ts:43-49`: `handlePasteEvent` reads `ev.clipboardData.getData('text/plain')` **only**, then wraps it in `ESC[200~ … ESC[201~` when the app turned on bracketed paste.
- xterm.js `src/common/input/Keyboard.ts:349-360`: on a non-Mac platform, `Alt+<letter>` becomes `ESC` + the letter.
- Web → WS: `Terminal.tsx:531-537` sends `{type:"stdin", data}` for every `onData`.
- Daemon: `packages/daemon/src/gateway/server.ts:7865-7870` passes `msg.data` to `pty.writeStdin` (not for `role:"assistant"`). A **remote** (non-loopback) peer gets a `readOnly` frame and its stdin is dropped (`server.ts:7811` and the `Terminal.tsx:43-46` header).
- `packages/daemon/src/pty/host.ts:15068`: `writeStdin` → `writeChunked`, a raw passthrough with no transformation. Codex sessions take `writeStdinCodex`, also a raw passthrough.

### Measured (web side)

Method: a throwaway page loading the repo's own `@xterm/xterm/lib/xterm.js` 5.5.0, with Loom's exact `attachCustomKeyEventHandler` logic copied in and `ESC[?2004h` written so bracketed paste is on (claude's TUI turns it on). Run in headless Chromium 157 via Playwright on this Windows host (`navigator.platform` = `Win32`), 2026-11-11. Every `onData` payload was recorded. One trial per case. The logic is deterministic, but this is a copy of the handler, not the real Loom page.

| Input | What `onData` emitted (= what Loom would write to the pty) |
| --- | --- |
| `Alt+V` keypress | `"\u001bv"` (ESC v) |
| `Ctrl+V` keypress (headless clipboard empty) | `"\u001b[200~\u001b[201~"`: the keystroke is swallowed and the native paste delivers an empty bracketed paste |
| synthetic `paste` event whose clipboard holds only an `image/png` file | `"\u001b[200~\u001b[201~"`: empty; the image bytes are dropped |
| synthetic `paste` with `text/plain` = `C:\x\shot.png` | `"\u001b[200~C:\\x\\shot.png\u001b[201~"` |
| synthetic `drop` of an image file on `.xterm` | nothing emitted, and the event was not cancelled (xterm has no drop handler) |

Not measured: real Chrome with a real OS clipboard (headless can't hold a real image clipboard), and any claude process (⛔ not launched, per the card).

### What this means

- **`Ctrl+V` + image: nothing reaches claude except an empty paste.** [measured web side]. What claude does with an empty bracketed paste is not documented. **[uncertain]**
- **`Alt+V` + image: `ESC v` reaches claude**, which is the meta-v encoding of its Windows `chat:imagePaste` default. [measured web side]. In Windows Terminal, `Alt+V` sends the same `ESC v` bytes, so claude should not be able to tell the two apart. **[inferred]** Chrome binds no `Alt+V` shortcut on Windows, and the keydown reached the page in the headless run. **[inferred for headed Chrome]**
- **Clipboard access from the Loom-spawned claude:** on Windows the packaged autostart task runs `LogonType InteractiveToken` as the logged-in user (`bin/service.mjs:12-13,191`), and `pnpm daemon:stable` runs from the owner's own shell. Either way claude runs in the owner's desktop session and can read the same clipboard the browser copied into. **[inferred]** On Linux a `systemd --user` daemon may lack `DISPLAY`/`WAYLAND_DISPLAY`, so `xclip`/`wl-paste` fail. On macOS a launchd agent in the Aqua session should work. **[inferred, untested]**
- **Dropping an image file on a Loom terminal is currently a hazard:** nothing handles the drop, so the browser's default for a dropped file applies, which in Chrome is to open the file in the tab. That would navigate away from Loom. **[inferred from the measured not-cancelled drop plus standard browser behaviour]**
- **Remote viewers can't paste into the raw terminal at all.** It is read-only for them by design. Their only input route is the Composer (`POST /api/sessions/:id/input` → `submit()`, which bracket-pastes the whole turn, `host.ts:1085-1092`).

### Experiment E1 (needs the owner; launches nothing new)

On the owner's Windows host, in an already-running Loom session's terminal tile (a plain or manager session, not a worker): copy a screenshot (`Win+Shift+S`), click into the tile, press **`Alt+V`**. Expected if (a) already works: an `[Image #1]` chip appears in claude's prompt. Then press `Ctrl+V` with the same clipboard and record what appears. Do both twice, since a known Claude Code bug makes the first `Alt+V` fail. This needs no new process, so it isn't a real-engine spawn. It types into a live session, so it's the owner's call, not mine.

## Q3. Options

### (a) Forward the CLI's own image-paste key so claude reads the host clipboard

- **Zero-build version:** tell users to press `Alt+V` on Windows. It probably works today (see E1).
- **Small build (web-only):** in `Terminal.tsx`, add a `paste` listener in the capture phase. When `clipboardData` has an `image/*` item and empty `text/plain`, stop xterm's handler and send the CLI's key instead: `ESC v` when the daemon host is Windows, `0x16` (`Ctrl+V`) otherwise. It also has to block the empty bracketed paste. Zed's terminal shipped the same idea ("terminal: Forward Ctrl+V when clipboard contains images", https://git.secluded.site/zed/commit/0c9992c5e9f40bac63b8a11b047b7792b6b23155, third-party mirror, retrieved 2026-11-11). The web needs the **daemon's** OS, not the browser's. It's the daemon host's claude and keymap that count, so this needs an existing or new field exposing `process.platform`. If no endpoint exposes it yet, that is a one-line daemon addition **[inferred, not checked exhaustively]**. A fallback with no daemon change is to send the Windows key only when the browser is also Windows, which is right for loopback.
- **Cost:** about one web card plus an e2e that asserts the bytes sent for an image-only paste.
- **Security:** no new trust surface. The bytes are a keystroke the human could type, through the existing stdin channel.
- **Limits:** only works when browser and daemon share a machine *and* clipboard. It breaks for remote access, and remote raw terminals are read-only anyway. It also inherits Claude Code's own Windows `Alt+V` reliability, and it ignores a user-rebound `chat:imagePaste`. Codex: the key may differ (uncertain, see Q1), so gate the forwarding on harness or test it separately.
- **Draft-tracking side effect:** Loom's composer-dirty tracking (`nextComposerLen`, `host.ts:1289-1320`) skips `ESC v` (a non-CSI ESC skips its next byte) and ignores `0x16` (other C0). By reading the code, a raw-terminal draft holding only a pasted `[Image #N]` chip therefore counts as **clean** (length 0). Claude draws the chip itself, and Loom never sees it as bytes. A queued programmatic turn could then be delivered on top of the image draft, which conflicts with the "never clobber a user's draft" rule. Code reading is solid; the effect itself is **[inferred]**, not run. It already applies to plain `Alt+V` today, not just to a built (a).

### (b) Upload: browser reads the image, daemon stores it, the path is pasted into claude

- **Flow:** a `paste` event (or drop) with an image `File` goes to `POST /api/sessions/:id/attachments` (raw bytes). The daemon writes `sessionScratchDir(id)/pasted/<uuid>.<ext>` (`paths.ts:76,88`) and returns the absolute path. The web sends the path as a bracketed paste over the existing stdin WS, and claude attaches it as `[Image #N]` (the documented paste-a-path behaviour, 2.1.290/2.1.311). For the **Composer** (including remote), the path would be appended to the turn text. But a path *inside* other text no longer auto-attaches (2.1.311), so there claude would `Read` the file with a tool call instead. That works, just more slowly. **[inferred]**
- **Works remotely and across machines** (phone/tablet through `remoteAccess`), which (a) can't do. For remote use it has to live on the Composer route, since remote raw stdin is dropped.
- **Trust boundary:**
  - size cap via a route-level Fastify `bodyLimit` (precedent: `webhooks/ingress.ts:192`; the default is about 1 MiB), e.g. 10 MiB;
  - check the type by **magic bytes** (PNG/JPEG/GIF/WebP, the image types the Claude API accepts), never trust `Content-Type`;
  - the daemon picks the filename (uuid + extension from the sniffed type), so the client name never reaches the path and traversal isn't possible;
  - same gates as raw stdin: the session must be live, not `role:"assistant"`; decide whether remote peers may upload (Composer-only, rate-limited by the existing `remoteAccess.rateLimit`);
  - cleanup: scratch dirs are already reaped at boot once a session can no longer resume (`sessions/scratch-gc.ts:147`), so add a per-session file-count/bytes cap;
  - readability: scratch isn't covered by the `Read` deny on `~/.loom/tmp/settings` (`claude-settings.ts:433`), so claude can read it. Every session's scratch sits under one root, which other sessions in `auto` mode can also read (see the project memory note on read gates being tool-scoped, not data-scoped). Pasted screenshots are no more private than transcripts are today.
- **Codex:** the path paste works the same at the pty level. Whether the Codex TUI turns a pasted path into an attachment is **uncertain**. Its fallback is a `view_image` tool read.
- **Cost:** one daemon card (endpoint + validation + tests) and one web card (paste/drop capture + upload + insertion + e2e). It lands in the daemon, so it's affected by the post-v0.32.0 freeze.

### (c) Other

- **Drag and drop an image file onto the terminal/Composer:** this rides on (b)'s upload. Even without (b), a `dragover`/`drop` `preventDefault` stops a dropped file from navigating the tab away from Loom. That's a cheap web-only fix worth doing regardless.
- **Paste a path manually:** works today with no build. Save the image, paste its path into the terminal (attaches as `[Image #N]`), or mention it in a Composer turn (claude `Read`s it). **[documented behaviour; untested through Loom]**
- **Rebinding `chat:imagePaste`:** not useful. Loom doesn't own the user's `keybindings.json`, and the problem isn't which key it is.

## Q4. Recommendation and proposed cards

1. Run **E1** first. If `Alt+V` works, (a) is mostly done already, and the build is a small web polish.
2. Build (a) web-only now, plus the drop guard. Hold (b) unless the owner wants paste from remote/phone. If they do, (b)'s daemon half has to land before the v0.32.0 freeze or be scheduled for the Rust port.

Proposed cards (not filed):

- `feat(web): forward the CLI image-paste key when the clipboard holds only an image`. DoD: an image-only paste in a terminal tile sends `ESC v` (Windows daemon) or `0x16` (other) instead of an empty bracketed paste; text pastes are unchanged; a Playwright spec asserts the emitted bytes for both cases.
- `fix(web): stop a dropped file from navigating the Loom tab away from the terminal`. DoD: a file dropped on a terminal tile or the Composer has `preventDefault` called, the page URL stays the same, and an e2e covers it.
- `fix(pty): count a terminal image-paste key as a dirty composer draft`. DoD: after `ESC v`/`0x16` in raw stdin, a queued programmatic turn is held until the draft is submitted or cleared, same as typed text. Daemon, so before the freeze. Confirm via E1 that the chip actually appears first.
- (only if remote paste is wanted) `feat(gateway): accept a session image attachment into its scratch dir`. DoD: magic-byte-checked PNG/JPEG/GIF/WebP, ≤10 MiB route `bodyLimit`, daemon-chosen name under `sessionScratchDir(id)/pasted/`, refused for `assistant` and non-live sessions, per-session cap; tests for an oversize file, a wrong-type file, and a traversal-shaped name.
- (pairs with the above) `feat(web): upload a pasted or dropped image and insert its path`. DoD: terminal paste/drop and Composer paste upload the image and insert the returned path; e2e against a fake daemon route.

## Open questions

- E1's result (does `Alt+V` attach through Loom, and what does `Ctrl+V` do).
- What claude does with an empty bracketed paste: is it ignored, or does it trigger a clipboard check?
- Codex TUI image-paste key and path-attach behaviour on Windows (no first-party source found).
- Does the web already have a way to learn the daemon's `process.platform`?
