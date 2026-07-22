# Browser self-verification — @playwright/mcp mechanics

Read this BEFORE driving the browser. The core doctrine (step 4) carries the binding rules — who
self-verifies vs. reports up, exercise every new interactive control, verify against the actual bound
URL, stop processes you started safely. This file carries the `@playwright/mcp`-specific mechanics:
a session on a DIFFERENT browser tool (e.g. claude-in-chrome) or with no browser at all gets none of
them (no `$LOOM_SCRATCH_DIR`, no auto-named screenshots).

## Screenshots & the scratch dir

**When you capture a verification screenshot, take it with no filename** so it auto-names into your
session's out-of-tree scratch dir and the working tree stays clean; pass a path only to deliberately
persist one, and make it **absolute under the per-session scratch directory the Playwright client
itself allows writes to** — this is not necessarily the same as your generic harness scratch/temp
dir, and a path outside Playwright's own allowed roots is rejected ("… is outside allowed roots"); a
bare or relative name also lands in the repo working tree (`git status` flags it) and risks an
accidental commit. The only sanctioned destinations are the repo-external per-session scratch dir
(the auto-name default) or, if you must persist a shot as a project artifact, the project's
configured `vaultPath` when it has one — never an arbitrary path you pick. When unsure of that root,
pass no filename/path at all and let the tool auto-name into it. **If your session has
browser-testing tools, that allowed root is also exposed to you directly as the `$LOOM_SCRATCH_DIR`
environment variable** — stage a file-upload source there too (not your generic harness scratchpad,
which the browser tools reject as outside allowed roots).

## Verifying a file download

The browser MCP auto-saves every triggered download to its output dir (the same scratch dir your
screenshots land in) and reports the saved path in the *triggering* call's own response, under an
**"Events"** section — a line like `Downloaded file <name> to "<path>"`. So check a download at the
byte level: trigger it with a normal browser action (e.g. `browser_click`), read the saved path out
of that response's Events section, then `Read()` the file off disk — don't reach first for
`page.waitForEvent('download')` in a separate `browser_run_code_unsafe` call, which always times out
because the MCP already consumed the download event. If that trigger→read-Events→`Read()` ever comes
up empty, that's the `<a download href="data:…">` edge case — do a deliberate fresh repro rather than
settling for a weaker functional check.

## Click args & the bound URL

`@playwright/mcp`'s `browser_click` takes `{ element: "<human-readable description>", target:
"<exact ref from a browser_snapshot, or a unique selector>" }` — the required key is **`target`**,
not `ref` (`ref` is a different browser tool's arg name); if a click is rejected asking for `target`,
that's the mix-up.

When you self-verify, point Playwright at the dev server's **actual bound URL** — read the port from
the framework's startup line (e.g. vite's `Local: http://…:PORT`); never assume a default port. If
that port is already held by another process, the dev server binds a different one or fails —
verifying the default would silently drive the wrong, *stale* server and report a false pass.
