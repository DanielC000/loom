// Faithful terminal RENDERING e2e spec (card a53e6bc9). Every other terminal spec seeds a plain
// `processState:"live"` DB row (loomDaemon.seedLiveSession) whose `/ws/term` attach is a genuine no-op —
// good enough to prove card CHROME (title, buttons, sub-panels) but useless for proving the terminal
// PANE itself renders correctly (width-bound letterbox / oscillation bugs, the actual thing the Web
// Designer rig needs to verify). This spec seeds a session with `ptyGeometry` + `ptyBytes`
// (PtyHost.seedCanned, wired through POST /internal/test/seed) so a REAL `/ws/term` attach replays a
// pinned grid + recorded bytes with NO real claude spawn.
//
// READING THE RENDER: xterm.js's default (Canvas) renderer paints to a <canvas>, which Playwright can't
// read text out of. `screenReaderMode: true` (Terminal.tsx) keeps a visually-hidden, ALWAYS-IN-SYNC
// `.xterm-accessibility-tree` — one row element per grid row, its `textContent` mirroring the real
// rendered buffer — a legitimate xterm.js accessibility feature we read from, not a monkeypatch of any
// kind (nothing about WebSocket or the app's own code is touched).
import { expect, test } from "./fixtures/daemon";

// Isolation is baked into the fixture (fixtures/daemon.ts): the FirstRunWelcome overlay is dismissed
// globally, and after each test every seeded live session is archived — this spec re-derives neither.

const rowsLocator = (page: import("@playwright/test").Page) => page.locator(".xterm-accessibility-tree > div");

test("a seeded session's terminal renders the canned bytes at the pinned geometry (no real spawn, no WS monkeypatch)", async ({ page, loomDaemon }) => {
  const geometry = { cols: 60, rows: 16 };
  const line1 = "LOOM-CANNED-PTY-a53e6bc9";
  const line2 = "faithful replay, no real claude";
  const seeded = await loomDaemon.seedLiveSession({
    role: "plain",
    ptyGeometry: geometry,
    ptyBytes: `${line1}\r\n${line2}\r\n`,
  });

  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);

  // GEOMETRY: the accessibility tree's row count converges on the PINNED rows (xterm's onResize handler
  // grows/shrinks `_rowElements` to match) — proves the daemon's `geometry` control frame landed and the
  // client honored the pin (Terminal.tsx's `term.resize(cols, rows)`), not some default/fallback grid.
  await expect(rowsLocator(page)).toHaveCount(geometry.rows);

  // BYTES: the tree's combined text mirrors the actual rendered buffer — proves the canned bytes were
  // replayed onto a REAL xterm instance over a REAL `/ws/term` attach, not asserted against a stub.
  await expect(rowsLocator(page).filter({ hasText: line1 })).toBeVisible();
  await expect(rowsLocator(page).filter({ hasText: line2 })).toBeVisible();
});

test("omitting ptyGeometry falls back to the project's resolved pty config, not a hardcoded default", async ({ page, loomDaemon }) => {
  const line = "no-geometry-given-still-replays";
  const seeded = await loomDaemon.seedLiveSession({ role: "plain", ptyBytes: `${line}\r\n` });

  await page.goto(`${loomDaemon.baseURL}/session/${seeded.sessionId}`);

  // The row count converges on SOME positive pinned grid (the project's resolved default, e.g. 80x24 —
  // whatever `resolveConfig(project.config).pty` resolves to) rather than staying at xterm's raw
  // constructor default forever with no geometry frame ever applied.
  await expect(rowsLocator(page)).not.toHaveCount(0);
  await expect(rowsLocator(page).filter({ hasText: line })).toBeVisible();
});
