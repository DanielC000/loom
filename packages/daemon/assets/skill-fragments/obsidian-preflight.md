## Vault preflight (Obsidian enabled)

This project has Obsidian auto-start enabled. The vault is still just a **folder of `.md` files** you read
and write by absolute path — that always works and stays the fallback. Obsidian is an optional enhancement.

Only when a step actually uses the `obsidian` CLI (it needs the Obsidian DESKTOP app running, not just the
REST API) run the preflight FIRST: `node "$LOOM_OBSIDIAN_PREFLIGHT"`. It self-heals a down Obsidian (launch
+ poll-until-ready, bounded) and is **default-safe** — on disabled/headless/not-installed/timeout it prints
a non-`ready` status and you simply fall back to **direct filesystem** access of the vault by path. Never
block on it.
