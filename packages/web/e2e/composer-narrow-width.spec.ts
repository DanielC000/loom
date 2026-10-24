// The shared Composer at narrow widths (card d8535561).
//
// THE DEFECT. The composer's one row held a fixed 176px control column (Voice + the language picker,
// then Send turn) beside a textarea whose own UA intrinsic width is a ~232px floor it could not shrink
// past. Neither column could give and the row could not wrap, so it rendered 414px wide whatever it was
// given: 414-in-306 on classic `/session/:id` at a 420px viewport (108px past its own edge), 414-in-380
// on the Atlas session node (34px). What ran off the end was the language picker and most of the Send
// button — controls the reader could neither see nor click.
//
// THE INSTRUMENT, and why it is not the obvious one. `documentElement.scrollWidth > clientWidth` cannot
// answer this: on classic the page already overflows for reasons that have nothing to do with the
// composer (the xterm grid is a fixed 120 columns, the rail's own labels), and on Atlas it never
// overflows at all because `.loom-atlas-content` scrolls — so the page-level reading is red pre-fix in
// one shell and green pre-fix in the other, for reasons unrelated to this card either way. What IS
// diagnostic is a box-level census SCOPED to the composer: an element that pushes content past its own
// edge (`scrollWidth > clientWidth`) *while declaring `overflow-x: visible`* has nowhere to put it —
// nothing scrolls, nothing clips, it simply draws outside its parent. A scroll container reading
// `scrollWidth > clientWidth` is doing its job, so filtering on each box's OWN computed `overflow-x`
// is what separates the defect from the legitimate case. (See also the page-vs-box distinction in
// docs/decisions/a7957bde-mission-control-activity-row-narrow-widths.md, which is the ANCESTOR-chain
// version of the same idea; this spec needs the per-box form because the composer sits inside a
// scrolling ancestor on Atlas.)
//
// WHY EACH LEG IS SEPARATELY FALSIFIABLE. "Nothing overflows" is satisfiable by a composer that
// collapsed to nothing, so it is never asserted alone:
//   • the POPULATION leg pins that the row, the control column and the voice row are all present and
//     rendered, so the census had something to measure;
//   • the CONTAINMENT leg reads every control's own rect against the row's and requires each to sit
//     inside it with real width — a control that fits only by shrinking to 0 fails here, not silently;
//   • the SHAPE leg requires the control column to sit on its own line BELOW the box at 420 and on the
//     SAME line at 1440. Without it, a build that fixed the overflow by permanently stacking the
//     controls (or by crushing the textarea to 124px, which `minWidth: 0` alone would have done) reads
//     green — the wrap is supposed to be a narrow-width behaviour, not a restructure.
// Both Atlas states are checked because the two shells give the composer different boxes (306px vs
// 380px at the same 420px viewport) and the classic one is the narrower, harder case.
import { expect, test, type Locator, type Page } from "./fixtures/daemon";

// lib/atlasUi.ts owns this key and the "1" = on encoding. Hardcoded because the e2e tsconfig covers
// `e2e/` only and cannot pull `src/` in (same reason atlas-wave-replay.spec.ts hardcodes it).
const ATLAS_KEY = "loom.atlasUi";
// lib/useVoiceLang.ts owns this one, for the same reason.
const VOICE_LANG_KEY = "loom.voiceLang";

const DRAFT = "a half-written turn that must survive the wrap";

type OverflowBox = { el: string; over: number; clientWidth: number; scrollWidth: number; text: string };

/** Every control locator is scoped to the composer itself: the session card's own "Stop" button carries
 *  the same accessible name the mic button wears while recording, and a page-wide lookup resolves both. */
const composer = (page: Page) => page.getByTestId("composer");
const composerBox = (page: Page) => composer(page).getByPlaceholder("Send a turn to this session", { exact: false });
const sendButton = (page: Page) => composer(page).getByRole("button", { name: "Send turn" });
const voiceButton = (page: Page) => composer(page).getByRole("button", { name: /^(Voice|Stop|starting…)$/ });
const langSelect = (page: Page) => composer(page).getByLabel("Voice recognition language");

