# Loom — Design Language: "Terminal Cockpit"

> The visual + interaction spec for Loom's web viewport. Source of truth for the UI redesign.
> Mockups live in `./mockups/`. Stitch design system: `Loom Terminal Cockpit` (asset `6798454748259080536`,
> project `4453998798682252676`). Design tokens to land in code: `packages/web/src/theme.ts` (see the plan).

## North star

Loom is a **local-first developer cockpit for orchestrating live AI coding sessions**. The UI should read
like an **instrument panel / mission control**, not a consumer SaaS app. Dense, calm, alive. Every color is a
*signal*, not decoration. It must serve two moods at once: the high-signal real-time **cockpit** (Orchestration,
Terminals, Workspace) and a genuinely readable **document** surface (Vault).

## Surfaces & depth

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0A0B0C` | app base (true near-black) |
| `--panel` | `#101316` | cards, sidebars, columns (one step up) |
| `--panel-2` | `#0D0F11` | inputs, insets, code blocks (one step down) |
| `--border` | `#1E2329` | 1px hairline borders — the *only* source of depth |
| `--border-strong` | `#2A323A` | hover / emphasis borders |
| `--grid` | `rgba(255,255,255,0.02)` | faint dotted/grid texture on dense panels |

- Depth comes from **1px hairline borders**, never drop shadows.
- **Sharp corners** — 4px radius max. No pills, no large radii.

## Color = signal (used sparingly)

| Token | Value | Meaning |
|---|---|---|
| `--phosphor` | `#2EE66E` | primary · LIVE · online · interactive · selected (subtle CRT glow when active) |
| `--amber` | `#FFB23E` | busy · in-progress · attention |
| `--cyan` | `#5BC8FF` | info · links · branch/ctx metadata · event KIND |
| `--red` | `#FF5C5C` | kill · error · dead · rate-limited danger |
| `--text` | `#E6EAED` | primary text |
| `--text-dim` | `#8A929B` | secondary text |
| `--text-muted` | `#5A636C` | muted / metadata |

Rule: a screen at rest is mostly neutral grayscale; accent color appears only where there is **state**.

## Typography

- **Space Grotesk** — headings + section labels. Rendered **UPPERCASE**, small, letter-spaced (`0.08em`).
- **JetBrains Mono** — *all* data: session/task IDs, branches, token counts, timestamps, code, diffs, status labels.
- Body/reading text (Vault) may use Space Grotesk at comfortable size + line-height for prose; code stays mono.

Scale (suggested): label `11px/600/upper`, body `13px`, data `12–13px mono`, h1 `24px`, h2 `16px upper`.

## Components

- **Status pill** = small glowing dot + uppercase mono label: `ONLINE` `IDLE` `BUSY` `RATE-LIMITED` `PAUSED` `DEAD`.
  Dot color follows the signal palette; `BUSY`/live dots get a faint glow (`box-shadow: 0 0 6px <color>`).
- **Card / panel** = `--panel` bg, 1px `--border`. Selected = `--phosphor` border + faint inner glow
  (`box-shadow: inset 0 0 0 1px rgba(46,230,110,.25)`).
- **Button** = compact, mono, 1px-bordered, transparent bg. Primary = phosphor outline, fills on hover.
  Danger = red outline. No filled consumer buttons.
- **Input / select** = `--panel-2` bg, 1px border, mono, focus ring = phosphor.
- **List / table** = dense rows, hairline dividers, monospace, no zebra striping.
- **Meter** = thin 2–3px bar (phosphor→amber as it fills) for context-token usage; inline chips for branch/ctx.
- **Top nav** = uppercase mono tabs; active tab underlined in phosphor (2px).
- **Chip** = `branch loom/8f3a`, `ctx 56,200` — muted mono, hairline border, sharp corners.

## Per-surface intent

- **Orchestration** — the flagship cockpit. Worker fleet cards (status pill + branch/ctx chips), event timeline
  (KIND in cyan), branch diff (green/red). Live 2s polling must feel *steady*, not flickery.
- **Workspace** — master-detail: Projects → Agents → Sessions sidebar + terminal/transcript pane. Manager sessions
  starred + phosphor-bordered and pinned to top.
- **Terminals** — xterm tile grid; chrome stays out of the way, status in tile title bars.
- **Board** — dense kanban; status as column + card accent (todo neutral, in-progress amber bar, review cyan, done phosphor check).
- **Vault** — the calm one. Instrument chrome, but a readable document pane (generous spacing, cyan `[[wikilinks]]`).
- **Git** — read-only diff/log; reuse the diff styling from Orchestration.

## Anti-patterns (do not)

No light mode. No pastel gradients. No rounded consumer pills. No big drop shadows. No emoji-as-icon. No filled
candy buttons. Color without meaning. Flicker on poll.

## Status

Design language **selected 2026-06-01** (Terminal Cockpit, over Refined Dark / Woven Warm). Mockups generated in
Stitch; token migration + per-page redesign sequenced in the UI/UX plan (see the session note / roadmap).
