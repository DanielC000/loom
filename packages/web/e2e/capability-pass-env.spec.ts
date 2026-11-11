// Capability ambient-env (`passEnv`) editor spec — card dec4959a's Settings control over card
// fafae623's one post-create-editable capability field.
//
// Every test drives the REAL control and asserts a before/after state change, never a render. The
// oracle is `GET /api/capabilities` on the fixture daemon — what actually persisted — read in addition
// to the rendered chrome, so a green here means the row changed, not just that the panel drew.
//
// WHAT EACH TEST PROVES
//   1. Add → Save → persisted, and survives a full page reload (DoD-2's round trip).
//   2. A reserved name is REFUSED with a visible message, Save stays disabled, and the stored row is
//      byte-identical afterwards — the refusal blocks the write rather than merely annotating it.
//   3. Remove → Save → the name is gone from the stored row (the clearing direction, which a
//      write-only test never exercises; `[]` is sent explicitly, never an omitted key).
//   4. The SERVER stays authoritative: with the capability deleted behind the open editor's back, Save
//      renders the daemon's own `{ error }` text. This is the one leg the client-side mirror cannot
//      satisfy by construction, so it is what proves the mirror is a convenience and not the gate.
//   5. A builtin offers no editor at all — it is not a `capability_defs` row, so there is no id to
//      PATCH and no `passEnv` concept to edit.
//
// POLARITY (the worker doctrine's control rule): test 5 and the Save-disabled half of test 2 are
// ABSENCE assertions, which a broken locator satisfies exactly like a correct gate. Both are controlled
// in the same test, on the same page: test 5 asserts the editor toggle IS present on an owner-added row
// before reading zero on the builtin, and test 2 clicks a Save that was proven enabled moments earlier.
//
// FIXTURE IDENTITY: each test POSTs its OWN uniquely-slugged capability and asserts that slug is the
// one this daemon serves back. A sibling worker's daemon renders identically, so an unasserted run
// could screenshot a completely wrong fixture — and a shared seeded row (github / image-gen / shadcn)
// must never be mutated by a test, since the `loomDaemon` fixture is worker-scoped and shared across
// every test in this file.
// NEGATIVE CONTROLS — hand-rolled, because scripts/negative-control.mjs cannot drive a Playwright spec
// (it runs a bare `node <file>`). Each mutant KEEPS the feature and disables one rule, so no red is the
// structural "missing export" kind that proves nothing (lesson 298). ⚠️ The fixture daemon serves
// `packages/web/dist`, so EVERY mutant needs `pnpm --filter @loom/web... build` before the run or the
// spec silently tests the previous bundle. All four verified 2026-11-04, each a SPLIT (not a sweep):
//   E1  Save's `disabled` loses the `blocked` term (Settings.tsx)
//       ⇒ only test 2 red, at `toBeDisabled()`. 4 passed.
//   E2  the per-row `{err && …}` message is never rendered
//       ⇒ only test 2 red, at `expect(rowError).toBeVisible()` (line 133). 4 passed.
//   E3  `api.updateCapabilityPassEnv` sends `passEnv: []` instead of the real list
//       ⇒ tests 1 AND 3 red, both at the persisted-count assertion. 3 passed.
//   E4  `editable` forced true, so a builtin gets the editor too
//       ⇒ only test 5 red, at `toHaveCount(0)`. 4 passed.
import { expect, test, type Page } from "./fixtures/daemon";

