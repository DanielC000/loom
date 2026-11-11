# Mockups — Loom "Terminal Cockpit"

Stitch-generated reference mockups for the "Terminal Cockpit" UI redesign. See `../DESIGN.md` for the design language spec.

> **Historical.** These describe the pre-Atlas web UI. The Atlas UI replaced it (card `acbb6df6`): Mission Control (`05-mission-control.png`) and the workspace master-detail page (`02-workspace.png`) no longer exist in the app, and their old addresses redirect into Atlas nodes; the board, vault and review surfaces survive inside Atlas nodes in a different frame. Keep the files as design history; don't build against them.

| File | Surface | Status |
|---|---|---|
| `01-orchestration.png` | Orchestration cockpit (flagship) | ✅ captured |
| `02-workspace.png` | Workspace master-detail | ✅ captured |
| `03-board.png` | Task board (kanban) | ✅ captured |
| `04-vault.png` | Vault markdown reader | ✅ captured |
| `05-mission-control.png` | Mission Control global dashboard (**net-new**) | ✅ captured |
| `06-review-panel.png` | Review & Merge panel (**net-new**) | ✅ captured |

## Source

Design system asset (shared across all screens): **`Loom Terminal Cockpit`** — `assets/6798454748259080536`
(DARK · VIBRANT · seed `#2EE66E` phosphor · Space Grotesk + JetBrains Mono · ROUND_FOUR).

| Screen | Stitch project |
|---|---|
| Orchestration | `projects/4453998798682252676` |
| Workspace | `projects/2488985025138132739` |
| Board | `projects/10692117273148657381` |
| Vault | `projects/8592515079871925194` |
| Mission Control | `projects/12867473939464031055` |
| Review Panel | `projects/7754993006127986748` |

## Notes

- The Stitch MCP `list_screens` returned empty and a multi-screen project's thumbnail pins to its first screen, so
  each screen was generated as **its own single-screen project** and pulled via that project's downloadable thumbnail.
- Minor mockup artifacts to ignore (they're reference only): the Vault wordmark rendered as "OBSIDIANJO" instead of
  LOOM, and per-screen accent greens drift slightly (`#2EE66E`/`#00FF41`/`#4AF626`). The canonical tokens are in
  `../DESIGN.md`, not the mockups.
