// Hermetic unit test for lib/themePref.ts, the per-browser colour-theme preference (card 593674a7).
// Run standalone with:
//   node --experimental-strip-types packages/web/test/theme-pref.mjs
//
// Pinned here:
//   • anything stored that is not exactly system | light | dark reads as the default;
//   • a storage that THROWS (private mode, blocked site data) reads as the default, and a write to it
//     neither throws nor loses the choice for the page's lifetime;
//   • index.html's inline no-flash script uses the SAME key and the SAME default as the module. They
//     are two copies of one rule (the script must run before any bundle loads), so this is the check
//     that keeps them from drifting apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`ok   ${name}`); };

const MODULE = new URL("../src/lib/themePref.ts", import.meta.url);
let n = 0;
// The module reads storage once at load, so each scenario installs its storage and imports a FRESH
// copy (a distinct query string is a distinct module instance).
async function loadWith(storage) {
  globalThis.localStorage = storage;
  return import(`${MODULE.href}?case=${++n}`);
}
const storeOf = (value) => {
  const data = new Map(value === undefined ? [] : [["loom.theme", value]]);
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    data,
  };
};
const throwing = {
  getItem: () => { throw new Error("SecurityError: storage blocked"); },
  setItem: () => { throw new Error("SecurityError: storage blocked"); },
  removeItem: () => { throw new Error("SecurityError: storage blocked"); },
};

const base = await loadWith(storeOf(undefined));
const { THEME_STORAGE_KEY, THEME_DEFAULT } = base;

await check("the key and default are the agreed literals", () => {
  assert.equal(THEME_STORAGE_KEY, "loom.theme");
  assert.equal(THEME_DEFAULT, "system");
});

await check("parseThemePref keeps the three real values and maps everything else to the default", () => {
  for (const v of ["system", "light", "dark"]) assert.equal(base.parseThemePref(v), v);
  for (const v of [null, undefined, "", "Light", "DARK", " light", "purple", "1", 0, {}]) {
    assert.equal(base.parseThemePref(v), THEME_DEFAULT, `value ${JSON.stringify(v)}`);
  }
});

await check("nothing stored reads as the default", () => {
  assert.equal(base.getThemePref(), THEME_DEFAULT);
});

await check("an invalid stored value reads as the default", async () => {
  const m = await loadWith(storeOf("sepia"));
  assert.equal(m.getThemePref(), THEME_DEFAULT);
  assert.equal(m.getResolvedTheme(), "dark");
});

await check("with nothing stored, the default follows the OS setting, and an unreadable OS setting reads as dark", async () => {
  const withOs = async (dark) => {
    globalThis.window = { matchMedia: (q) => ({ matches: q === "(prefers-color-scheme: dark)" && dark }) };
    try { return await loadWith(storeOf(undefined)); } finally { delete globalThis.window; }
  };
  assert.equal((await withOs(false)).getResolvedTheme(), "light");
  assert.equal((await withOs(true)).getResolvedTheme(), "dark");
  const none = await loadWith(storeOf(undefined)); // no window at all: matchMedia can't be asked
  assert.equal(none.getThemePref(), "system");
  assert.equal(none.getResolvedTheme(), "dark");
});

await check("a valid stored value is read back", async () => {
  const m = await loadWith(storeOf("light"));
  assert.equal(m.getThemePref(), "light");
  assert.equal(m.getResolvedTheme(), "light");
});

await check("a throwing storage reads as the default, and a write neither throws nor is lost", async () => {
  const m = await loadWith(throwing);
  assert.equal(m.getThemePref(), THEME_DEFAULT);
  assert.doesNotThrow(() => m.setThemePref("light"));
  assert.equal(m.getThemePref(), "light");
  assert.equal(m.getResolvedTheme(), "light");
});

await check("setThemePref persists under the key and notifies subscribers with the resolved theme", async () => {
  const store = storeOf(undefined);
  const m = await loadWith(store);
  const seen = [];
  const off = m.subscribeResolvedTheme((t) => seen.push(t));
  m.setThemePref("light");
  m.setThemePref("light"); // no change, no second notification
  m.setThemePref("dark");
  off();
  m.setThemePref("light"); // unsubscribed
  assert.deepEqual(seen, ["light", "dark"]);
  assert.equal(store.data.get("loom.theme"), "light");
});

await check("system resolves from the OS setting; light and dark ignore it", () => {
  assert.equal(base.resolveTheme("system", "light"), "light");
  assert.equal(base.resolveTheme("system", "dark"), "dark");
  assert.equal(base.resolveTheme("light", "dark"), "light");
  assert.equal(base.resolveTheme("dark", "light"), "dark");
});

await check("index.html's no-flash script uses the module's key and default", () => {
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "index.html has an inline <script>");
  const body = script[1];
  assert.ok(body.includes(`localStorage.getItem("${THEME_STORAGE_KEY}")`), `script reads the key "${THEME_STORAGE_KEY}"`);
  assert.ok(body.includes(`var pref = "${THEME_DEFAULT}"`), `script defaults to "${THEME_DEFAULT}"`);
  assert.ok(body.includes(`setAttribute("data-theme"`), "script sets data-theme");
  // It must run before the app's module script, or first paint happens before it.
  assert.ok(html.indexOf("<script>") < html.indexOf('<script type="module"'), "the inline script precedes the module script");
});

console.log(`\n${pass} passed`);
