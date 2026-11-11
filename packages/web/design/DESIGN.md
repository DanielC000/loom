# Loom — Design Language: "Graphite"

> The visual and interaction spec for Loom's web viewport. Token values live once, as CSS custom properties in `packages/web/src/styles/global.css`; `packages/web/src/theme.ts` exposes them to TS as `var()` strings (`color`, `font`, `fs`, `radius`, `shadow`, `tone`). Never type a colour, size or radius literal in a component; read the token. The source spec is the vault's `Projects/Loom/Mockups/2026-11-05 Atlas Design Language/` (direction B), and the migration plan is epic `e25fa8a9`. The older mockups in `./mockups/` are the superseded "Terminal Cockpit" language and are kept for history only.

## North star

Loom orchestrates a fleet of real Claude Code sessions. The UI should be calm, dense and legible for hours: tonal surfaces instead of boxes, one accent, sans-serif prose, and colour that always means something. It must serve the real-time cockpit surfaces (Atlas, board, sessions, terminals) and a readable document surface (Vault) with the same tokens.

## Themes

There are two themes, `dark` and `light`, chosen per browser (Settings → Interface → Theme: System / Light / Dark; the default is System). `lib/themePref.ts` stores the preference (`loom.theme`), resolves `system` through `prefers-color-scheme`, and sets `data-theme` and `color-scheme` on `<html>`; an inline script in `index.html` does the same before first paint, so there is no flash. Every token is defined under `:root[data-theme="dark"]` and `:root[data-theme="light"]`; bare `:root` carries the dark set as the fallback. The terminal stays a dark well in both themes, because the `claude` TUI's ANSI colours are tuned for a dark background (`lib/xtermTheme.ts`).

## Colour tokens

