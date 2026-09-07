// Profile harness control spec (card fa2277b6) — proves the Profiles editor's `harness` control exists,
// persists over the real human-only REST path, and — the part the card would not accept skipped — that it
// does NOT leave a false green beside itself.
//
// `harness` was settable ONLY by hand-crafting a loopback PUT: it is on the daemon's
// AGENT_FORBIDDEN_PROFILE_KEYS, so no agent MCP tool can write it, and until this card there was no human
// surface either. Once it reads `codex`, five other Profile fields stop being read at spawn entirely
// (verified at source against pty/host.ts — `spawn()` dispatches to `spawnCodexProcess` as its first
// statement, and that path reads only sessionId/cwd/geometry/role/startupPrompt). Rendering those five as
// live controls beside a codex rig manufactures exactly the "reads ON, applies nothing" state cards
// `0770d916` and `d34dd208` exist to eliminate — so this spec asserts the annotation appears, that it
// carries the right FAILURE DIRECTION per field, and that it disappears again on claude.
//
// Builds on the shared `loomDaemon` fixture; profiles-agents.spec.ts is the template. Seeds its own
// uniquely-named profile over REST and never touches a BUNDLED profile, so the shared store stays clean.
import { expect, test } from "./fixtures/daemon";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface SeededProfile {
  id: string; name: string; harness?: "claude" | "codex";
  restrictedTools?: boolean; model?: string | null;
}

