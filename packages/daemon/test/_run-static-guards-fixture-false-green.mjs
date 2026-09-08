// Fixture for run-static-guards.mjs (card 61d75a3c) — NOT a real guard, never added to
// STATIC_GUARD_REPO_PATHS. Mimics a guard whose own check() helper recorded a FAIL line yet the process
// still exits 0 — the exact false-green shape run-static-guards.mjs's quiet mode exists to catch. Invoked
// only via run-static-guards.mjs's --paths test seam (see run-static-guards-false-green.mjs).
console.log("PASS  fixture check one");
console.log("FAIL  fixture check two");
process.exit(0);
