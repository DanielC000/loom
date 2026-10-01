// Card 6232fe9d — a codex rig carrying legacy restrictedTools / capabilities must be SAVEABLE.
//
// THE DEFECT reproduced here: the Profiles editor DISABLED the fields the codex validator rejects
// (`restrictedTools`, and the capabilities group that backs `browserTesting`/`documentConversion`) while
// still SENDING their stored values. `profiles/validate.ts` refuses that combination outright
// (codexRestrictedToolsUnsupportedError / codexStdioCapabilityUnsupportedError, both reading
// `profiles/codex-compat.ts`), so flipping a QA-Tester- or Web-Designer-shaped rig onto codex 400'd on
// EVERY save — with the one control that could have cleared the blocker greyed out, and (because
// `save.error` was never rendered) no visible error at all. The rig was unreachable in both directions.
//
// Deliberately a SIBLING of profile-harness.spec.ts rather than an extension of it: that spec is about the
// per-field ANNOTATIONS being present and correctly severity-tagged, this one is about the SAVE landing.
// Full narrative + prohibitions: docs/decisions/6232fe9d-codex-rejected-vs-dropped-fields.md.
import { expect, test, type Page } from "./fixtures/daemon";

/**
 * Collect every native dialog the page raises, accepting each one. Mirrors mutation-error-alert.spec.ts's
 * helper — Playwright auto-dismisses dialogs, so a DOM assertion can never see a modal stacked over the
 * inline message, and counting `page.on("dialog")` is the only thing that can. Read the returned array
 * AFTER awaiting an observable settle, never straight after the click: the handler fires asynchronously.
 */
function collectDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.message());
    void d.accept();
  });
  return seen;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededProfile {
  id: string; name: string; harness?: "claude" | "codex" | null;
  restrictedTools?: boolean; browserTesting?: boolean; documentConversion?: boolean;
  capabilities?: { slug: string; connectionId?: string }[] | null;
  model?: string | null; skills?: string[] | null; allowDelta?: string[];
}

// ⚠️ Every profile this file seeds is DELETED in afterEach, and that cleanup is load-bearing rather than
// tidiness. The `loomDaemon` fixture is worker-scoped and the suite runs `workers:1`, so one store is
// shared across every spec file — and this file's whole subject is leaving profiles pinned to `codex`.
// `profile-harness.spec.ts` asserts a PAGE-WIDE `harness-tag` count of 0 for a freshly seeded rig, and the
// sidebar badges every codex row, so a leaked profile from here fails that sibling spec (observed: it
// counted 2) in a file that has nothing to do with this card. Alphabetical file order puts this spec first,
// so the leak lands downstream every time.
const seeded: { baseURL: string; id: string }[] = [];

const seedProfile = async (baseURL: string, body: Record<string, unknown>) => {
  const p = await apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });
  seeded.push({ baseURL, id: p.id });
  return p;
};