interface CatalogRow {
  id?: string; slug: string; name: string; builtin: boolean; passEnv?: string[];
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

const listCapabilities = (baseURL: string) => apiJson<CatalogRow[]>(`${baseURL}/api/capabilities`);

/**
 * Seed one owner-added capability of this spec's own. `kind: "bundled"` with a bare `command` is the
 * cheapest shape the create validator accepts — unlike `kind: "command"` it is NOT resolved against the
 * filesystem at save time, so this never depends on what is installed on the host.
 */
async function seedCapability(baseURL: string, slug: string, passEnv: string[] = []): Promise<CatalogRow> {
  return apiJson<CatalogRow>(`${baseURL}/api/capabilities`, {
    method: "POST",
    body: JSON.stringify({
      slug, name: `Env Fixture ${slug}`, description: "Fixture capability for the passEnv editor spec.",
      transport: "stdio", kind: "bundled", provision: { command: "node", args: ["--version"] },
      toolAllowlist: [`mcp__${slug}`], passEnv,
    }),
  });
}

/** The stored `passEnv` for one slug, read back off the daemon — the oracle for "what persisted". */
async function storedPassEnv(baseURL: string, slug: string): Promise<string[]> {
  const row = (await listCapabilities(baseURL)).find((c) => c.slug === slug);
  expect(row, `this daemon must serve the seeded ${slug} capability`).toBeTruthy();
  return row!.passEnv ?? [];
}

const uniqueSlug = (tag: string) => `env-${tag}-${Date.now().toString(36)}`;

/** Open the Capabilities section's editor for one slug, asserting the toggle exists before clicking. */
async function openEditor(page: Page, baseURL: string, slug: string) {
  await page.goto(`${baseURL}/home?tab=settings`);
  const toggle = page.getByTestId(`capability-passenv-toggle-${slug}`);
  await expect(toggle).toBeVisible();
  await toggle.click();
  const editor = page.getByTestId(`capability-passenv-editor-${slug}`);
  await expect(editor).toBeVisible();
  return editor;
}

test.describe("capability ambient-env editor", () => {
  test("a name added and saved persists, and survives a reload", async ({ page, loomDaemon }) => {
    const slug = uniqueSlug("add");
    const seeded = await seedCapability(loomDaemon.baseURL, slug);
    expect(seeded.slug, "fixture identity: the daemon must echo the slug this test created").toBe(slug);
    expect(await storedPassEnv(loomDaemon.baseURL, slug), "BEFORE: a fresh row forwards nothing").toEqual([]);

    await openEditor(page, loomDaemon.baseURL, slug);

    // BEFORE: no rows, no badge on the catalog row, and Save is inert (nothing is dirty).
    await expect(page.getByTestId(`passenv-name-${slug}-0`)).toHaveCount(0);
    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toHaveCount(0);
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeDisabled();

    // ACT: add a row, type a legal name. Save must become ENABLED — this is the positive control for
    // every later "Save stays disabled" assertion in this file.
    await page.getByTestId(`passenv-add-${slug}`).click();
    await page.getByTestId(`passenv-name-${slug}-0`).fill("HTTPS_PROXY");
    await expect(page.getByTestId(`passenv-error-${slug}-0`)).toHaveCount(0);
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeEnabled();
    await page.getByTestId(`passenv-save-${slug}`).click();

    // AFTER (chrome): the editor closes on success and the catalog row now carries its count badge.
    await expect(page.getByTestId(`capability-passenv-editor-${slug}`)).toHaveCount(0);
    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toContainText("1");

    // AFTER (the real oracle): it actually persisted on the daemon, not just in a react-query cache.
    expect(await storedPassEnv(loomDaemon.baseURL, slug)).toEqual(["HTTPS_PROXY"]);

    // AFTER (DoD-2's round trip): a full reload throws away all client state and re-reads REST.
    await page.reload();
    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toContainText("1");
    await page.getByTestId(`capability-passenv-toggle-${slug}`).click();
    await expect(page.getByTestId(`passenv-name-${slug}-0`)).toHaveValue("HTTPS_PROXY");
  });

  test("a reserved name is refused with a visible message and cannot be saved", async ({ page, loomDaemon }) => {
    const slug = uniqueSlug("reserved");
    await seedCapability(loomDaemon.baseURL, slug, ["HTTP_PROXY"]);
    expect(await storedPassEnv(loomDaemon.baseURL, slug), "fixture identity + BEFORE state").toEqual(["HTTP_PROXY"]);

    await openEditor(page, loomDaemon.baseURL, slug);
    await expect(page.getByTestId(`passenv-name-${slug}-0`)).toHaveValue("HTTP_PROXY");

    // CONTROL: a legal edit enables Save, so the disabled assertions below mean the gate fired rather
    // than the button simply never having been reachable in this editor.
    await page.getByTestId(`passenv-name-${slug}-0`).fill("HTTP_PROXY_2");
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeEnabled();
    await expect(page.getByTestId(`passenv-error-${slug}-0`)).toHaveCount(0);

    // ACT 1 — a RESERVED name (Loom's own prefix). Refused, visibly, with the server's own sentence.
    await page.getByTestId(`passenv-name-${slug}-0`).fill("LOOM_MCP_TOKEN");
    const rowError = page.getByTestId(`passenv-error-${slug}-0`);
    await expect(rowError).toBeVisible();
    await expect(rowError).toContainText("reserved Loom credential name");
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeDisabled();

    // ACT 2 — a name that is reserved by PREFIX rather than exactly, a separate arm of the same rule.
    await page.getByTestId(`passenv-name-${slug}-0`).fill("LOOM_HOME");
    await expect(rowError).toContainText("reserved 'LOOM_*' prefix");
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeDisabled();

    // ACT 3 — an INVALID SHAPE, not a reserved name: the charset rule is its own gate, and the message
    // says what a legal name looks like instead of restating the entry.
    await page.getByTestId(`passenv-name-${slug}-0`).fill("9LIVES=x");
    await expect(rowError).toContainText("Not a valid env var name");
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeDisabled();

    // AFTER: the stored row never moved. A refusal that only annotated the field would fail here.
    expect(await storedPassEnv(loomDaemon.baseURL, slug)).toEqual(["HTTP_PROXY"]);
  });

  test("removing a name and saving clears it from the stored row", async ({ page, loomDaemon }) => {
    const slug = uniqueSlug("remove");
    await seedCapability(loomDaemon.baseURL, slug, ["HTTP_PROXY", "NO_PROXY"]);
    expect(await storedPassEnv(loomDaemon.baseURL, slug)).toEqual(["HTTP_PROXY", "NO_PROXY"]);

    await openEditor(page, loomDaemon.baseURL, slug);
    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toContainText("2");

    // ACT: drop the FIRST row, leaving the second — so this proves a targeted removal, not a wipe.
    await page.getByTestId(`passenv-remove-${slug}-0`).click();
    await expect(page.getByTestId(`passenv-name-${slug}-0`)).toHaveValue("NO_PROXY");
    await page.getByTestId(`passenv-save-${slug}`).click();

    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toContainText("1");
    expect(await storedPassEnv(loomDaemon.baseURL, slug)).toEqual(["NO_PROXY"]);

    // AND the clear-to-empty direction: `[]` must be sent as an explicit key (the route 400s a body
    // that omits `passEnv`), so emptying the list has to actually land rather than be refused.
    await page.getByTestId(`capability-passenv-toggle-${slug}`).click();
    await page.getByTestId(`passenv-remove-${slug}-0`).click();
    await page.getByTestId(`passenv-save-${slug}`).click();
    await expect(page.getByTestId(`capability-passenv-badge-${slug}`)).toHaveCount(0);
    expect(await storedPassEnv(loomDaemon.baseURL, slug)).toEqual([]);
  });

  test("the server stays authoritative — a refused PATCH shows the daemon's own error text", async ({ page, loomDaemon }) => {
    const slug = uniqueSlug("authority");
    const seeded = await seedCapability(loomDaemon.baseURL, slug);
    await openEditor(page, loomDaemon.baseURL, slug);

    await page.getByTestId(`passenv-add-${slug}`).click();
    await page.getByTestId(`passenv-name-${slug}-0`).fill("HTTPS_PROXY");
    await expect(page.getByTestId(`passenv-save-${slug}`)).toBeEnabled();

    // Delete the row out from under the open editor. The client-side mirror accepts `HTTPS_PROXY`
    // happily — it validates the NAME and knows nothing about whether the row still exists — so the
    // only thing that can refuse this save is the daemon, which is exactly the point.
    const del = await fetch(`${loomDaemon.baseURL}/api/capabilities/${encodeURIComponent(seeded.id!)}`, { method: "DELETE" });
    expect(del.ok, "the capability must actually be deleted for this leg to mean anything").toBe(true);

    await page.getByTestId(`passenv-save-${slug}`).click();

    // The daemon's own 400 body, rendered verbatim — not a re-worded client message, and not a silent
    // success. `updateCapabilityDefPassEnv` throws `no capability def with id '<id>'`.
    const saveError = page.getByTestId(`passenv-save-error-${slug}`);
    await expect(saveError).toBeVisible();
    await expect(saveError).toContainText("no capability def with id");
    await expect(saveError).toContainText(seeded.id!);
    // The editor stays OPEN on failure: closing it would discard the names the human typed.
    await expect(page.getByTestId(`capability-passenv-editor-${slug}`)).toBeVisible();
  });

  test("a builtin capability offers no ambient-env editor", async ({ page, loomDaemon }) => {
    const slug = uniqueSlug("builtin-control");
    await seedCapability(loomDaemon.baseURL, slug);

    const catalog = await listCapabilities(loomDaemon.baseURL);
    const builtin = catalog.find((c) => c.builtin);
    expect(builtin, "this daemon must expose at least one builtin capability").toBeTruthy();
    expect(builtin!.id, "a builtin is not a capability_defs row, so it carries no id to PATCH").toBeUndefined();
    expect(builtin!.passEnv, "and no passEnv concept at all").toBeUndefined();

    await page.goto(`${loomDaemon.baseURL}/home?tab=settings`);

    // CONTROL FIRST: the SAME locator shape resolves on an owner-added row. Without this, the zero
    // below would be satisfied by a typo in the testid just as well as by a correct gate.
    await expect(page.getByTestId(`capability-passenv-toggle-${slug}`)).toBeVisible();

    // The gated absence: no toggle, no editor. Withheld rather than shown disabled — a disabled control
    // would imply a setting exists here that merely can't be reached right now.
    await expect(page.getByTestId(`capability-passenv-toggle-${builtin!.slug}`)).toHaveCount(0);
    await expect(page.getByTestId(`capability-passenv-editor-${builtin!.slug}`)).toHaveCount(0);

    // The absence is EXPLAINED, not just silent — on the badge that already marks the row, rather than
    // a second "n/a" badge repeated down every builtin row.
    await expect(page.getByTestId(`capability-builtin-${builtin!.slug}`))
      .toHaveAttribute("title", /no ambient-env allowlist to widen/);
  });
});
