# `web-design` skill — source extraction report (step 1/2)

**Status:** Analysis complete — **awaiting human sign-off** before the authoring ticket (step 2/2) starts.
**Author:** worker session, branch `loom/0006d99170b3`, 2026-06-07.
**Scope:** Deep-read of the *real* source material of three public design skills and a decision-ready plan for what to carry into Loom's distilled `web-design` skill. **This document writes no skill.** It decides what the skill should contain.

Sources were cloned and read at the content level (not READMEs/landing pages):

| Source | What was read | Commit basis |
|---|---|---|
| **Impeccable** (`pbakaus/impeccable`) | `DESIGN.md`, `STYLE.md`, all `skill/reference/*.md` (typeset, colorize, layout, interaction-design, animate, critique, craft, polish, shape, clarify, +25 command files), canonical `SKILL.md`, the deterministic rule registry `cli/engine/registry/antipatterns.mjs`, `LICENSE`, `NOTICE.md` | shallow clone, v3.5.0 |
| **Emil Kowalski** (`emilkowalski/skill`) | `skills/emil-design-eng/SKILL.md` in full (680 lines), repo file tree, `README.md`, `.gitignore` | shallow clone |
| **taste-skill** (`Leonxlnx/taste-skill`) | flagship `skills/taste-skill/SKILL.md` (1207 lines), `taste-skill-v1`, the aesthetic variants (minimalist/brutalist/soft), `research/laziness/**`, `README.md`, `CHANGELOG.md`, `LICENSE` | shallow clone, v2 |

> **One-line verdict:** Three sources, three altitudes. **Impeccable** is the rigorous, license-clean *domain reference + deterministic linter* (the backbone). **Emil** is the deep, opinionated *motion/interaction craft layer* (the best animation guidance, but unlicensed → reword). **taste-skill** is the *anti-default / aesthetic-variance framework* (the "don't ship the AI default" instinct + the dials idea, MIT-clean but bloated and stack-prescriptive). Loom's skill should be **Impeccable's rigor + Emil's motion depth (reworded) + taste-skill's anti-default discipline and a *light* dials concept**, stack-agnostic, single SKILL.md + a small `references/` subdir.

---

## 1. Per-source inventory (what each ACTUALLY contains)

### 1.1 Impeccable — domain reference + deterministic detector

Two layers live in the repo and must not be conflated:
- a **brand design system** ("Neo Kinpaku") in `DESIGN.md`/`STYLE.md` used to build impeccable.design itself (concrete OKLCH tokens, project-specific — *not* portable doctrine);
- a **portable design doctrine** in `skill/reference/*.md` + `SKILL.md` (the generic, reusable rules — this is what matters for Loom).

**Concrete portable rules (cited specifics):**