All values are OKLCH. TS keys in brackets.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--loom-bg` (`bg`) | 0.175 0.005 260 | 0.975 0.002 260 | page |
| `--loom-inset` (`inset`) | 0.155 0.005 260 | 0.955 0.003 260 | wells, code blocks, one step down |
| `--loom-field-bg` (`fieldBg`) | 0.155 0.005 260 | 1 0 0 | inputs and selects |
| `--loom-surface` (`surface`) | 0.215 0.006 260 | 1 0 0 | panels, one tonal step up |
| `--loom-surface-2` (`surface2`) | 0.25 0.007 260 | 0.955 0.003 260 | chips, segmented tracks |
| `--loom-raised` / `--loom-card-bg` (`raised`, `cardBg`) | 0.255 0.007 260 | 1 0 0 | cards sit a step above their lane (`--loom-lane-bg`) |
| `--loom-hover` / `--loom-pressed` / `--loom-selected` | 0.25 / 0.285 / 0.27 0.035 258 | 0.945 / 0.915 / 0.94 0.03 258 | state steps |
| `--loom-line` (`line`) | 0.28 0.007 260 | 0.92 0.004 260 | dividers only; panels have no border |
| `--loom-line-strong` (`lineStrong`) | 0.52 0.01 260 | 0.64 0.01 260 | field and control borders (3:1) |
| `--loom-text` (`text`) | 0.965 0.003 260 | 0.205 0.008 260 | primary text |
| `--loom-text-2` (`text2`) | 0.8 0.008 260 | 0.4 0.01 260 | secondary text |
| `--loom-text-3` (`text3`) | 0.69 0.01 260 | 0.5 0.01 260 | muted text and metadata (still AA) |
| `--loom-accent` (`accent`) | 0.56 0.215 264 | 0.5 0.225 264 | cobalt: primary buttons, selection, focus (`--loom-ring`), links (`--loom-accent-fg`) |
| `--loom-live` (`live`, text `liveText`) | 0.76 0.15 155 | 0.62 0.15 155 | green: **live, and nothing else** |
| `--loom-busy` (`busy`) | 0.83 0.13 78 | 0.52 0.12 62 | busy, in progress, attention |
| `--loom-info` (`info`) | 0.78 0.11 255 | 0.49 0.17 258 | info and metadata |
| `--loom-danger` (`danger`) | 0.73 0.16 22 | 0.53 0.19 25 | kill, error, dead, rate-limited |

Each signal colour has a `-soft` fill (`liveSoft`, `busySoft`, `infoSoft`, `dangerSoft`) for capsules and tinted rows. `wash(color.x, pct)` in `theme.ts` mixes a translucent tint of any token, so it follows the theme. Meters use `--loom-track` and `--loom-meter-ok` (cobalt); overlays use `--loom-scrim`.

**Elevation.** In dark, elevation is tonal: panels and cards cast nothing. In light, it is a hairline ring plus a short shadow (`--loom-panel-shadow`, `--loom-card-shadow`, `--loom-pop-shadow`; TS `shadow.*`).

**Rule:** a screen at rest is mostly neutral graphite. Colour appears only where there is state, and green means live only. Done lanes, manager badges and finished things are muted or accent, never green.

## Typography

- **Instrument Sans** (`--loom-font-ui`, TS `font.ui`) for prose, labels, headings and buttons. The body is 14px / 1.45.
- **Geist Mono** (`--loom-font-mono`, TS `font.mono`) only for data: ids, shas, branches, paths, cron, numbers in tables, code and diffs. The terminal keeps xterm's own font.
- Both are self-hosted variable woff2 (`src/styles/fonts.css`), so the UI makes no third-party request.
- Numbers use `font-variant-numeric: tabular-nums`.
- **Sentence case everywhere.** No `text-transform: uppercase` and no letter-spaced eyebrows. A label whose source is a lowercase literal is sentence-cased at the source, or at display with `lib/textCase.ts` `sentenceCase`. Enum and tag values (a role, a status word, `batch`) stay lowercase.

Type scale (`--loom-fs-*`, TS `fs.*`):

| Step | Size | Use |
|---|---|---|
| `xs` | 11px | the floor: dense meta, small labels and mono ids. No text is set smaller, and there are no in-between sizes |
| `sm` | 12px | small text and labels |
| `mono` | 12.5px | data |
| `body` | 14px | body and controls |
| `lg` | 17.5px | sub-heads |
| `h1` | 22px | page titles |
| `kpi` | 27.5px | KPI figures, semibold and tabular |

## Shape and motion

Radius has one 8px base (`--loom-radius`, TS `radius.base`): 6px for tags and small controls (`sm`), 12px for panels, cards and lanes (`lg`), and 999px for capsules and chips (`pill`). State changes use one easing (`--loom-ease`) and one duration (`--loom-dur-1`, 140ms). Nothing pulses or glows.

## Components (`src/components/ui`)

- **Panel**: a `surface` fill, no border, radius 12, 16px padding, `shadow.panel`. Selected is a `selected` fill with an inset 1px `accentEdge` ring. Its `style` prop wins over the defaults.
- **Button**: `primary` is a solid `accent` fill with an `onAccent` label; `default` is a `btnBg` fill with a `line` hairline; `ghost` is transparent with a `hover` fill; `danger` is a `dangerSoft` fill with `danger` text. Radius 8, `4px 12px` padding, sans 14 / 500. The chrome lives in the `.loom-btn-*` classes.
- **Input / Select**: a `fieldBg` fill, a `lineStrong` border, radius 8, and the sans for free text; a field that holds an id or code uses mono. Focus is a 2px `ring` with a `ringSoft` halo, as is every `:focus-visible` in the app.
- **StatusPill**: a capsule (radius 999, `-soft` fill, a 6px dot, the label in the tone's text colour, 12px / 500, sentence case). Status is always dot plus word, never colour alone.
- **Badge**: a 6px-radius tinted tag with no border. **Chip**: a pill on `surface2` with no border. **Dot**: 8px, no glow.
- **SectionLabel**: sans 600 at 14 in `text`, sentence case. **NavTab**: sans 14/500, active 600 in `accentFg` with a 2px `accent` underline. A band heading (`.loom-bandhead`) carries a 3px `accent` bar in the panel padding, its jump link (`.loom-bandlink`) reads in `accentFg`, and empty-band copy (`.loom-bandempty`) opens with an `accentFg` glyph. **Segmented**: a `surface2` track with a raised thumb (`--loom-seg-on`).
- **Meter**: a `track` track and a `meterOk` fill.
- **Tones** (`Tone` in `theme.ts`): `live | busy | info | danger | muted | accent`. `tone` is the signal colour for `color:` and borders, `toneText` the text on its own soft fill, `toneFill` the colour of a dot or a meter bar, and `toneSoft` the capsule background.

## Per-surface intent

- **Atlas** (the shell): a `--loom-rail-bg` tree rail with no border line; the selected node gets a `selected` fill, an accent icon and a 2px `accent` left edge; the node head and crumbs follow the type scale.
- **Board**: lanes are tinted wells (`--loom-lane-bg`, radius 12); a lane head is a dot plus a sentence-case name; cards are `cardBg` with a light-only hairline and shadow. The board embedded in the Overview is the owner's primary board: restyle it, never drop or summarise it.
- **Sessions and terminals**: a tonal header, a status capsule, NavTab tabs, and the terminal as a dark well in both themes.
- **Vault**: the calm one; a readable document pane with generous spacing. Markdown colours come from the `--loom-md-*` tokens.

## Anti-patterns (do not)

No colour, size or radius literals in components. No uppercase or letter-spaced labels. No glow, no pulse, no gradients. Green for anything other than live. Mono for prose. Borders around panels. Colour as the only signal of a status. Flicker on poll.

## Status

Graphite was picked on 2026-11-05 (decision `53de764c`, direction B), with light and dark themes, replacing "Terminal Cockpit" (selected 2026-06-01). The migration is epic `e25fa8a9`. The legacy Terminal Cockpit token names (`--loom-panel`, `--loom-phosphor`, …) and their `theme.ts` keys are retired. Moving the remaining prose off monospace is still in flight.
