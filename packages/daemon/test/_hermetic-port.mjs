// Card d314f78d: runtime-unique-by-construction LOOM_PORT allocation for hermetic test files — the
// same "let something the OS guarantees is unique do the picking" principle _tmp-fixture.mjs's
// mkdtempManaged already uses for temp dirs, applied to the LOOM_PORT literal a hermetic test sets
// before requireHermeticEnv({port:true}) (see _guard.mjs).
//
// WHY: 43+ hermetic test files used to hand-pick a literal LOOM_PORT value, and duplicates across
// files were common (20 collision groups measured). None of these ports are ever bound — no file in
// this convention calls `.listen()` against LOOM_PORT (verified for card d314f78d) — so the
// duplication cannot cause cross-file interference TODAY. But it is one `.listen()` away from a real,
// silent collision the instant any file starts binding it for real, and a hand-picked literal gives a
// future author no way to know or avoid that.
//
// process.pid is unique among every CONCURRENTLY-RUNNING sibling process on this host — exactly the
// collision surface a future real bind would create — so deriving from it makes a same-value collision
// between two simultaneously-running hermetic test files VANISHINGLY UNLIKELY RATHER THAN CERTAIN,
// unlike a fixed per-file literal, which collides with CERTAINTY the moment two files that share one
// happen to run in the same pool at once. This is NOT a structural-impossibility guarantee: two
// concurrent pids differing by exactly PORT_RANGE_SIZE map to the same port.
const PORT_RANGE_BASE = 40000; // clear of PROD_PORT (4317, see _guard.mjs) and any real dev port
const PORT_RANGE_SIZE = 20000; // stays well inside the valid 0-65535 port space

export function hermeticPort() {
  return PORT_RANGE_BASE + (process.pid % PORT_RANGE_SIZE);
}