- **Typography** (`typeset.md`): modular scale, pick one ratio (1.25 / 1.333 / 1.5), **≥1.25 ratio between steps**, "5 sizes cover most needs"; body **≥16px/1rem**; **measure 45–75ch, cap 65–75ch**; line-height headings **1.1–1.2**, body **1.5–1.7**; **≤3 font families**, ≤3–4 weights; ALL-CAPS labels **+0.05–0.12em** tracking; display tracking floor **≥ −0.04em**; hero clamp max **≤6rem (~96px)** and `max ≤ ~2.5× min`; pair fonts on a contrast axis (serif+sans, geometric+humanist); dark-mode body weight reduction (e.g. 350 not 400) +0.01–0.02em tracking; `text-wrap: balance` on h1–h3, `pretty` on prose; semantic tokens (`--text-body`), never value names. (Typography additions credited to ehmo's `typecraft-guide-skill`.)
- **Color & contrast** (`colorize.md`): WCAG **AA 4.5:1 body / 3:1 large+UI**, AAA 7:1/4.5:1; placeholder text also needs 4.5:1; **60-30-10** weight rule; 4-step commitment axis (Restrained accent ≤10% → Committed 30–60% → Full palette 3–4 roles → Drenched); **use OKLCH, "stop using HSL"**; tinted neutrals (+0.005–0.015 chroma, pure gray is "dead"); dark mode = surface-lightness depth (3-step scale 15/20/25%), not inverted light mode; named dangerous combos (light-gray-on-white = "#1 a11y fail", red/green, blue-on-red, yellow-on-white); **"alpha is a design smell"**; the **cream/beige warm-neutral band (OKLCH L 0.84–0.97, C<0.06, hue 40–100)** flagged as "the saturated AI default of 2026."
- **Spatial/layout** (`layout.md`): **prefer 4pt base** (4/8/12/16/24/32/48/64/96); tight grouping 8–12px, section separation 48–96px; hierarchy table (size ≥3:1 strong / <2:1 weak; combine 2–3 dimensions); flexbox 1D / grid 2D; `repeat(auto-fit, minmax(280px,1fr))`; container queries for components; **semantic z-index scale** (no `9999`); **44×44px touch targets**; the "squint test" (most important element obvious within 2s); **never nest cards in cards**, "cards are the lazy answer."
- **Motion** (`animate.md`): the **100/300/500 duration ladder** (100–150 instant feedback / 200–300 state / 300–500 layout / 500–800 entrance), product default 150–250ms, **exit ≈ 75% of enter**, **80ms = perceived-instant threshold**, >500ms feedback "feels laggy"; named easings `--ease-out-quart/quint/expo` (cubic-beziers given), **avoid bounce/elastic**; stagger cap (10×50ms = 500ms); animate only transform/opacity; respect `prefers-reduced-motion`.
- **Interaction** (`interaction-design.md`): the **eight interactive states** (default/hover/focus/active/disabled/loading/error/success); never `outline:none` without a `:focus-visible` ring (3:1, 2–3px, offset); placeholders aren't labels, validate on blur; skeletons > spinners; optimistic updates for low-stakes only; `inert`/`<dialog>`/Popover API; **undo > confirm**; roving tabindex + skip links; the "dropdown clipped by `overflow:hidden`" bug + fixes.
- **UX writing** (`clarify.md`): six clarity rules; **button = verb+object** (never OK/Submit/Yes); error formula (what happened / why / how to fix), never humor for errors; empty-state formula; voice constant / tone adapts; terminology glossary; i18n expansion budgets; accessible copy (standalone link text, informative alt).
- **The critique rubric** (`critique.md`, 39KB): two *isolated* assessments (LLM design review + deterministic detector) → **Nielsen's 10 heuristics scored 0–4 = /40** (with a 5-band rating table), an 8-item **cognitive-load** checklist (4+ failures = critical; Miller/Cowan ≤4 working-memory rule → ≤5 nav, ≤3 pricing tiers), **P0–P3** severity, **5 persona archetypes** (Alex/Jordan/Sam/Riley/Casey) selected by interface type, and a fixed report structure.
- **25 commands** (`skill/reference/*.md`): Build (`craft`, `shape`, `init`, `document`, `extract`), Evaluate (`critique`, `audit`), Refine (`polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`), Enhance (`animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`), Fix (`clarify`, `adapt`, `optimize`), Iterate (`live`), plus register/internal refs (`brand`, `product`, `codex`).
- **The deterministic detector** (`antipatterns.mjs`): a registry of **~30 machine-checkable anti-patterns** across regex / static-HTML / browser / visual engines (full list in §4). This is the load-bearing, reproducible piece — design lint that returns exit 2 on findings.
- **`STYLE.md`**: an editorial/prose anti-AI-tell guide with a build-enforced **denylist** (`delve`, `seamless`, `robust`, `elevate`, `tapestry`, em-dash `—`/`--`, "in today's…", "let's dive in", etc.) + uncatchable patterns (negation pivot "not just X, it's Y", triadic everything, uniform rhythm).

### 1.2 Emil Kowalski — design-engineering / motion craft (single SKILL.md)

A single 680-line `emil-design-eng/SKILL.md` — the most *opinionated and deep* motion/interaction content of the three. Contents:

- **Philosophy:** taste is trained not innate; unseen details compound; beauty is leverage.
- **Required review format:** a `| Before | After | Why |` markdown table (explicitly mandated).
- **Animation Decision Framework (4 ordered questions):** (1) *Should this animate at all?* — frequency table: **100+/day → never animate** (Raycast command palette), tens/day → reduce, occasional (modals/toasts) → standard, rare/first-time → can delight; **never animate keyboard-initiated actions**. (2) *What's the purpose?* (spatial consistency / state / explanation / feedback / preventing jarring change). (3) *Easing* — decision tree: enter/exit → ease-out, on-screen move → ease-in-out, hover/color → ease, constant → linear; **never ease-in for UI**; **use custom curves, built-ins are too weak** (`--ease-out: cubic-bezier(0.23,1,0.32,1)`, `--ease-in-out: cubic-bezier(0.77,0,0.175,1)`, `--ease-drawer: cubic-bezier(0.32,0.72,0,1)`). (4) *Duration* — per-element table (button 100–160 / tooltip 125–200 / dropdown 150–250 / modal 200–500), **UI animations < 300ms**.
- **Perceived performance:** fast spinner *feels* faster; 180ms select beats 400ms; instant subsequent tooltips.
- **Springs:** when to use (drag/momentum/interruptible/decorative); Apple form `{type:"spring",duration:0.5,bounce:0.2}`; keep bounce 0.1–0.3; springs maintain velocity when interrupted.
- **Component principles:** buttons `scale(0.97)` on `:active`; **never animate from `scale(0)`** (start 0.95 + opacity); **origin-aware popovers** (`transform-origin: var(--radix-popover-content-transform-origin)`; modals stay centered); tooltips skip delay on subsequent hovers; **transitions over keyframes for interruptible UI**; **blur to mask imperfect crossfades** (`filter: blur(2px)`, keep <20px, costly in Safari); `@starting-style` for enter.
- **CSS transform mastery:** `translateY(100%)` is element-relative (Sonner/Vaul); `scale()` scales children; 3D transforms; transform-origin.
- **`clip-path` as an animation tool:** inset reveals, tab color transitions, hold-to-delete, scroll reveals, comparison sliders.
- **Gesture/drag:** momentum dismissal (velocity > 0.11), boundary damping, pointer capture, multi-touch protection, friction not hard stops.
- **Performance rules:** only transform/opacity; CSS vars are inheritable (don't thrash children); Framer Motion `x`/`y` shorthand is NOT hardware-accelerated (use full `transform` string); CSS animations beat JS under load; WAAPI for programmatic.
- **Accessibility:** reduced-motion = fewer/gentler, not zero; gate hover behind `@media (hover:hover) and (pointer:fine)`.
- **Sonner principles** (building loved components): DX-first, good defaults > options, naming creates identity, handle edge cases invisibly, cohesion.
- **Process:** review the next day; slow-motion/frame-by-frame debugging; test on real devices; asymmetric enter/exit; a final review checklist table.

### 1.3 taste-skill — anti-default aesthetic-variance framework (1207-line SKILL.md)

The flagship `design-taste-frontend` is a single very long SKILL.md (14 numbered sections) + aesthetic-variant sibling skills + an anti-laziness research tree. Contents:

- **The three dials** (its signature idea): `DESIGN_VARIANCE` (1 symmetry → 10 chaos), `MOTION_INTENSITY` (1 static → 10 cinematic), `VISUAL_DENSITY` (1 art-gallery → 10 cockpit). Baseline **8/6/4**. Each dial has technical level bands (e.g. VARIANCE 8–10 = masonry/fractional-grid/massive empty zones; with a **mobile override** forcing single-column < 768px). Set via a **dial-inference table** (signal → values) and **use-case presets**; "overrides happen conversationally, don't edit the file."
- **Brief inference (§0 "Read the room"):** infer page kind / vibe words / reference signals / audience / brand assets / quiet constraints (a11y, public-sector → these *override* aesthetic preference); produce a one-line "Design Read"; **ask exactly one clarifying question, only when genuinely ambiguous**; **Anti-Default Discipline** (no AI-purple gradients / centered hero over dark mesh / three equal cards / glassmorphism-on-everything / Inter+slate-900).
- **Design-system mapping (§2):** if the brief reads as a *real* system, **install the official package** (Fluent / Material 3 / Carbon / Polaris / Atlaskit / Primer / GOV.UK / USWDS / Radix Themes / shadcn / Tailwind v4) and *don't* hand-recreate its CSS; if it's an *aesthetic* (glassmorphism / bento / brutalism / editorial / aurora), native CSS + label honestly ("there is no official liquid-glass.css"). **One system per project.**
- **Default architecture (§3):** React/Next + Tailwind v4 + Motion + `next/font`; **icon family priority order** (Phosphor → Hugeicons → Radix → Tabler; lucide discouraged); standard breakpoints; `max-w-7xl`.
- **Concrete rules (§4):** hero hard limits (subtext ≤20 words, ≤4 text elements, `pt-24` cap, headline ≤2 lines); **EYEBROW RESTRAINT** (≤ ceil(sections/3), "the #1 violated rule"); zigzag cap (≤2 consecutive splits); section-layout-repetition ban; bento cell-count rule; **THE LILA RULE** (no AI purple/blue glow, one accent, saturation <80%); **PREMIUM-CONSUMER PALETTE BAN** (explicit beige/cream/brass/espresso hex denylist, "second-most-recurring AI tell"); serif "VERY DISCOURAGED AS DEFAULT" (Fraunces/Instrument Serif banned as defaults); CWV targets (LCP<2.5s, INP<200ms, CLS<0.1); **9.G EM-DASH BAN** ("binary, zero em-dashes"); "Jane Doe effect" (no fake-perfect numbers/generic names); a ~60-item **Pre-Flight checklist**.
- **Aesthetic variants** (separate skills): minimalist (Notion/Linear warm-monochrome+pastels, exact hex), brutalist (Swiss-print vs tactical-CRT archetypes, reject `border-radius`), soft/high-end (Awwwards-tier, "double-bezel" nested enclosures, magnetic hover). Each is a persona-flavored mini design system with concrete hex/font lists.
- **Anti-laziness research** (`research/laziness/`): a genuinely interesting empirical study — LLM "laziness"/truncation is "a deliberate behavioral choice, not a decoding failure"; remediation = prompt psychology (tip/deep-breath/career-stakes), low temp for code, lazy-loaded skills (~35% context reduction), explicit no-placeholder continuation protocols. Underpins the skill's exhaustive enforcement style.

---

## 2. Overlap & conflict map

### 2.1 Consensus core (where ≥2 sources independently agree → highest confidence to keep)

| Topic | Agreement | Sources |
|---|---|---|
| **Animate only `transform`/`opacity`** | unanimous | Impeccable, Emil, taste |
| **Respect `prefers-reduced-motion`** | unanimous | Impeccable, Emil, taste |
| **No bounce/elastic / no `ease-in` / use custom decelerating curves** | strong | Impeccable (avoid bounce/elastic), Emil (custom curves, never ease-in) |
| **Short UI durations (~<300ms, exits faster)** | strong | Impeccable (100/300/500, exit 75%), Emil (<300ms, asymmetric enter/exit) |
| **Motion must have a purpose; don't animate everything** | unanimous | all three ("motion must be motivated") |
| **No AI-purple/blue gradient palette** | unanimous | Impeccable (`ai-color-palette`), taste (LILA rule), Emil (implicitly via taste) |
| **Cream/beige is the AI default — avoid by reflex** | strong | Impeccable (`cream-palette`, named OKLCH band), taste (premium-consumer hex denylist) |
| **No em-dashes / no marketing buzzwords in copy** | strong | Impeccable (`em-dash-overuse`, `marketing-buzzword`, STYLE.md denylist), taste (9.G em-dash ban, filler-verb ban) |
| **Eyebrow/kicker chips & numbered section markers are tells** | strong | Impeccable (`hero-eyebrow-chip`, `repeated-section-kickers`, `numbered-section-markers`), taste (eyebrow restraint) |
| **No gradient text on headings** | strong | Impeccable (`gradient-text`), taste (§9) |
| **Don't default to overused fonts (Inter/Roboto/etc.)** | strong | Impeccable (`overused-font`), taste (Inter discouraged), minimalist/soft variants (banned) |
| **WCAG AA 4.5:1 body / 3:1 large** | strong | Impeccable (everywhere), taste (Button/Form Contrast Check) |
| **Real interactive states (focus visible, loading, empty, error)** | strong | Impeccable (8 states), taste (mandatory states), Emil (`:active` feedback) |
| **Good defaults > options; details compound** | shared philosophy | Emil (Sonner), taste (anti-default), Impeccable (polish/distill) |
| **Single-axis discipline (one accent, one type scale, one corner-radius scale)** | strong | Impeccable (commitment axis, one ratio), taste (Color/Shape Consistency Lock) |

This consensus core is the **spine** of Loom's skill — it is exactly the content that is both high-value and corroborated.

### 2.2 Divergences & conflicts (pick a winner per conflict)

| # | Conflict | Positions | **Winner + rationale** |
|---|---|---|---|
| C1 | **Easing curve values** | Impeccable: `ease-out-quart (0.25,1,0.5,1)` / `quint (0.22,1,0.36,1)` / `expo (0.16,1,0.3,1)`. Emil: `(0.23,1,0.32,1)`, `(0.77,0,0.175,1)`, drawer `(0.32,0.72,0,1)`. | **Keep both as a named palette, reworded.** They don't contradict — both reject CSS defaults and bounce. Loom should ship a small named-curve set (decelerate / smooth / drawer) citing the *idea* (custom decelerating curves), with values reworded to avoid copying Emil verbatim (license). |
| C2 | **Spring vs duration animation** | Emil: springs are first-class (interruptible, natural). Impeccable: duration-ladder centric, springs barely mentioned. taste: `type:"spring", stiffness:100, damping:20`. | **Emil wins** for the *interruptibility* argument (springs keep velocity; CSS transitions retarget; keyframes restart) — it's the deepest, most correct treatment. Carry the principle, framework-agnostic. |
| C3 | **Stagger delay** | Impeccable: 50ms/item, cap 500ms. Emil: 30–80ms/item. | **Merge:** "30–80ms per item, cap total ~500ms." Same idea, take the union. |
| C4 | **`DESIGN_VARIANCE` baseline 8 (high asymmetry by default)** | taste: default 8/6/4 → aggressively asymmetric. Impeccable/Emil: restraint, hierarchy, "distill," "quieter." | **Impeccable/Emil restraint wins as the *default*.** taste's high-variance default optimizes for Awwwards landing pages and will actively harm product UI/dashboards (Loom's own use case). Adopt the *dials concept* but with a **restraint-biased default**, not 8. |
| C5 | **Stack prescriptiveness** | taste: hard-codes React/Next/Tailwind/Motion/Phosphor, official-package install commands. Impeccable: largely stack-agnostic CSS/OKLCH/container-queries. Emil: framework-agnostic CSS + notes on Framer/Motion. | **Impeccable/Emil agnosticism wins.** Loom serves arbitrary projects; baking in Tailwind/Next is wrong. Keep taste's *"use the official design system if one fits, don't hand-recreate it"* principle but drop the specific package list (or demote to an optional appendix). |
| C6 | **Serif display headline** | taste: serif "VERY DISCOURAGED as default," Fraunces/Instrument Serif banned. Impeccable: `italic-serif-display` is an *advisory* tell but "editorial/magazine register may legitimately want this — judge by context." | **Impeccable's context-sensitive call wins.** A hard ban is too blunt; the right rule is "don't *reflexively* reach for the expressive serif; it's legitimate in editorial register." Carry as advisory + context note. |
| C7 | **Exhaustiveness vs brevity** | taste: 1207 lines, ~60-item pre-flight, maximalist enforcement (driven by its anti-laziness research). Emil: 680 focused lines. Impeccable: modular many-small-files. | **Hybrid:** Loom wants Impeccable's *modularity* (a lean SKILL.md + `references/`) with taste's *anti-default checklist instinct* distilled to a short pre-ship checklist — not 60 items. Brevity wins for the entrypoint; depth lives in references. |
| C8 | **Review/output format** | Emil mandates a `Before/After/Why` table; Impeccable mandates the critique report structure (health score, P0–P3, personas). | **Both, by mode.** Emil's table is the right format for a *focused fix/review pass*; Impeccable's structure for a *full critique*. Loom can offer both as output templates. |
| C9 | **Hex-coded palettes** | taste ships exact hex per aesthetic; Impeccable ships OKLCH and *argues against* fixed value-named tokens. | **Impeccable's OKLCH + semantic-token approach wins** as the teaching model (perceptual uniformity, dark-mode story). taste's hex lists are useful as *examples of what to avoid* (the denylists), not as prescriptions. |

---

## 3. KEEP / ADAPT / DROP table

Rated across four lenses — **Value** (how much it improves output), **Redundancy** (is it already covered elsewhere), **License** (can we reuse), **Fit-for-Loom** (stack-agnostic, product-UI-relevant). Verdict column is the authoring instruction.

> License shorthand: **Imp** = Apache-2.0 (reusable w/ attribution) · **taste** = MIT (reusable w/ attribution) · **Emil** = *no license → reword, never copy verbatim.*

| Element | Source | Value | Redundancy | License | Fit | **Verdict** |
|---|---|---|---|---|---|---|
| WCAG AA contrast (4.5/3) + named dangerous combos | Imp | High | core | reuse | High | **KEEP** verbatim-OK (attribute) |
| 60-30-10 + 4-step color-commitment axis | Imp | High | unique | reuse | High | **KEEP** |
| OKLCH over HSL; tinted neutrals; chroma-near-white rule | Imp | High | unique | reuse | High | **KEEP** |
| Dark mode = surface-lightness scale, not inversion | Imp | High | unique | reuse | High | **KEEP** |
| Type scale (one ratio ≥1.25, 5 sizes, 16px floor, 45–75ch, LH bands, ≤3 families) | Imp (+ehmo) | High | core | reuse | High | **KEEP** |
| ALL-CAPS tracking quantum, clamp ratio bound, dark-mode type compensation | Imp/ehmo | Med | unique | reuse (note ehmo provenance) | High | **KEEP** |
| 4pt spacing scale; tight 8–12 / separation 48–96; hierarchy table | Imp | High | core | reuse | High | **KEEP** |
| 44×44px touch targets; semantic z-index; squint test; flex-1D/grid-2D | Imp | High | core | reuse | High | **KEEP** |
| 8 interactive states; `:focus-visible` ring rules; placeholders≠labels; validate-on-blur | Imp | High | core | reuse | High | **KEEP** |
| Undo > confirm; skeleton > spinner; optimistic-low-stakes; dropdown-clip bug | Imp | High | unique | reuse | High | **KEEP** |
| UX writing: verb+object buttons, error formula, empty states, tone-adapts | Imp | High | unique | reuse | High | **KEEP** |
| Deterministic anti-pattern registry (~30 rules) | Imp | **Very High** | unique | reuse | High | **KEEP** as the consensus don'ts list (§4); *port as a real lint gate is a separate backlog ticket f17791b0* |
| STYLE.md anti-AI-tell prose denylist + uncatchable patterns | Imp | High | overlaps taste copy rules | reuse | High | **KEEP** (merge with taste copy bans) |
| Motion duration ladder (100/300/500, exit 75%, 80ms threshold) | Imp | High | overlaps Emil | reuse | High | **KEEP** (Imp is license-clean; reconcile with Emil's per-element table) |
| Named easing palette (decelerate/smooth/drawer) | Imp + Emil | High | both | Imp reuse / Emil reword | High | **KEEP** (Imp values reusable; present Emil's as reworded guidance) |
| **Animation Decision Framework** (animate-at-all? frequency table; never animate keyboard actions) | Emil | **Very High** | unique | **reword** | High | **ADAPT** — best single idea Emil has; re-express in Loom's words |
| Springs + interruptibility (velocity retained; transitions>keyframes) | Emil | High | unique | **reword** | High | **ADAPT** |
| `scale(0)`→`scale(0.95)+opacity`; origin-aware popovers; blur-mask crossfade; `@starting-style` | Emil | High | unique | **reword** | High | **ADAPT** (techniques are facts; rewrite the prose/code) |
| Perceived-performance (fast spinner, instant subsequent tooltips, asymmetric timing) | Emil | High | partial w/ Imp | **reword** | High | **ADAPT** |
| Performance gotchas (Framer `x/y` not HW-accel; CSS-vars thrash children; CSS>JS under load; WAAPI) | Emil | Med-High | unique | **reword** | Med (framework-specific) | **ADAPT** — keep the principle, generalize the framework refs |
| Gesture/drag mechanics (velocity 0.11, damping, pointer capture, multitouch) | Emil | Med | unique | **reword** | Med (app-specific) | **ADAPT** → move to a `references/motion.md` (not core) |
| Sonner "loved components" principles (DX-first, defaults>options, cohesion) | Emil | Med | overlaps philosophy | **reword** | Med | **ADAPT** (compress to 2–3 lines of philosophy) |
| `Before/After/Why` review table format | Emil | Med | unique | **reword** (format is not protectable; rephrase prose) | High | **ADAPT** as the "fix/review" output mode |
| **The three dials concept** (variance/motion/density) | taste | High | unique | reuse (MIT) | Med | **ADAPT** — adopt the *idea* with restraint-biased defaults + a simpler 3-level (low/med/high) scale; drop the 1–10 numerology |
| Brief inference ("read the room", one-line Design Read, one clarifying question) | taste | High | unique | reuse | High | **ADAPT** — excellent; keep, trimmed |
| Anti-Default Discipline list | taste | High | overlaps Imp slop rules | reuse | High | **KEEP/merge** into §4 |
| "Use the official design system if one fits; don't hand-recreate it; one system per project" | taste | High | unique | reuse | High | **KEEP** (principle only) |
| Eyebrow restraint / zigzag cap / section-repetition ban / bento cell-count | taste | Med-High | partial w/ Imp | reuse | Med-High | **ADAPT** — fold the strongest (eyebrow restraint) into don'ts; the layout-counting rules are landing-page-specific → references |
| Hero hard limits (≤20-word subtext, ≤4 elements, pt-24) | taste | Med | unique | reuse | Med (landing-page) | **ADAPT** → `references/` (landing pages), not core product UI |
| Premium-consumer/beige hex denylist + LILA rule | taste | High | overlaps Imp cream rule | reuse | High | **KEEP** as examples in the cream/AI-palette don't |
| Anti-laziness research findings | taste | Low (for a design skill) | n/a | reuse | Low | **DROP from the skill** — interesting but it's about LLM output discipline, not web design; note as a reference link only |
| Aesthetic variant skills (minimalist/brutalist/soft) | taste | Med | unique | reuse | Low-Med | **DROP as bundled variants** — too many, persona-flavored, hex-locked; optionally distill *one* "aesthetic families" reference page describing the axes (minimal/brutalist/editorial/glass) without the persona cosplay |
| Stack prescriptions (React/Next/Tailwind/Motion/Phosphor, install commands) | taste | Low (for agnostic skill) | n/a | reuse | Low | **DROP** from core; optional appendix "if the project already uses X" |
| 1–10 dial numerology + 60-item pre-flight | taste | Low | n/a | reuse | Low | **DROP** the heavy machinery; keep a short pre-ship checklist |
| **Neo Kinpaku brand tokens** (DESIGN.md/STYLE.md exact OKLCH) | Imp | Low | n/a | reuse | Low | **DROP** — project-specific to impeccable.design, not portable doctrine |
| Impeccable's 25 slash-commands + `live`/`overdrive`/`codex` harness | Imp | Low | n/a | reuse | Low | **DROP** — that's a whole product surface; Loom's skill is guidance, not a command suite |
| Nielsen-0–4 / cognitive-load / persona critique rubric | Imp | Med | unique | reuse | Med | **ADAPT (optional)** — powerful but heavy; carry a *compressed* critique checklist (heuristics + cognitive-load + the 5 personas as a "review lens"), not the full /40 scoring machinery, unless owner wants a dedicated `critique` mode |

---

## 4. Consensus anti-pattern "don'ts" (deterministic list to carry)

This is the cross-source-corroborated **don't** list, anchored on Impeccable's machine-checkable registry (the only one expressed as a real detector) and cross-checked against taste-skill's bans and Emil's review checklist. **★ = independently corroborated by ≥2 sources** (highest confidence). Grouped by domain; each is concrete enough to author (and later lint) directly.

**Color & contrast**
- ★ No AI palette: purple/violet gradients, cyan-on-dark glow. *(Imp `ai-color-palette`, `dark-glow`; taste LILA rule)*
- ★ No cream/beige-by-reflex surface (OKLCH L 0.84–0.97, C<0.06, hue 40–100; or the taste hex denylist `#f5f1ea`/`#f7f5f1`/…). *(Imp `cream-palette`; taste premium-consumer ban)*
- ★ No gradient text (esp. headings/metrics). *(Imp `gradient-text`; taste §9)*
- No gray text on colored backgrounds (use a darker shade of the bg hue). *(Imp `gray-on-color`)*
- Don't ship below WCAG AA (4.5:1 body, 3:1 large/UI); placeholder text counts. *(Imp `low-contrast`; taste contrast checks)*
- "Alpha is a design smell" — define explicit overlay colors, not reflexive transparency. *(Imp)*

**Typography**
- ★ No overused default face (Inter/Roboto/Fraunces/Geist/Plus Jakarta/Space Grotesk) when personality matters. *(Imp `overused-font`; taste; variants)*
- No single font for the whole page (pair display + body). *(Imp `single-font`)*
- No flat type hierarchy (use <1.25 ratio between steps is the failure; aim ≥1.25). *(Imp `flat-type-hierarchy`)*
- Don't reflexively use an oversized **italic serif** hero (Fraunces/Playfair/Recoleta) — advisory, legitimate in editorial register. *(Imp `italic-serif-display`; taste serif-as-default discouraged)*
- No body text < 16px (hard floor 14px); no `px` font sizes; no `user-scalable=no`. *(Imp `tiny-text`, typeset)*
- No crushed letter-spacing past legibility; no wide tracking (>0.05em) on body; no all-caps body passages. *(Imp `extreme-negative-tracking`, `wide-tracking`, `all-caps-body`)*
- No line length beyond ~80ch (cap 65–75ch); no tight leading (<1.3); no justified text without hyphenation. *(Imp `line-length`, `tight-leading`, `justified-text`)*

**Layout & space**
- ★ No nested cards (cards inside cards); "cards are the lazy answer." *(Imp `nested-cards`; taste materiality "cards only when elevation communicates")*
- No monotonous/uniform spacing — vary tight grouping vs section separation. *(Imp `monotonous-spacing`)*
- No content overflowing its container / body text flush to the viewport edge / cramped padding inside bordered containers. *(Imp `text-overflow`, `body-text-viewport-edge`, `cramped-padding`)*
- No positioned child clipped by an `overflow:hidden` ancestor (tooltips/menus). *(Imp `clipped-overflow-container`; Emil notes the same bug)*
- ★ Eyebrow restraint: no tiny uppercase tracked chip above the hero, and no repeating kicker labels as section scaffolding. *(Imp `hero-eyebrow-chip`, `repeated-section-kickers`; taste eyebrow-restraint = "#1 violated rule")*
- No numbered section markers (01/02/03) as default scaffolding. *(Imp `numbered-section-markers`)*
- No icon-tile-stacked-above-heading feature-card template. *(Imp `icon-tile-stack`; taste "three equal cards")*
- No oversized long-sentence hero headline that eats the fold. *(Imp `oversized-h1`; taste hero hard-limits)*

**Motion**
- ★ No bounce/elastic easing; no CSS-default easing; never `ease-in` for UI; use custom decelerating curves. *(Imp `bounce-easing`; Emil easing tree)*
- ★ Only animate `transform`/`opacity` — never width/height/margin/padding/top/left. *(Imp `layout-transition`; Emil performance; taste §6)*
- ★ Always respect `prefers-reduced-motion`. *(all three)*
- ★ Motion must be motivated — no decorative animation on high-frequency actions; **never animate keyboard-initiated actions**. *(Emil framework; taste "motion must be motivated"; Imp "animation without purpose")*
- No feedback animation > 500ms (UI animations < 300ms; exits ~75% of enter). *(Imp; Emil)*
- Never animate from `scale(0)` (start ≥0.95 + opacity). *(Emil)*
- No `window.addEventListener('scroll')` for scroll animation (use IntersectionObserver / scroll-driven timelines). *(taste hard ban; Imp "use Intersection Observer")*
- No image scale/rotate-on-hover as decoration (provider-gated advisory). *(Imp `image-hover-transform`)*

**Copy / UX writing**
- ★ No em-dashes (— or --) — strong AI cadence tell. *(Imp `em-dash-overuse` + STYLE.md; taste 9.G binary ban)*
- ★ No marketing buzzwords (streamline/empower/supercharge/seamless/world-class/next-generation/leverage…). *(Imp `marketing-buzzword` + STYLE.md denylist; taste filler-verb ban)*
- No aphoristic "Not X. Just Y." cadence repeated across sections. *(Imp `aphoristic-cadence`; STYLE.md negation-pivot)*
- No generic button labels (OK/Submit/Yes) — use verb+object; no vague error messages; never humor in errors; never blame the user. *(Imp `clarify`)*
- No "Jane Doe" / fake-perfect numbers (99.99%, 50%) / generic company names as placeholders. *(taste §9)*
- STYLE.md denylist words (delve/tapestry/robust/elevate/pivotal/"in today's…"/"let's dive in"/"in conclusion") + uniform-rhythm/triadic-everything patterns. *(Imp STYLE.md)*

**Quality / a11y**
- Never `outline:none` without a visible `:focus-visible` replacement. *(Imp)*
- No broken/placeholder `<img>` (empty/missing src). *(Imp `broken-image`)*
- No skipped heading levels (h1→h3). *(Imp `skipped-heading`)*
- No placeholder-as-label; no touch targets < 44×44px. *(Imp; taste)*

---

## 5. License findings per source (verbatim-vs-reword call)

| Source | License | Status | **Call for Loom** |
|---|---|---|---|
| **Impeccable** | **Apache License 2.0** (`LICENSE` is the full standard text). `NOTICE.md` declares it *builds on Anthropic's `frontend-design` skill* (Apache-2.0, © 2025 Anthropic PBC) and that `typography.md` incorporates additions from **ehmo's `typecraft-guide-skill`** ("merged in at the author's request"; NOTICE lists its license as "see upstream repo"). | **Verbatim-reusable** with attribution. | **REUSE OK.** Apache-2.0 permits use/modify/redistribute provided we (a) retain the license text, (b) preserve the `NOTICE` attributions (Anthropic + ehmo + Paul Bakaus), and (c) state changes. **Action:** add an attribution/provenance note to Loom's skill (or a `NOTICE`) crediting Impeccable (Apache-2.0), Anthropic's frontend-design skill, and ehmo's typecraft additions. Verify ehmo's upstream repo license before lifting the *specific* typography sentences verbatim; if unclear, reword those (the facts/values are not protectable). |
| **Emil Kowalski** | **NO LICENSE.** The cloned repo (`emilkowalski/skill`) contains only `.gitignore`, a 52-byte `README.md` (just a link to emilkowal.ski/skill), and `skills/emil-design-eng/SKILL.md`. No `LICENSE`/`COPYING` file anywhere. | **All-rights-reserved by default.** Distribution via `npx skills add` signals intent to *share*, but absence of a license grants **no reuse rights** legally. | **DO NOT COPY VERBATIM.** ⚠️ This is the one genuine license caution. **Action:** carry Emil's *ideas, techniques, and factual values* (which are not copyrightable — easing math, durations, the "never animate from scale(0)" technique, the decision framework) but **re-express all prose and code in Loom's own words**; do not paste his sentences, tables, or code blocks. Credit him as inspiration in the provenance note (courtesy, not obligation). If the owner wants to be extra-safe, prefer Impeccable's license-clean equivalents wherever they overlap (durations, easing, reduced-motion) and use Emil only for the unique ideas (decision framework, springs/interruptibility, blur-mask). |
| **taste-skill** | **MIT License**, © 2026 Leonxlnx (`LICENSE` is standard MIT). | **Verbatim-reusable** with attribution. | **REUSE OK.** MIT requires only that the copyright + permission notice be retained in copies/substantial portions. **Action:** if we lift substantial chunks (e.g. the dials framing or denylists), include an MIT attribution line for Leonxlnx in Loom's provenance note. Since we're mostly adapting *ideas* (dials concept, brief-inference) rather than copying text wholesale, a courtesy credit suffices; add the MIT notice if any block is reproduced near-verbatim. (README aside: "Taste Skill has no official token/coin/crypto" — irrelevant to us.) |

**Net license posture for the authored skill:** Loom's `web-design` skill is **safe to ship** as original prose that (1) freely reuses Impeccable (Apache-2.0) and taste-skill (MIT) with an attribution/NOTICE block, and (2) treats Emil's content as **reword-only**. The skill should be written in Loom's own voice throughout regardless (better quality + sidesteps all ambiguity), with a short `## Provenance` / `NOTICE` crediting: Impeccable (Apache-2.0, Paul Bakaus) + its upstreams (Anthropic frontend-design, ehmo typecraft), taste-skill (MIT, Leonxlnx), and Emil Kowalski (inspiration).

---

## 6. Recommended structure + outline for Loom's `web-design` skill

### 6.1 Shape: lean SKILL.md + small `references/` subdir

Adopt **Impeccable's modular model, not taste-skill's monolith.** A 1207-line single file is hard for an agent to load selectively and hard to maintain. Recommended layout (mirrors how Loom already ships skills under `packages/daemon/assets/skills/<name>/`):

```
web-design/
  SKILL.md                 # the entrypoint: philosophy + the consensus core + the don'ts + when to load references
  references/
    typography.md          # full type scale, measure, dark-mode compensation, font pairing
    color.md               # OKLCH, 60-30-10, commitment axis, dark mode, dangerous combos
    layout-spacing.md      # 4pt scale, hierarchy, grids, z-index, touch targets
    motion.md              # duration ladder, easing palette, the Animation Decision Framework, springs, reduced-motion, perf gotchas
    interaction.md         # 8 states, focus, forms, undo>confirm, dropdown-clip bug
    ux-writing.md          # button labels, error/empty formulas, denylist
    anti-patterns.md       # the consensus don'ts (§4) — the lint-able list, kept in one place
  NOTICE                   # attributions (Impeccable/Apache-2.0 + Anthropic + ehmo; taste/MIT; Emil/inspiration)
```

Keep `SKILL.md` short enough to always load; push exhaustive rules + code into `references/` loaded on demand (taste-skill's own research shows lazy-loaded skills cut context ~35%).

### 6.2 SKILL.md section outline

1. **Frontmatter** — `name: web-design`, description tuned for discovery (mention "UI/frontend/web design, visual polish, typography, color, motion, accessibility review").
2. **When to use / when not** — design or review web UI; *not* always-on (per Emil: case-by-case).
3. **Philosophy (≤6 lines)** — taste is trained; unseen details compound; good defaults > options; **avoid the AI default** (the through-line of all three sources).
4. **The brief read (adapted from taste §0)** — infer page kind / audience / vibe / constraints; write a one-line "Design Read"; ask **at most one** clarifying question, only when genuinely ambiguous; accessibility/regulated constraints override aesthetics.
5. **The intent dials (light adaptation of taste's idea)** — **three knobs at three levels each** (not 1–10): `EXPRESSIVENESS` (restrained · balanced · expressive), `MOTION` (minimal · standard · rich), `DENSITY` (airy · standard · dense). **Default = restrained/standard/standard** (restraint-biased, *not* taste's 8/6/4). Each maps to concrete choices in the references. Dials are set conversationally.
6. **The consensus core (the spine)** — compact, corroborated rules with pointers into references: type scale, OKLCH color + 60-30-10, 4pt spacing + hierarchy, the 8 interactive states, the motion duration ladder + custom easing + "motion must be motivated," WCAG AA, copy = verb+object/no-buzzwords/no-em-dash.
7. **The "don'ts" (the deterministic list, §4)** — the single highest-value carry; lives inline (short) and in full in `references/anti-patterns.md`. Frame as "if you can tell an AI made it, it failed."
8. **If a real design system fits, use it (taste principle, stack-agnostic)** — prefer an existing/official system over hand-rolled CSS; one system per project; don't recreate its tokens. (No prescribed package list in core; optional appendix.)
9. **Output modes** — (a) *build/enhance*: apply the rules; (b) *review/fix*: emit a `Before / After / Why` table (Emil's format, reworded); (c) *optional* full critique (compressed Nielsen + cognitive-load + 5 persona lenses) if the owner wants a `critique` mode.
10. **Pre-ship checklist** — a *short* (~12-item) distillation of the don'ts + a11y essentials (not taste's 60). 
11. **Provenance / NOTICE pointer.**

### 6.3 How to treat the "dials" / brief-inference idea (explicit recommendation)

- **Adopt brief-inference** — it's the best thing taste-skill contributes and directly improves first-shot relevance. Keep it short (the "Design Read" one-liner + one-question rule).
- **Adopt the dials, but reshape them:** keep the *concept* (a few orthogonal intent knobs the agent sets from the brief), **drop the 1–10 numerology** (false precision, and the band definitions are landing-page-flavored), use **3 named levels**, and **bias the default toward restraint** (resolves conflict C4 — taste's high-variance default is wrong for Loom's product-UI-heavy use case). This gives the adaptability without importing taste's Awwwards bias.
- **Don't** import taste's aesthetic-variant *skills* as-is. Optionally distill one `references/aesthetic-families.md` describing the axes (minimal / editorial / brutalist / glass) in neutral terms, without the persona cosplay or hard-coded hex.

### 6.4 Explicitly out of scope for the authored skill (so the 2/2 ticket stays bounded)

- Impeccable's 25-command product surface, `live`/`overdrive` browser tooling, and the Neo Kinpaku brand tokens.
- taste-skill's stack lock-in (React/Next/Tailwind/Motion/Phosphor) and the anti-laziness research.
- The full Nielsen-/40 scoring machinery (carry only a compressed review lens unless owner asks for a dedicated critique mode).
- **Porting the deterministic detector into a real lint gate** — already tracked separately as backlog card `f17791b0` ("Port Impeccable's anti-pattern linter as a design-lint gate"). This report's §4 is the rule inventory that ticket would build on; the skill itself just carries the don'ts as guidance.

---

## Appendix: blockers / caveats

- **No blockers.** All three sources were reachable and deep-read at the content level.
- **One license caveat (resolved with a clear call):** Emil Kowalski's skill ships **without any license file** → all-rights-reserved → **reword, never copy verbatim** (§5). This is a recommendation, not a blocker — the *ideas/values* are freely usable; only his specific prose/code must not be copied.
- **One provenance to verify at authoring time:** Impeccable's `NOTICE` lists ehmo's `typecraft-guide-skill` license as "see upstream repo." Impeccable-as-a-whole is Apache-2.0, so reusing via Impeccable is fine, but if the 2/2 author lifts ehmo's *specific* typography sentences verbatim, confirm ehmo's upstream license first; otherwise reword (the numeric values aren't protectable).
