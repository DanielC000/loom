// Card e26f3199 fixture: sleeps for `delayMs` (argv[2]) then exits 0. Used two ways: (1) spawned as a
// GRANDCHILD by _late-close-parent.mjs, inheriting the parent's own stdio — it keeps that stdio pipe
// open past the parent's own exit, reproducing the "child already exited, close is late" shape; (2)
// spawned DIRECTLY as a stand-in for a genuinely wedged child — the contrast case where the timeout's
// own kill is what ends it, not a natural exit.
const delayMs = Number(process.argv[2] || 1000);
setTimeout(() => process.exit(0), delayMs);