/**
 * Every box in the composer subtree (root inclusive) that draws outside its own edge with nowhere to
 * put the overflow. Returns the offenders, not a count, so a failure names what actually broke.
 */
async function overflowingBoxes(page: Page): Promise<OverflowBox[]> {
  return page.getByTestId("composer").evaluate((root) => {
    const describe = (el: Element) => {
      const tid = el.getAttribute("data-testid");
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)[0];
      return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ""}${cls ? `.${cls}` : ""}`;
    };
    const out: OverflowBox[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      // A box that scrolls or clips is entitled to hold more than it shows; only `visible` means the
      // content has nowhere to go and is painted outside the parent.
      if (getComputedStyle(el).overflowX !== "visible") continue;
      const over = Math.round(el.scrollWidth - el.clientWidth);
      if (over <= 0) continue;
      out.push({
        el: describe(el), over, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        text: (el.textContent ?? "").trim().slice(0, 60),
      });
    }
    return out;
  });
}

/** A control's rect measured against the composer row's, so "visible" means literally inside the box. */
async function containment(page: Page, control: Locator) {
  return control.evaluate((el) => {
    const row = el.closest("[data-testid='composer-row']") ?? el.ownerDocument.body;
    const c = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return { width: Math.round(c.width), pastLeft: Math.round(r.left - c.left), pastRight: Math.round(c.right - r.right) };
  });
}

/** Vertical position of a box's top edge — the SHAPE reading that tells wrapped from unwrapped. */
const topOf = (l: Locator) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top));

/** A seeded live DB row — never startSession, which would spawn a real claude and trip the no-spawn guard. */
const SEED = {
  role: "plain" as const, agentName: "NarrowComposerAgent",
  ptyGeometry: { cols: 120, rows: 40 }, ptyBytes: "LOOM-NARROW-COMPOSER\r\n",
};

for (const atlas of [false, true]) {
  const shell = atlas ? "Atlas" : "classic";

  test.describe(`composer at narrow widths — ${shell} shell`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((arg: { key: string; on: boolean }) => {
        try {
          if (arg.on) localStorage.setItem(arg.key, "1");
          else localStorage.removeItem(arg.key);
        } catch { /* storage unavailable — the assertions below will say so */ }
      }, { key: ATLAS_KEY, on: atlas });
    });

    test(`every control stays inside the composer's own box at 420px (${shell})`, async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const s = await loomDaemon.seedLiveSession({ ...SEED, id: `e2ecnw${atlas ? "a" : "c"}-${Date.now()}` });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${loomDaemon.baseURL}/session/${s.sessionId}`);
      await expect(composerBox(page)).toBeVisible();

      const row = composer(page).getByTestId("composer-row");
      const controls = composer(page).getByTestId("composer-controls");
      const voiceRow = composer(page).getByTestId("composer-voice-row");

      // ── POPULATION. Every later claim is about these three boxes; if the voice cluster never
      // rendered (an unsupported recognizer backend drops it entirely) the census would be measuring a
      // composer that never carried the controls this card is about, and read green for free.
      await expect(row, `${shell}: the composer row did not render`).toBeVisible();
      await expect(controls, `${shell}: the control column did not render`).toBeVisible();
      await expect(voiceRow, `${shell}: the Voice + language row did not render — the recognizer ` +
        `backend reported unsupported, so this spec is not measuring the row the card is about`).toBeVisible();
      await expect(voiceButton(page)).toBeVisible();
      await expect(langSelect(page)).toBeVisible();

      // ── SHAPE at 1440: unwrapped, controls beside the box. This is the half that keeps the fix from
      // being "stack the controls permanently" — the wide layout is unchanged by this card.
      expect(await topOf(controls), `${shell}: at 1440 the controls must sit on the SAME line as the box`)
        .toBe(await topOf(composerBox(page)));
      const wide = await overflowingBoxes(page);
      expect(wide, `${shell} @1440: ${JSON.stringify(wide)}`).toHaveLength(0);

      // ── 420px: the width the card measured. ──────────────────────────────────────────────────────
      await page.setViewportSize({ width: 420, height: 900 });
      await expect(composerBox(page)).toBeVisible();

      // THE FIX. Pre-fix this returned the composer root and `composer-row`, both 414 wide against a
      // 306px (classic) / 380px (Atlas) box.
      const narrow = await overflowingBoxes(page);
      expect(narrow, `${shell} @420: ${narrow.length} composer box(es) draw outside their own edge with ` +
        `overflow-x:visible — worst ${Math.max(0, ...narrow.map((b) => b.over))}px. ${JSON.stringify(narrow)}`)
        .toHaveLength(0);

      // ── SHAPE at 420: the controls dropped to their own line rather than being crushed beside the
      // box. `minWidth: 0` alone would have squeezed the textarea to ~124px and read green above.
      expect(await topOf(controls), `${shell} @420: the controls must WRAP below the box, not share its line`)
        .toBeGreaterThan(await topOf(composerBox(page)));

      // ── CONTAINMENT. "Nothing overflows" is also true of a control that collapsed to nothing, so
      // read each one's own rect: real width, and both edges inside the row.
      for (const [name, control] of [
        ["the text box", composerBox(page)],
        ["the Voice button", voiceButton(page)],
        ["the language picker", langSelect(page)],
        ["the Send turn button", sendButton(page)],
      ] as const) {
        const c = await containment(page, control);
        expect(c.width, `${shell} @420: ${name} rendered ${c.width}px wide — it fits only because it ` +
          `collapsed, which is not "visible and reachable"`).toBeGreaterThan(24);
        expect(c.pastLeft, `${shell} @420: ${name} sits ${c.pastLeft}px past the row's left edge`).toBeLessThanOrEqual(0);
        expect(c.pastRight, `${shell} @420: ${name} sits ${c.pastRight}px past the row's right edge`).toBeLessThanOrEqual(0);
      }

      // The SAME voice cluster is rendered a second time by the large editor, which is a child of the
      // composer root (a fixed overlay, but in this subtree) and therefore already inside the census
      // above. Open it and re-read, so the shared primitive is held to this guarantee in both of its
      // mounts rather than only the inline one.
      await composer(page).getByRole("button", { name: "Expand to a larger editor" }).click();
      await expect(composer(page).getByPlaceholder("Compose a longer message", { exact: false })).toBeVisible();
      const expanded = await overflowingBoxes(page);
      expect(expanded, `${shell} @420 with the large editor open: ${JSON.stringify(expanded)}`).toHaveLength(0);
      await composer(page).getByRole("button", { name: "Collapse", exact: true }).click();
      await expect(composer(page).getByPlaceholder("Compose a longer message", { exact: false })).toHaveCount(0);

      // 320px is the narrowest viewport worth supporting, and the one the fluid `minWidth: 0` columns
      // exist for — the wrap alone does not save a row whose columns still refuse to shrink.
      await page.setViewportSize({ width: 320, height: 900 });
      await expect(composerBox(page)).toBeVisible();
      const tiny = await overflowingBoxes(page);
      expect(tiny, `${shell} @320: ${JSON.stringify(tiny)}`).toHaveLength(0);
    });

    test(`the wrapped controls still work, and a typed draft survives the resize (${shell})`, async ({ page, loomDaemon }) => {
      test.setTimeout(120_000);
      const s = await loomDaemon.seedLiveSession({ ...SEED, id: `e2ecnw${atlas ? "b" : "d"}-${Date.now()}` });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${loomDaemon.baseURL}/session/${s.sessionId}`);
      await expect(composerBox(page)).toBeVisible();

      // Type the draft BEFORE the resize, through the real per-keystroke onChange path, and plant a
      // sentinel on the textarea node itself. The draft surviving is one claim; the box never having
      // been remounted (which would have restored the draft from the store and hidden a real loss) is
      // a stronger, separable one.
      await composerBox(page).pressSequentially(DRAFT);
      await expect(composerBox(page)).toHaveValue(DRAFT);
      await composerBox(page).evaluate((el) => { (el as HTMLTextAreaElement & { __loomNarrow?: string }).__loomNarrow = "same-node"; });

      await page.setViewportSize({ width: 420, height: 900 });
      await expect(composer(page).getByTestId("composer-controls")).toBeVisible();
      // The controls really did wrap — otherwise the rest of this test is about the unwrapped layout.
      expect(await topOf(composer(page).getByTestId("composer-controls")),
        `${shell}: the controls did not wrap at 420, so nothing below is about the wrapped composer`)
        .toBeGreaterThan(await topOf(composerBox(page)));

      await expect(composerBox(page), `${shell}: the draft did not survive the resize into the wrap`)
        .toHaveValue(DRAFT);
      expect(await composerBox(page).evaluate((el) => (el as HTMLTextAreaElement & { __loomNarrow?: string }).__loomNarrow),
        `${shell}: the textarea was REMOUNTED across the resize — the draft above survived only because ` +
        `the per-session store restored it, which is not the same guarantee`).toBe("same-node");

      // ── EXERCISE 1: the language picker. Observable before/after on two independent surfaces — the
      // control's own value and the persisted preference it writes.
      const before = await langSelect(page).inputValue();
      const target = before === "de-DE" ? "fr-FR" : "de-DE";
      await langSelect(page).selectOption(target);
      await expect(langSelect(page), `${shell}: the wrapped language picker did not take a selection`)
        .toHaveValue(target);
      expect(target).not.toBe(before);
      expect(await page.evaluate((k) => localStorage.getItem(k), VOICE_LANG_KEY),
        `${shell}: the picker changed on screen but wrote no preference, so it is not really wired`)
        .toBe(target);

      // ── EXERCISE 2: the Voice toggle. WHICH state the recognizer settles in is the host's business
      // and not assertable: a host with a microphone reaches `listening` (the button becomes "Stop",
      // the status line says so), one without it can stall in `requesting` ("starting…") or come back
      // denied/errored — and a CI runner and a developer's laptop legitimately disagree. What is the
      // same everywhere is that the composer LEAVES its resting state, so that is what this records:
      // a mutation log of the composer subtree, armed before the click, read after. A durable-state
      // assertion would have pinned one host's behaviour and gone red on the next.
      const transitions = await composer(page).evaluate((root) => {
        const w = window as unknown as { __loomVoiceStates?: string[] };
        const snapshot = () => {
          const status = root.querySelector("[data-testid='composer-status']");
          const mic = Array.from(root.querySelectorAll("button"))
            .find((b) => /^(Voice|Stop|starting…)$/.test((b.textContent ?? "").trim()));
          return `${(mic?.textContent ?? "").trim()}|${(status?.textContent ?? "").trim()}`;
        };
        w.__loomVoiceStates = [snapshot()];
        new MutationObserver(() => w.__loomVoiceStates!.push(snapshot()))
          .observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        return w.__loomVoiceStates[0];
      });
      // The resting state this spec measures FROM: idle mic, and a status line that renders nothing at
      // all (it collapses so the composer hugs the card's bottom edge).
      expect(transitions, `${shell}: the composer was not at rest before the Voice button was pressed`).toBe("Voice|");

      await voiceButton(page).click();
      await page.waitForFunction(
        () => ((window as unknown as { __loomVoiceStates?: string[] }).__loomVoiceStates ?? []).length > 1,
        undefined, { timeout: 10_000 },
      );
      const states = await page.evaluate(() => (window as unknown as { __loomVoiceStates?: string[] }).__loomVoiceStates ?? []);
      const changed = states.filter((s) => s !== "Voice|");
      expect(changed, `${shell}: clicking the wrapped Voice button left the composer in its resting ` +
        `state — the control is on screen but not reachable. States seen: ${JSON.stringify(states)}`)
        .not.toHaveLength(0);

      // ── The draft is untouched by either control, and survives the resize back out of the wrap.
      await expect(composerBox(page), `${shell}: operating the controls disturbed the draft`).toHaveValue(DRAFT);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(composerBox(page), `${shell}: the draft did not survive the resize back out of the wrap`)
        .toHaveValue(DRAFT);
      expect(await topOf(composer(page).getByTestId("composer-controls")),
        `${shell}: the controls did not un-wrap at 1440`).toBe(await topOf(composerBox(page)));
      await expect(sendButton(page), `${shell}: Send stayed disabled over a non-empty draft`).toBeEnabled();
    });
  });
}
