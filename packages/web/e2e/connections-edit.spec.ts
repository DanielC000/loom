// Editing a stored connection from Settings → Connections (card 923dfc9d): change the name, change the host,
// rotate the secret — each visible after a reload, and the secret never shown or returned.
//
// Measured against real state, never "a control rendered": every claim is read back from the daemon's own
// list (and the page after a reload), and the secret claim is checked on the page text/HTML, the edit form's
// secret field (starts EMPTY — there is nothing to pre-fill it from) and the API list body.
//
// The ssh half proves the re-pin rule through the UI: changing the host without pinning the new host's
// fingerprint is refused before any request is sent, and a user-only change saves with no re-pin.
import { expect, test, type Page } from "./fixtures/daemon";
import { generateParseableEd25519 } from "./fixtures/ssh-keys";

const uniq = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface ConnRow { id: string; name: string; host: string; authScheme: string; user?: string; port?: number; hostKeyFingerprint?: string }

const listConns = (base: string) => apiJson<ConnRow[]>(`${base}/api/connections`);

async function openSettings(page: Page, base: string) {
  await page.goto(`${base}/home?tab=settings`);
}

test("edit a bearer connection: rename, move host, rotate the secret — all visible after reload, secret never shown", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);
  const base = loomDaemon.baseURL;
  const oldSecret = uniq("sk-old-secret");
  const newSecret = uniq("sk-new-secret");
  const name = uniq("Edit Me");
  const created = await apiJson<ConnRow>(`${base}/api/connections`, { method: "POST", body: JSON.stringify({ name, host: "old.example.com", authScheme: "bearer", secret: oldSecret }) });
  const renamed = `${name}-renamed`;
  try {
    await openSettings(page, base);
    const row = page.getByTestId(`connection-row-${created.id}`);
    await expect(row).toBeVisible();
    await page.getByTestId(`connection-edit-open-${created.id}`).click();

    const form = page.getByTestId(`connection-edit-${created.id}`);
    await expect(form.getByLabel("Connection name")).toHaveValue(name);
    await expect(form.getByLabel("Connection host")).toHaveValue("old.example.com");
    // The secret field starts EMPTY: there is no server read that carries it, so nothing to pre-fill.
    await expect(form.getByLabel("New connection secret")).toHaveValue("");

    await form.getByLabel("Connection name").fill(renamed);
    await form.getByLabel("Connection host").fill("new.example.com");
    await form.getByLabel("New connection secret").fill(newSecret);
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form).toHaveCount(0);

    // The daemon's own list, not the page's optimistic state.
    await expect.poll(async () => (await listConns(base)).find((c) => c.id === created.id)?.name).toBe(renamed);
    expect((await listConns(base)).find((c) => c.id === created.id)).toMatchObject({ id: created.id, host: "new.example.com", authScheme: "bearer" });

    // Reload: the change persists on the page; the id (so every grant naming it) is unchanged.
    await page.reload();
    const reloaded = page.getByTestId(`connection-row-${created.id}`);
    await expect(reloaded).toContainText(renamed);
    await expect(reloaded).toContainText("new.example.com");

    // The secret is never shown: not on the page, not in the list body — old or new.
    const pageText = await page.locator("body").innerText();
    const pageHtml = await page.content();
    const listRaw = await (await fetch(`${base}/api/connections`)).text();
    for (const s of [oldSecret, newSecret]) {
      expect(pageText.includes(s) || pageHtml.includes(s), `the secret must not appear on the page (${s.slice(0, 7)}…)`).toBe(false);
      expect(listRaw.includes(s), "the secret must not appear in the list response").toBe(false);
    }
    // Reopening the editor still shows an empty secret field (blank = keep the stored one).
    await page.getByTestId(`connection-edit-open-${created.id}`).click();
    await expect(page.getByTestId(`connection-edit-${created.id}`).getByLabel("New connection secret")).toHaveValue("");
  } finally {
    await fetch(`${base}/api/connections/${created.id}`, { method: "DELETE" }).catch(() => {});
  }
});

test("edit an ssh connection: a user-only change saves with no re-pin; a host change without a new pin is refused", async ({ page, loomDaemon }) => {
  test.setTimeout(90_000);
  const base = loomDaemon.baseURL;
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ssh2: any = createRequire(path.resolve(here, "..", "..", "daemon", "package.json"))("ssh2");
  const key: { private: string } = generateParseableEd25519(ssh2.utils);
  const pin = `SHA256:${"A".repeat(43)}`;
  const name = uniq("Edit SSH");
  const created = await apiJson<ConnRow>(`${base}/api/connections/ssh`, {
    method: "POST",
    body: JSON.stringify({ name, host: "nas.example.invalid", port: 22, user: "loom", privateKey: key.private, hostKeyFingerprint: pin }),
  });
  try {
    await openSettings(page, base);
    await expect(page.getByTestId(`connection-row-${created.id}`)).toBeVisible();
    await page.getByTestId(`ssh-edit-open-${created.id}`).click();
    const form = page.getByTestId(`ssh-edit-${created.id}`);
    // The key is never pre-filled: the replacement field starts empty.
    await expect(form.getByLabel("Replacement private key")).toHaveValue("");

    // Host change with the old pin still in place is cleared + refused client-side, and nothing is sent.
    await form.getByLabel("SSH host").fill("other.example.invalid");
    await expect(form.getByLabel("Pinned host key fingerprint"), "a host change clears the OLD address's pin").toHaveValue("");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form.getByRole("alert")).toContainText("pin the new host's key fingerprint");
    expect((await listConns(base)).find((c) => c.id === created.id)?.host, "the refused edit changed nothing").toBe("nas.example.invalid");

    // Back to the original host (the pin is NOT restored automatically), then a user-only edit needs no re-pin.
    await page.getByTestId(`ssh-edit-${created.id}`).getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId(`ssh-edit-open-${created.id}`).click();
    await expect(page.getByTestId(`ssh-edit-${created.id}`).getByLabel("Pinned host key fingerprint")).toHaveValue(pin);
    await page.getByTestId(`ssh-edit-${created.id}`).getByLabel("SSH user").fill("deploy");
    await page.getByTestId(`ssh-edit-${created.id}`).getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await listConns(base)).find((c) => c.id === created.id)?.user).toBe("deploy");
    expect((await listConns(base)).find((c) => c.id === created.id)).toMatchObject({ host: "nas.example.invalid", hostKeyFingerprint: pin });

    await page.reload();
    await expect(page.getByTestId(`ssh-target-${created.id}`)).toHaveText("deploy@nas.example.invalid:22");
    const body = `${await page.locator("body").innerText()}${await page.content()}`;
    const marker = key.private.split("\n").filter((l) => l && !l.includes("-----")).join("").slice(40, 90);
    expect(body.includes(marker), "the stored key must not appear on the page").toBe(false);
  } finally {
    await fetch(`${base}/api/connections/${created.id}`, { method: "DELETE" }).catch(() => {});
  }
});
