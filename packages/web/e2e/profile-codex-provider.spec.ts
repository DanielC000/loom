// Card 2ef54430 — the Profiles editor's "Codex model provider" field (human-only; the key never sits on the
// profile, it comes from a bound api-key Connection). Proves two things on the real daemon fixture:
//   (1) the field appears ONLY while the harness is codex (a claude profile never shows it);
//   (2) a custom endpoint bound to a stored api-key Connection saves and round-trips through the REST store,
//       and the stored profile carries a Connection REFERENCE only — never the secret.
// Full mechanism + prohibitions: docs/decisions/2ef54430-codex-provider-endpoint-is-human-only-and-keyless-on-the-profile.md.
import { expect, openActorsProfile, test } from "./fixtures/daemon";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface StoredProfile {
  id: string; name: string; harness?: "claude" | "codex" | null;
  codexProvider?: { id: string; baseUrl?: string; connectionId?: string } | null;
}

// Everything this file seeds is deleted in afterEach (a plain fetch DELETE that THROWS on !ok — a quiet
// cleanup failure would leak a codex-pinned profile into sibling specs that count page-wide harness tags).
const seeded: { baseURL: string; kind: "profiles" | "connections"; id: string }[] = [];

test.afterEach(async () => {
  for (const { baseURL, kind, id } of seeded.splice(0, seeded.length).reverse()) {
    const res = await fetch(`${baseURL}/api/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`cleanup: DELETE ${kind}/${id} -> ${res.status}: ${await res.text()}`);
  }
});

const SECRET = "sk_e2e_codex_provider_secret_value";
const HOST = "api.codex-provider-e2e.test";

test.describe("codex provider field on the Profiles editor", () => {
  test("appears only on the codex harness, and a custom endpoint bound to an api-key connection round-trips", async ({ page, loomDaemon }) => {
    const base = loomDaemon.baseURL;
    const connection = await apiJson<{ id: string; name: string }>(`${base}/api/connections`, {
      method: "POST",
      body: JSON.stringify({ name: `E2E Codex Provider Conn ${Date.now()}`, host: HOST, authScheme: "api-key", secret: SECRET }),
    });
    seeded.push({ baseURL: base, kind: "connections", id: connection.id });
    const profile = await apiJson<StoredProfile>(`${base}/api/profiles`, {
      method: "POST", body: JSON.stringify({ name: `Rig Codex Provider ${Date.now()}` }),
    });
    seeded.push({ baseURL: base, kind: "profiles", id: profile.id });
    // Identity of the fixture first: unset harness, no provider, so a later read-back can't come from a stale value.
    expect(profile.harness ?? null).toBeNull();
    expect(profile.codexProvider ?? null).toBeNull();

    await openActorsProfile(page, base, profile.name);

    // (1) NEGATIVE CONTROL: on the default (claude) harness the field is absent.
    const field = page.getByTestId("codex-provider-field");
    await expect(field).toHaveCount(0);

    // Switch to codex: the field appears, defaulting to "no custom endpoint".
    await page.getByTestId("harness-card-codex").click();
    await expect(field).toBeVisible();
    await expect(page.getByTestId("codex-provider-mode")).toHaveValue("default");

    // Switching back to claude removes it again (it is bound to the harness, not sticky).
    await page.getByTestId("harness-card-claude").click();
    await expect(field).toHaveCount(0);
    await page.getByTestId("harness-card-codex").click();
    await expect(field).toBeVisible();

    // (2) Choose a custom endpoint, fill it, and bind the stored connection.
    await page.getByTestId("codex-provider-mode").selectOption("custom");
    await page.getByTestId("codex-provider-id").fill("myhost");
    await page.getByTestId("codex-provider-url").fill(`https://${HOST}/v1`);
    await page.getByTestId("codex-provider-connection").selectOption(connection.id);

    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();

    await expect.poll(async () => (await apiJson<StoredProfile>(`${base}/api/profiles/${encodeURIComponent(profile.id)}`)).harness).toBe("codex");
    const rawStored = await (await fetch(`${base}/api/profiles/${encodeURIComponent(profile.id)}`)).text();
    const stored = JSON.parse(rawStored) as StoredProfile;
    expect(stored.codexProvider).toEqual({ id: "myhost", baseUrl: `https://${HOST}/v1`, connectionId: connection.id });
    // The key never sits on the profile: only the Connection reference is stored.
    expect(rawStored).not.toContain(SECRET);
    await expect(page.getByTestId("profile-save-error")).toHaveCount(0);

    // Reload: the saved endpoint is what the editor re-renders (round-trip through the store, not local state).
    await openActorsProfile(page, base, profile.name);
    await expect(page.getByTestId("codex-provider-mode")).toHaveValue("custom");
    await expect(page.getByTestId("codex-provider-url")).toHaveValue(`https://${HOST}/v1`);
    await expect(page.getByTestId("codex-provider-connection")).toHaveValue(connection.id);
  });
});