const seedProfile = (baseURL: string, body: Record<string, unknown>) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles`, { method: "POST", body: JSON.stringify(body) });

const getProfile = (baseURL: string, id: string) =>
  apiJson<SeededProfile>(`${baseURL}/api/profiles/${encodeURIComponent(id)}`);

// Every profile field the codex spawn path drops, paired with the failure DIRECTION the UI must show.
// Severity is not decoration: a dropped SAFETY toggle fails OPEN and is categorically worse than a
// capability that is merely absent, so flattening them into one grey "unsupported" would hide the only
// distinction that matters here (card 0770d916's own triage rule).
const DROPPED: ReadonlyArray<{ field: string; severity: string }> = [
  { field: "restrictedTools", severity: "fail-open" },
  { field: "capabilities", severity: "fail-closed" },
  { field: "skills", severity: "fail-closed" },
  { field: "model", severity: "inert" },
  { field: "allowDelta", severity: "inert" },
];

test.describe("profile harness control", () => {
  test("harness defaults to claude and switches to codex", async ({ page, loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Harness ${Date.now()}` });
    // Assert the fixture's identity: this seeded row must start with NO harness pinned, so a later
    // "codex" read-back can only have come from this test's own Save (never a pre-existing value).
    expect(profile.harness ?? null).toBeNull();

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    const picker = page.getByTestId("harness-picker");
    const claudeCard = page.getByTestId("harness-card-claude");
    const codexCard = page.getByTestId("harness-card-codex");
    await expect(picker).toBeVisible();

    // BEFORE: an untouched profile reads as claude (absent ⇒ the default), not as an unset third state.
    await expect(claudeCard).toHaveAttribute("data-selected", "true");
    await expect(codexCard).toHaveAttribute("data-selected", "false");
    // …and nothing is badged as codex anywhere yet (neither the sidebar row nor the editor header).
    await expect(page.getByTestId("harness-tag")).toHaveCount(0);

    // The implications of picking codex are stated AT the point of choice (card item 4) — a different
    // vendor binary, approvals disabled in its own sandbox, and a different subscription billed.
    await expect(codexCard).toContainText("Spawns the codex binary on this host");
    await expect(codexCard).toContainText("-a never -s workspace-write");
    await expect(codexCard).toContainText("ChatGPT subscription");

    // ACT + AFTER (observable #1 — interactive selection flips local state immediately, no Save needed).
    await codexCard.click();
    await expect(codexCard).toHaveAttribute("data-selected", "true");
    await expect(claudeCard).toHaveAttribute("data-selected", "false");
    // Exactly ONE tag — the editor header, reflecting the unsaved local choice (card item 5's editor
    // half). The sidebar row deliberately reads the STORE, so it must NOT badge a rig whose codex
    // selection has not been saved; it gains its own tag once persistence works (see the fixme below).
    await expect(page.getByTestId("harness-tag")).toHaveCount(1);

    // The choice makes the editor dirty, so Save is offered — the write path is wired.
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  // The acceptance evidence for card item 1. This was parked as `test.fixme` on the first pass, when
  // `validateProfile` accepted `harness` in its zod schema but omitted it from the object literal it
  // returns as `v.value` — and both REST handlers persist `v.value`, never `req.body`, so the field was
  // dropped between validation and the write and NO route could set it. Un-parked once that one-line
  // omission was fixed (packages/daemon/src/profiles/validate.ts).
  test("harness persists over REST and re-reads after a reload", async ({ page, loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, { name: `Rig Harness Persist ${Date.now()}` });
    expect(profile.harness ?? null).toBeNull();

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await page.getByTestId("harness-card-codex").click();

    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(async () => (await getProfile(loomDaemon.baseURL, profile.id)).harness).toBe("codex");

    // The sidebar row badges it too (card item 5): a rig that spawns a different binary is identifiable
    // without opening it. Two tags = the editor header + this profile's list row.
    await expect(page.getByTestId("harness-tag")).toHaveCount(2);

    // AFTER a reload the choice is still there — it came from the store, not from local component state.
    await page.reload();
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();
    await expect(page.getByTestId("harness-card-codex")).toHaveAttribute("data-selected", "true");
  });

  test("selecting codex annotates every silently-dropped field with its failure direction", async ({ page, loomDaemon }) => {
    // Seed the field that matters most already ON: `restrictedTools` is the one FAIL-OPEN drop — a safety
    // toggle that would otherwise read ON in the UI while removing nothing from the spawned rig. This is
    // the exact false-green state the card would bounce this work for, so the fixture reproduces it.
    const profile = await seedProfile(loomDaemon.baseURL, {
      name: `Rig Drops ${Date.now()}`, restrictedTools: true, model: "claude-opus-4-8",
    });
    expect(profile.restrictedTools).toBe(true);

    await page.goto(`${loomDaemon.baseURL}/actors`);
    await page.getByRole("button").filter({ hasText: profile.name }).first().click();

    const restrictedToggle = page.locator("label", { hasText: "Restricted tools" }).locator('input[type="checkbox"]');
    const modelInput = page.getByPlaceholder("engine default (e.g. claude-opus-4-8)");

    // BEFORE (on claude): the toggle reads ON and IS applied — no annotation, controls live. This is the
    // negative-control half: it proves the annotations below are produced by the harness switch and not
    // simply always present.
    await expect(restrictedToggle).toBeChecked();
    await expect(restrictedToggle).toBeEnabled();
    await expect(modelInput).toBeEnabled();
    await expect(page.getByTestId("harness-drop-summary")).toHaveCount(0);
    for (const { field } of DROPPED) await expect(page.getByTestId(`harness-drop-${field}`)).toHaveCount(0);

    // ACT: switch this rig onto codex.
    await page.getByTestId("harness-card-codex").click();

    // AFTER: the summary appears and every dropped field is annotated with its own failure direction.
    await expect(page.getByTestId("harness-drop-summary")).toBeVisible();
    for (const { field, severity } of DROPPED) {
      const drop = page.getByTestId(`harness-drop-${field}`);
      await expect(drop).toBeVisible();
      await expect(drop).toHaveAttribute("data-severity", severity);
    }

    // The FAIL-OPEN one is called out as not enforced, in its own words — not lumped in with the merely
    // absent capabilities. The checkbox still reads ON (the stored value is preserved, and becomes live
    // again on claude), which is precisely why the correction has to sit next to it.
    await expect(restrictedToggle).toBeChecked();
    await expect(page.getByTestId("harness-drop-restrictedTools")).toContainText("not enforced on codex");

    // Every annotated control is also DISABLED, so codex cannot be used to newly set a value that will be
    // silently ignored — the false green can be read, but no longer manufactured.
    await expect(restrictedToggle).toBeDisabled();
    await expect(modelInput).toBeDisabled();

    // The Skills caption asserting "ALL skills delivered" is suppressed rather than left to say the
    // opposite of what codex does (it injects no skills at all).
    await expect(page.getByText(/none selected → ALL skills delivered/)).toHaveCount(0);

    // AND IT REVERSES: switching back to claude clears every annotation and re-enables every control, so
    // the disabled state tracks the live choice rather than latching on first codex selection.
    await page.getByTestId("harness-card-claude").click();
    await expect(page.getByTestId("harness-drop-summary")).toHaveCount(0);
    for (const { field } of DROPPED) await expect(page.getByTestId(`harness-drop-${field}`)).toHaveCount(0);
    await expect(restrictedToggle).toBeEnabled();
    await expect(modelInput).toBeEnabled();
    await expect(page.getByText(/none selected → ALL skills delivered/)).toBeVisible();
  });

  // 🔴 THE SILENT-CLOBBER CASE. `PUT /api/profiles/:id` takes a PARTIAL patch, so the moment `harness`
  // became persistable the question is whether a save that OMITS it wipes an existing `codex`.
  //
  // It does not, and the reason is structural rather than per-field: the handler merges the patch over the
  // stored profile FIRST and validates the RESULT (`validateProfile({ ...base, ...patch })`), so an
  // omitted key resolves to the stored value before it is ever written. That means the protection covers
  // every sibling field by the same mechanism, which is why this test asserts a couple of them alongside
  // harness — a check that only covered `harness` would pass just as happily against a per-field special
  // case that leaves the others exposed.
  test("a partial PUT that omits harness does NOT clear it (nor clobber its siblings)", async ({ loomDaemon }) => {
    const profile = await seedProfile(loomDaemon.baseURL, {
      name: `Rig Partial ${Date.now()}`, harness: "codex", model: "claude-opus-4-8", restrictedTools: true,
    });
    // Assert the fixture's identity: seeding itself must have persisted all three, or the clobber check
    // below would pass vacuously against a row that never held the values in the first place.
    expect(profile.harness).toBe("codex");
    expect(profile.model).toBe("claude-opus-4-8");
    expect(profile.restrictedTools).toBe(true);

    // A minimal, realistic partial save touching ONE unrelated field — the shape any non-UI REST caller
    // (or a future narrower form) would send.
    const after = await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, {
      method: "PUT", body: JSON.stringify({ description: "edited, harness untouched" }),
    });
    expect(after.harness).toBe("codex");
    expect(after.model).toBe("claude-opus-4-8");
    expect(after.restrictedTools).toBe(true);

    // And it survives a re-read, not just the PUT's own echoed response.
    const reread = await getProfile(loomDaemon.baseURL, profile.id);
    expect(reread.harness).toBe("codex");

    // The converse must also work, or "never clears" would just mean "write-once": an EXPLICIT
    // harness:"claude" has to actually move the rig back off codex.
    const reverted = await apiJson<SeededProfile>(`${loomDaemon.baseURL}/api/profiles/${profile.id}`, {
      method: "PUT", body: JSON.stringify({ harness: "claude" }),
    });
    expect(reverted.harness).toBe("claude");
  });
});
