// Vault-viewer spec (card 3006be3a) — drives the real vault browser (/vault) against the isolated,
// seeded daemon and asserts the on-disk Markdown notes both LIST in the folder tree and RENDER (markdown
// → rendered DOM, not raw source). Builds on the shared `loomDaemon` fixture (card c3fd1d68);
// board.spec.ts / settings.spec.ts are the multi-test / active-project templates this follows.
//
// The seeding wrinkle (why this spec does NOT use `loomDaemon.createProject`): the vault viewer reads
// notes from the project's `vaultPath` ON DISK (daemon `vault/browser.ts` → GET /api/projects/:id/vault),
// and the fixture's createProject makes an EMPTY vault dir and never exposes its path. So each test seeds
// its OWN temp dirs here in Node (this spec runs in the Playwright Node process, same machine as the
// daemon), WRITES real `.md` note files into the vault dir, then POSTs the project itself with `vaultPath`
// pointed at that seeded dir. The repo dir is git-init'd to mirror the fixture's createProject (the POST
// itself only requires the three paths be present — it does not validate them on disk).
//
// Determinism note (same as board/settings): the vault viewer is scoped to the ACTIVE project
// (localStorage `loom.projectId`, see lib/activeProject.tsx), and the worker-scoped daemon is SHARED
// across the specs in this file — so more than one project exists on it and the auto-resolved "first
// project" is not stable. Every test therefore seeds its OWN project + notes and PINS it active via
// addInitScript BEFORE navigating, so it never races another test's project. Because the viewer reads
// only the pinned project's vaultPath, the tree contains exactly the notes that test seeded.
import { expect, test } from "./fixtures/daemon";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Temp vault/repo roots seeded across this spec, torn down together at the end (the fixture only cleans
// its own scratch; the dirs we mkdtemp here are ours to remove).
const seededDirs: string[] = [];

test.afterAll(() => {
  for (const dir of seededDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinActiveProject(page: Page, projectId: string) {
  // The FirstRunWelcome overlay is dismissed globally by the fixture (fixtures/daemon.ts), so this only
  // pins the active project.
  await page.addInitScript((id) => localStorage.setItem("loom.projectId", id), projectId);
}

// Seed a project whose vaultPath is a real on-disk dir containing `notes` (relative path → markdown text),
// then POST it. Returns the created project id + the vault dir (so a test can add/inspect files if needed).
async function seedVaultProject(
  baseURL: string,
  notes: Record<string, string>,
): Promise<{ id: string; vaultDir: string }> {
  const scratch = mkdtempSync(path.join(tmpdir(), "loom-vault-e2e-"));
  seededDirs.push(scratch);
  const repoDir = path.join(scratch, "repo");
  const vaultDir = path.join(scratch, "vault");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", repoDir]); // mirror the fixture's createProject; the vault viewer itself needs no git

  for (const [rel, content] of Object.entries(notes)) {
    const abs = path.join(vaultDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  const res = await fetch(`${baseURL}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("vault"), repoPath: repoDir, vaultPath: vaultDir }),
  });
  if (!res.ok) throw new Error(`POST /api/projects -> ${res.status}: ${await res.text()}`);
  const project = (await res.json()) as { id: string };
  return { id: project.id, vaultDir };
}

// A tree row (file or folder) is a `.loom-tree-row` <button>; its accessible name carries the entry's name.
function treeRow(page: Page, name: string) {
  return page.locator("button.loom-tree-row").filter({ hasText: name });
}

// A real 1x1 transparent PNG — a byte-exact binary fixture for the raw-serving tests below.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// The attack fixture for card 68bef69c: a vault SVG that, if the browser ever renders it as a DOCUMENT
// on the daemon's own origin, reads the loopback token out of localStorage and copies it somewhere an
// exfiltration would. Declared 64x64 so a successful <img> render is distinguishable from a blank box.
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
  + "<script>try{localStorage.setItem('loom.PWNED','STOLEN:'+localStorage.getItem('loom.loopbackToken'));}catch(e){}</script>"
  + '<rect width="64" height="64" fill="#33ff99"/></svg>';

test("lists a seeded root note and RENDERS its markdown (not raw source)", async ({ page, loomDaemon }) => {
  const heading = uniq("Welcome-Heading");
  const boldWord = uniq("emphatic");
  const note = `# ${heading}\n\nThis note has a **${boldWord}** word and a list:\n\n- one\n- two\n`;
  const { id } = await seedVaultProject(loomDaemon.baseURL, { "Welcome.md": note });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // LISTS: the note surfaces as a file row in the tree.
  await expect(treeRow(page, "Welcome.md")).toBeVisible();

  // Open it and prove it RENDERED, not dumped as source:
  await treeRow(page, "Welcome.md").click();

  //  (a) the `# Heading` became a real heading element (text WITHOUT the leading `#`)…
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  //  (b) `**bold**` became a <strong>…
  await expect(page.locator("strong", { hasText: boldWord })).toBeVisible();
  //  (c) `- one/- two` became real list items…
  await expect(page.getByRole("listitem").filter({ hasText: "one" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "two" })).toBeVisible();
  //  (d) and the raw markdown tokens are NOWHERE on the page (if the viewer showed source, `# <heading>`
  //      and `**bold**` would appear verbatim — the rendered DOM strips them).
  await expect(page.getByText(`# ${heading}`)).toHaveCount(0);
  await expect(page.getByText(`**${boldWord}**`)).toHaveCount(0);
});

test("a note in a subfolder is reachable by expanding the folder, and renders", async ({ page, loomDaemon }) => {
  const heading = uniq("Nested-Note-Heading");
  const note = `# ${heading}\n\nA note that lives one folder deep.\n`;
  const { id } = await seedVaultProject(loomDaemon.baseURL, { "Design/Spec.md": note });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // The folder lists, but its child is collapsed (the tree starts fully collapsed) — the nested note row is
  // not yet in the DOM, and its rendered heading is absent.
  await expect(treeRow(page, "Design")).toBeVisible();
  await expect(treeRow(page, "Spec.md")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);

  // Expand the folder → the child note row appears.
  await treeRow(page, "Design").click();
  await expect(treeRow(page, "Spec.md")).toBeVisible();

  // Open it → it renders.
  await treeRow(page, "Spec.md").click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
});

test("the file filter narrows the tree to a matching note", async ({ page, loomDaemon }) => {
  const alpha = uniq("Alpha");
  const bravo = uniq("Bravo");
  const { id } = await seedVaultProject(loomDaemon.baseURL, {
    [`${alpha}.md`]: `# ${alpha}\n\nfirst note\n`,
    [`${bravo}.md`]: `# ${bravo}\n\nsecond note\n`,
  });
  await pinActiveProject(page, id);

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // BEFORE: both notes list.
  await expect(treeRow(page, `${alpha}.md`)).toBeVisible();
  await expect(treeRow(page, `${bravo}.md`)).toBeVisible();

  // Filter by the first note's name (the tree restricts to path-substring matches — Vault.tsx `visible`).
  await page.getByPlaceholder("Filter files…").fill(alpha);

  // AFTER: only the matching note survives; the other is filtered out.
  await expect(treeRow(page, `${alpha}.md`)).toBeVisible();
  await expect(treeRow(page, `${bravo}.md`)).toHaveCount(0);

  // Clearing the filter restores the full tree.
  await page.getByPlaceholder("Filter files…").fill("");
  await expect(treeRow(page, `${bravo}.md`)).toBeVisible();
});

// ── Edit gating + read errors (card 4bd4e4a6) ──────────────────────────────────
// These three drive the DATA-LOSS path the viewer used to allow, and the error state it used to hide.
//
// The window: the file-content query uses `keepPreviousData`, so while a newly selected note loads, the
// pane is still showing the PREVIOUS note's text. `VaultEditor` captures its initial text ONCE (a
// `useState(content)` initializer) — so an editor opened inside that window captured the wrong note's
// body, and Save wrote it over the newly selected path. Test 1 is the witness: it asserts the file ON
// DISK, which is the only place the loss is actually visible. Test 2 is the control's own before/after.
// Test 3 covers a note renamed out from under the viewer — a real 404, which used to render an endless
// "…" because the query had no `isError` branch.
//
// Why `page.route` holds the fetch: on localhost the load window is a few milliseconds, so the bug is
// real but hard to hit by hand. Holding exactly the one request widens it deterministically — no fixed
// waits, and the held path is matched by name so the hold can never silently apply to the wrong file.

// Hold the content fetch for ONE vault path until the returned function is called.
async function holdVaultFileFetch(page: Page, relPath: string): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(
    (url) => url.pathname.endsWith("/vault/file") && url.searchParams.get("path") === relPath,
    async (route) => { await held; await route.continue(); },
  );
  return () => release();
}

const editButton = (page: Page) => page.getByRole("button", { name: "Edit", exact: true });

// Seed two notes whose bodies share no text, so "which note's body is this?" is answerable from any
// single string — on screen or on disk.
async function seedTwoNotes(baseURL: string) {
  const alphaName = `${uniq("Alpha")}.md`;
  const bravoName = `${uniq("Bravo")}.md`;
  const alphaOnly = uniq("ALPHA-ONLY-BODY");
  const bravoOnly = uniq("BRAVO-ONLY-BODY");
  const seeded = await seedVaultProject(baseURL, {
    [alphaName]: `# Alpha\n\n${alphaOnly}\n`,
    [bravoName]: `# Bravo\n\n${bravoOnly}\n`,
  });
  return { ...seeded, alphaName, bravoName, alphaOnly, bravoOnly };
}

test("a fast file switch can never seed the editor from the PREVIOUS note (no cross-file overwrite)", async ({ page, loomDaemon }) => {
  // A failed save would pop the global mutation alert (main.tsx) and wedge the run — dismiss, never hang.
  page.on("dialog", (d) => void d.dismiss());

  const { id, vaultDir, alphaName, bravoName, alphaOnly, bravoOnly } = await seedTwoNotes(loomDaemon.baseURL);
  await pinActiveProject(page, id);
  const releaseBravo = await holdVaultFileFetch(page, bravoName);
  await page.goto(`${loomDaemon.baseURL}/vault`);

  // Load Alpha fully — this is the text `keepPreviousData` holds on screen through the next switch.
  await treeRow(page, alphaName).click();
  await expect(page.getByText(alphaOnly)).toBeVisible();

  // Switch to Bravo. Its content fetch is held, so the pane still shows ALPHA's body under BRAVO's
  // breadcrumb. Asserting that precondition is what makes the rest of this test mean anything.
  await treeRow(page, bravoName).click();
  await expect(page.getByText(alphaOnly)).toBeVisible();

  // Try to open the editor inside that window. `force` because the fix DISABLES Edit here and a disabled
  // <button> never fires a click — a genuine no-op. Before the fix it was enabled, and the textarea
  // mounted holding ALPHA's body.
  await editButton(page).click({ force: true });
  releaseBravo();

  // Settle into whichever state the UI chose — an editor opened (pre-fix) or Bravo's own body rendered
  // (fixed). Exactly one of the two can be true, so this never needs a timed wait.
  await expect(page.locator("textarea").or(page.getByText(bravoOnly)).first()).toBeVisible();
  const seededFromStaleContent = (await page.locator("textarea").count()) > 0;

  if (seededFromStaleContent) {
    // The pre-fix path, driven to completion so the loss is OBSERVED and not merely argued: once Bravo's
    // body lands, the editor's captured Alpha text reads as an unsaved edit, and Save writes it to
    // Bravo's path.
    const save = page.getByRole("button", { name: /^Sav/ });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator("textarea")).toHaveCount(0);
  }

  // THE WITNESS: Bravo's file on disk still holds Bravo's body, never Alpha's.
  const onDisk = readFileSync(path.join(vaultDir, bravoName), "utf8");
  expect(onDisk).toContain(bravoOnly);
  expect(onDisk).not.toContain(alphaOnly);
  expect(seededFromStaleContent, "Edit opened an editor seeded from the previously-viewed note").toBe(false);
});

test("Edit is disabled while the selected note's own content is still loading, and enabled once it lands", async ({ page, loomDaemon }) => {
  const { id, alphaName, bravoName, alphaOnly, bravoOnly } = await seedTwoNotes(loomDaemon.baseURL);
  await pinActiveProject(page, id);
  const releaseBravo = await holdVaultFileFetch(page, bravoName);
  await page.goto(`${loomDaemon.baseURL}/vault`);

  // BEFORE: a fully loaded note is editable.
  await treeRow(page, alphaName).click();
  await expect(page.getByText(alphaOnly)).toBeVisible();
  await expect(editButton(page)).toBeEnabled();

  // GATED: the selection moved to Bravo but Bravo's own content has not arrived.
  await treeRow(page, bravoName).click();
  await expect(editButton(page)).toBeDisabled();
  await expect(editButton(page)).toHaveAttribute("title", /loading/i);

  // AFTER: its content lands and the control re-arms.
  releaseBravo();
  await expect(page.getByText(bravoOnly)).toBeVisible();
  await expect(editButton(page)).toBeEnabled();
});

test("a note deleted out from under the viewer shows a read error with a working Retry, not an endless placeholder", async ({ page, loomDaemon }) => {
  const { id, vaultDir, alphaName, bravoName, alphaOnly, bravoOnly } = await seedTwoNotes(loomDaemon.baseURL);
  await pinActiveProject(page, id);
  await page.goto(`${loomDaemon.baseURL}/vault`);

  // Open Bravo first, so there IS previous content that `keepPreviousData` could otherwise leave on
  // screen in place of the error.
  await treeRow(page, bravoName).click();
  await expect(page.getByText(bravoOnly)).toBeVisible();

  // An agent renames/removes the note while its row is still in the (cached) tree.
  const alphaAbs = path.join(vaultDir, alphaName);
  const alphaBody = readFileSync(alphaAbs, "utf8");
  rmSync(alphaAbs);

  await treeRow(page, alphaName).click();

  // The read failure is SHOWN — the daemon's own reason included — and the previous note's body is gone.
  await expect(page.getByText("Unable to read this note")).toBeVisible();
  await expect(page.getByText("file not found")).toBeVisible();
  await expect(page.getByText(bravoOnly)).toHaveCount(0);
  await expect(page.getByText("…", { exact: true })).toHaveCount(0);
  // Nothing can be edited into a note that could not be read.
  await expect(editButton(page)).toBeDisabled();

  // Retry is a real control, not decoration: restore the note, retry, and the note renders.
  writeFileSync(alphaAbs, alphaBody, "utf8");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText(alphaOnly)).toBeVisible();
  await expect(page.getByText("Unable to read this note")).toHaveCount(0);
  await expect(editButton(page)).toBeEnabled();
});

// ── Raw vault bytes are sandboxed (card 68bef69c, docs/decisions/68bef69c-vault-raw-csp.md) ─────────
// Vault files are UNTRUSTED (an agent's vault_write, a research import) and `/vault/raw` serves them on
// the DAEMON'S OWN origin — the origin whose localStorage holds the loopback + gateway tokens. Before
// the fix, NAVIGATING to a vault `.svg`'s raw URL ran its <script> with those tokens in reach. These two
// tests pin both halves of the fix AND the thing it must not break:
//   (a) the response headers (RED on pre-fix code: no CSP, no Content-Disposition), and
//   (b) that the <img> consumer the Vault page actually uses still renders the same SVG — an <img> never
//       applies a document CSP and ignores Content-Disposition, which is WHY those headers are safe here.
// The behavioural half (a navigation downloads instead of executing) is asserted via the download event
// rather than a page-state read, because an `attachment` response aborts the navigation by design.
test("serves raw vault bytes with sandboxing headers, and PDFs with the native-viewer carve-out", async ({ page, loomDaemon }) => {
  const { id, vaultDir } = await seedVaultProject(loomDaemon.baseURL, { "note.md": "# plain\n" });
  writeFileSync(path.join(vaultDir, "pic.png"), PNG_1X1);
  writeFileSync(path.join(vaultDir, "doc.pdf"), "%PDF-1.4\n%%EOF\n", "latin1");

  const raw = (rel: string) => `${loomDaemon.baseURL}/api/projects/${id}/vault/raw?path=${encodeURIComponent(rel)}`;
  const CSP = "sandbox; default-src 'none'";

  // An active document type: sandboxed AND forced to download.
  writeFileSync(path.join(vaultDir, "art.svg"), HOSTILE_SVG, "utf8");
  const svg = await page.request.get(raw("art.svg"));
  expect(svg.status()).toBe(200);
  expect(svg.headers()["content-type"]).toBe("image/svg+xml");
  expect(svg.headers()["content-security-policy"]).toBe(CSP);
  expect(svg.headers()["content-disposition"]).toBe("attachment");
  expect(svg.headers()["x-content-type-options"]).toBe("nosniff");

  // Inert types are sandboxed too (the guard is not an extension allow-list) but NOT forced to download.
  for (const rel of ["pic.png", "note.md"]) {
    const r = await page.request.get(raw(rel));
    expect(r.status(), rel).toBe(200);
    expect(r.headers()["content-security-policy"], rel).toBe(CSP);
    expect(r.headers()["content-disposition"], rel).toBeUndefined();
  }

  // The carve-out: a CSP sandbox disables the browser's native PDF viewer, which would blank the Vault
  // page's <object> embed — so a PDF response is byte-identical to pre-fix. If this flips, that breaks.
  const pdf = await page.request.get(raw("doc.pdf"));
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-security-policy"]).toBeUndefined();
  expect(pdf.headers()["content-disposition"]).toBeUndefined();
  expect(pdf.headers()["x-content-type-options"]).toBe("nosniff");
});

test("a hostile vault SVG downloads instead of scripting the daemon origin, and still renders in the viewer", async ({ page, loomDaemon }) => {
  const { id, vaultDir } = await seedVaultProject(loomDaemon.baseURL, { "note.md": "# plain\n" });
  writeFileSync(path.join(vaultDir, "art.svg"), HOSTILE_SVG, "utf8");
  await pinActiveProject(page, id);
  // Seed a decoy token under the SAME key the real app uses, so a successful script would prove it could
  // read a real credential — not merely that it ran.
  await page.addInitScript(() => localStorage.setItem("loom.loopbackToken", "SENTINEL-68bef69c"));

  await page.goto(`${loomDaemon.baseURL}/vault`);

  // (1) The Vault page's own <img> consumer still renders it — at the SVG's real intrinsic size, so this
  //     fails on a broken/blocked image rather than passing on an empty box.
  await treeRow(page, "art.svg").click();
  const img = page.locator('main img[src*="vault/raw"]').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(64);

  // (2) Navigating to the raw URL yields a DOWNLOAD, not a document — so the <script> never runs.
  const rawUrl = `${loomDaemon.baseURL}/api/projects/${id}/vault/raw?path=art.svg`;
  const download = page.waitForEvent("download");
  await page.goto(rawUrl).catch(() => { /* an `attachment` response aborts the navigation by design */ });
  expect((await download).suggestedFilename()).toMatch(/\.svg$/);

  // (3) …and the decoy token was never copied out. A pre-fix daemon writes `loom.PWNED` here.
  await page.goto(`${loomDaemon.baseURL}/vault`);
  expect(await page.evaluate(() => localStorage.getItem("loom.PWNED"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("loom.loopbackToken"))).toBe("SENTINEL-68bef69c");
});

// Card f7525818 made `Markdown`'s `components` map memoised (it is used as the ELEMENT TYPE for every
// rendered node, so rebuilding it remounted them all — which now re-fetches an authenticated inline
// image). Keeping that memo stable meant routing `onOpen` through a ref, since the caller passes a fresh
// arrow each render. This pins the navigation that indirection runs through — the link path had no e2e
// coverage before, which is the actual gap it closes.
//
// ⚠️ SCOPE, stated rather than implied: the second click does NOT discriminate a stale captured callback.
// Vault.tsx's `openFile` closes only over `setFile`/`setExpanded`, both stable, so a ref frozen at first
// render would behave identically today. The per-render assignment is defensive — it keeps the memo safe
// for a future caller whose callback does close over changing state — and nothing here proves that half.
test("an in-note [[wikilink]] opens the target note, and still works after the pane re-renders", async ({ page, loomDaemon }) => {
  const targetBody = uniq("TARGET-ONLY-BODY");
  const sourceBody = uniq("SOURCE-ONLY-BODY");
  const { id } = await seedVaultProject(loomDaemon.baseURL, {
    "Source.md": `# Source\n\n${sourceBody}\n\nGo to [[Target]].\n`,
    "Target.md": `# Target\n\n${targetBody}\n`,
  });
  await pinActiveProject(page, id);
  await page.goto(`${loomDaemon.baseURL}/vault`);

  await treeRow(page, "Source.md").click();
  await expect(page.getByText(sourceBody)).toBeVisible();

  await page.locator("a.md-wikilink").filter({ hasText: "Target" }).click();
  await expect(page.getByText(targetBody)).toBeVisible();
  await expect(page.getByText(sourceBody)).toHaveCount(0);

  // Back to Source, re-render the pane (typing in the filter re-renders the component that owns the
  // viewer AND re-creates the `onOpen` arrow), then click the link again — a ref that had frozen the
  // first render's callback would still work here, but one that never updated would not.
  await treeRow(page, "Source.md").click();
  await expect(page.getByText(sourceBody)).toBeVisible();
  await page.getByPlaceholder("Filter files…").fill("Target");
  await page.locator("a.md-wikilink").filter({ hasText: "Target" }).click();
  await expect(page.getByText(targetBody)).toBeVisible();
});