const getProfile = (baseURL: string, id: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles/${encodeURIComponent(id)}`);

// ⚠️ NOT via `apiJson`, and NOT swallowed. A bodyless DELETE still carrying `content-type:
// application/json` is rejected by Fastify ("Body cannot be empty…"), so routing it through the helper
// above made every delete fail — and a `try {} catch {}` around it reported a clean run while leaking the
// exact two codex rows this hook exists to remove. A cleanup that fails quietly is worse than none: it
// breaks a DIFFERENT spec file, so this one throws and fails loudly in its own file instead.
test.afterEach(async () => {
  for (const { baseURL, id } of seeded.splice(0, seeded.length)) {
    const res = await fetch(`${baseURL}/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`cleanup: DELETE profile ${id} -> ${res.status}: ${await res.text()}`);
  }
});

// A QA-Tester-/Web-Designer-shaped rig: the real bundled rigs carry BOTH blocker classes at once — the
// fail-open one (`restrictedTools`) and the stdio-capability ones (browserTesting/documentConversion).
// Seeded on CLAUDE, the only harness this combination is valid on, which is itself the point: the stored
// state is legitimate and only the codex SWITCH makes it unsaveable.
const BLOCKED_RIG = { restrictedTools: true, browserTesting: true, documentConversion: true } as const;

test.describe("codex profile with legacy restrictedTools / capabilities", () => {
  test("switching a blocked rig onto codex saves, clearing exactly the rejected fields", async ({ page, loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, {
      name: `Rig Codex Save ${Date.now()}`, ...BLOCKED_RIG, model: "claude-opus-4-8", allowDelta: ["Read(*)"],
    });
    // Assert the fixture's identity FIRST: all three blockers must really be stored and the harness must
    // really be unset, or a later "harness === codex" read-back could come from a pre-existing value and
    // the whole check would pass vacuously against a rig that was never in the broken state.
    expect(profile.harness ?? null).toBeNull();
    expect(profile.restrictedTools).toBe(true);
    expect(profile.browserTesting).toBe(true);
    expect(profile.documentConversion).toBe(true);

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    const restrictedToggle = page.locator("label", { hasText: "Restricted tools" }).locator('input[type="checkbox"]');
    const browserToggle = page.locator("label", { hasText: "Browser testing" }).locator('input[type="checkbox"]');
    const docToggle = page.locator("label", { hasText: "Document conversion" }).locator('input[type="checkbox"]');

    // BEFORE (on claude): every blocker reads ON and is live, and no warning is on screen. The negative
    // control — it proves the warning asserted below is produced by the codex switch, not always present.
    await expect(restrictedToggle).toBeChecked();
    await expect(browserToggle).toBeChecked();
    await expect(docToggle).toBeChecked();
    await expect(page.getByTestId("harness-reject-warning")).toHaveCount(0);

    // ACT: pick codex.
    await page.getByTestId("harness-card-codex").click();

    // The warning names every field Save will remove, per field, BEFORE the click — the card's "never
    // silently send values the validator rejects", satisfied by telling the user and letting them consent.
    const warning = page.getByTestId("harness-reject-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Restricted tools");
    await expect(warning).toContainText("Browser testing");
    await expect(warning).toContainText("Document conversion");
    // Still set until the save, so backing out now costs nothing — and the copy says exactly that.
    await expect(restrictedToggle).toBeChecked();
    await expect(warning).toContainText("switch back to Claude Code now and nothing is lost");

    // THE SAVE — the whole card. Pre-fix this 400s and the store keeps `harness: null`.
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();

    // AFTER: the harness really landed, and exactly the rejected fields were cleared to let it.
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).harness).toBe("codex");
    const stored = await getProfile(loomDaemon.baseURL, profile.id);
    expect(stored.restrictedTools).toBe(false);
    expect(stored.browserTesting).toBe(false);
    expect(stored.documentConversion).toBe(false);
    // …and NOTHING beyond the rejection set was touched. `model`/`allowDelta` are DROPPED at the codex
    // spawn but the validator stores them happily, so they must survive — clearing them would be this fix
    // overreaching from "what codex refuses to store" into "what codex ignores", the exact conflation the
    // card exists to undo.
    expect(stored.model).toBe("claude-opus-4-8");
    expect(stored.allowDelta).toEqual(["Read(*)"]);
    // No error was surfaced: the save really succeeded rather than failing behind a now-visible message.
    await expect(page.getByTestId("profile-save-error")).toHaveCount(0);

    // The editor converges rather than latching dirty forever: the controls read OFF (honest — the values
    // are genuinely gone from the store now) and the editor settles to "saved".
    await expect(restrictedToggle).not.toBeChecked();
    await expect(browserToggle).not.toBeChecked();
    await expect(docToggle).not.toBeChecked();
    await expect(page.getByText("saved", { exact: true })).toBeVisible();
    // Nothing left to remove ⇒ the warning retires itself instead of standing as a permanent scold.
    await expect(warning).toHaveCount(0);
    // The drop summary DOES remain — codex still ignores model/skills/allowDelta at spawn. Keeping these
    // two assertions adjacent is deliberate: it pins that the fix retired the REJECTION warning only, and
    // did not take the (still true) consumption annotation down with it.
    await expect(page.getByTestId("harness-drop-summary")).toBeVisible();
  });

  test("the drop summary promises 'stays stored' only for the fields codex really stores", async ({ page, loomDaemon }) => {
    // The summary used to promise all five dropped fields "stay stored and become live again if you switch
    // back", which was FALSE for the two codex also refuses to store — a sentence the save itself
    // contradicted. The counts/labels are now derived from the two field sets, so this asserts the split.
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Drop Copy ${Date.now()}` });

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await page.getByTestId("harness-card-codex").click();

    const summary = page.getByTestId("harness-drop-summary");
    await expect(summary).toBeVisible();
    // The three it genuinely keeps are named…
    await expect(summary).toContainText("Skills");
    await expect(summary).toContainText("Model");
    await expect(summary).toContainText("Allow delta");
    // …and the two it does not are NOT inside the "stay stored" promise. Asserted as absence from the
    // summary specifically (not from the page), since "Restricted tools" is of course still the label of
    // its own control further down.
    await expect(summary).not.toContainText("Restricted tools");
    await expect(summary).not.toContainText("Capabilities");
    await expect(summary).toContainText("Codex refuses to store");
  });

  test("a clean rig switches to codex with no warning and nothing cleared", async ({ page, loomDaemon }) => {
    // The other polarity. Without it, "the warning appears" could just mean it always appears on codex,
    // and "the rejected fields were cleared" could just mean the fix clears unconditionally.
    const profile = await seedProfile(loomDaemon.baseURL, {
      name: `Rig Codex Clean ${Date.now()}`, model: "claude-opus-4-8",
    });
    expect(profile.restrictedTools).toBe(false);
    expect(profile.browserTesting).toBe(false);

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await page.getByTestId("harness-card-codex").click();

    // The drop summary still shows (fields codex ignores at spawn — a separate, pre-existing concern); the
    // REJECT warning must not, because this rig holds nothing to remove.
    await expect(page.getByTestId("harness-drop-summary")).toBeVisible();
    await expect(page.getByTestId("harness-reject-warning")).toHaveCount(0);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).harness).toBe("codex");
    expect((await getProfile(loomDaemon.baseURL, profile.id)).model).toBe("claude-opus-4-8");
  });

  test("a refused save surfaces the daemon's reason instead of failing silently", async ({ page, loomDaemon }) => {
    // `save.error` was thrown away, which is WHY the 400 above was invisible: the editor just stayed dirty,
    // indistinguishable from a Save button that does nothing.
    //
    // ⚠️ WHAT THIS DOES AND DOES NOT PROVE. The rejection is injected by intercepting the PUT, because once
    // this card's fix lands there is no refusal left that this editor can actually produce: the codex
    // combination is cleared before it is sent, and every other `validateProfile` rejection is unreachable
    // from these controls (the two carry-forward-only roles render LOCKED in the RolePicker, and `assistant`
    // is `confer:"hidden"`, so no role-based refusal is clickable). So this proves the CLIENT half only —
    // that a 400's `{error}` body reaches the reader verbatim. That the daemon refuses these combinations at
    // all is the daemon's own tests' job, not this spec's.
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Save Error ${Date.now()}` });

    const dialogs = collectDialogs(page);
    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await expect(page.getByTestId("profile-save-error")).toHaveCount(0); // negative control

    // The real wording of the refusal this card is about, so the assertion pins the field-naming text a
    // reader actually needs rather than a synthetic string.
    const reason = 'invalid profile: restrictedTools is not supported on harness "codex"';
    await page.route(`**/api/profiles/${profile.id}`, async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: reason }) });
    });

    // Any dirtying edit will do — the point is the response handling, not which field changed.
    await page.getByTestId("harness-card-codex").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const err = page.getByTestId("profile-save-error");
    await expect(err).toBeVisible();
    await expect(err).toContainText("restrictedTools is not supported");
    // The store is untouched — the message reports a real refusal rather than decorating a success.
    expect((await getProfile(loomDaemon.baseURL, profile.id)).harness ?? null).toBeNull();
    // ...and NOTHING alerted on top of it. `save` sets `meta: { inlineError: true }` to stand the
    // MutationCache down (card ad42a127); drop that meta and this line is the only assertion in the file
    // that fails, because every DOM check above passes just as happily with a modal over the page.
    // Asserted after the settles above, so this is a real absence rather than a dialog that hadn't fired.
    expect(dialogs, "a refused save renders inline — it must not ALSO alert").toEqual([]);
  });
});
