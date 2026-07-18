import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Prompt-cache hit-ratio tripwire (card 0dd60be4, rec#1 follow-up): the PURE FUNCTION
// (packages/shared/src/protocol.ts, cacheHitRatio) that scores an aggregated usage row —
// cacheRead / (cacheRead + cacheCreation + input). HERMETIC + CLAUDE-FREE + NETWORK-FREE: no DB, no
// server, just the formula against hand-built sample sums (mirroring what a real
// session_usage_samples GROUP BY sum looks like).
//
// Covers the card's DoD edge cases:
//   • READ-DOMINATED ("warm" — a byte-stable fixed session-startup prefix): cache_read dominates ⇒ ratio
//     near 1.
//   • ALL-CREATION / NEAR-ZERO-READS ("broken prefix" — re-paying the whole prefix as cache_creation
//     every turn): ratio near 0.
//   • DIVIDE-BY-ZERO GUARD: zero cacheRead+cacheCreation+input (no usage to score, e.g. a session with no
//     samples at all) returns null, never 0/NaN/Infinity — a 0 would misleadingly read as "totally
//     broken" rather than "no data".
//   • Exact fractions at a few known ratios, and that outputTokens plays NO part in the denominator (only
//     cacheRead/cacheCreation/input do — an output-heavy, cache-idle row still scores correctly).
// Run: 1) build (turbo builds shared first), 2) node test/cache-hit-ratio.mjs
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const { cacheHitRatio } = await import("@loom/shared");

// A realistic per-session GROUP BY sum shape — extra fields (samples/outputTokens/costUsd) present but
// irrelevant to the ratio, exactly like a real SessionUsageTotals row.
const row = (cacheReadTokens, cacheCreationTokens, inputTokens, outputTokens = 0) => ({
  samples: 1, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd: 0,
});

try {
  // =====================================================================================================
  // 1) READ-DOMINATED ("warm") — a long-running manager after turn 1: tiny per-turn creation, huge
  //    accumulated reads. Ratio near 1, confirming the fixed prefix stayed byte-stable.
  // =====================================================================================================
  const warm = cacheHitRatio(row(990_000, 8_000, 2_000));
  check("1 warm (read-dominated) ratio is near 1", warm !== null && warm > 0.95 && approx(warm, 990000 / 1000000));
  check("1 warm exact fraction: 990000/(990000+8000+2000) = 0.99", approx(warm, 0.99));

  // =====================================================================================================
  // 2) ALL-CREATION / NEAR-ZERO-READS ("broken prefix") — every turn re-pays ~the whole prefix as
  //    cache_creation because the fixed startup prefix stopped being byte-identical. Ratio near 0.
  // =====================================================================================================
  const broken = cacheHitRatio(row(500, 495_000, 4_500));
  check("2 broken-prefix (near-zero reads) ratio is near 0", broken !== null && broken < 0.05);
  check("2 broken-prefix exact fraction: 500/500000 = 0.001", approx(broken, 0.001));

  const totalCreation = cacheHitRatio(row(0, 100_000, 0));
  check("2b pure cache_creation, zero reads ⇒ ratio exactly 0 (not null — denom is non-zero)", totalCreation === 0);

  // =====================================================================================================
  // 3) DIVIDE-BY-ZERO GUARD — zero cacheRead+cacheCreation+input (a session with literally no usage to
  //    score, e.g. no samples at all) must return null, never 0/NaN/Infinity.
  // =====================================================================================================
  const empty = cacheHitRatio(row(0, 0, 0));
  check("3 zero denom (no usage) ⇒ null, not 0/NaN", empty === null);
  check("3 null is NOT mistakable for the broken-prefix 0 case", empty !== 0 && !Number.isNaN(empty));

  // outputTokens-only usage (a turn that only produced output, no input/cache activity at all) is the
  // same zero-denom shape — output plays no part in the ratio, so this still guards to null.
  const outputOnly = cacheHitRatio(row(0, 0, 0, 5000));
  check("3b output-only usage (zero cache/input) still guards to null", outputOnly === null);

  // =====================================================================================================
  // 4) PURE READS, NO INPUT/CREATION — a fully-cached continuation turn. Ratio exactly 1.
  // =====================================================================================================
  const pureRead = cacheHitRatio(row(50_000, 0, 0));
  check("4 pure cache_read, zero creation/input ⇒ ratio exactly 1", pureRead === 1);

  // =====================================================================================================
  // 5) outputTokens plays NO part in the denominator — an output-heavy row with identical
  //    read/creation/input sums scores IDENTICALLY regardless of outputTokens.
  // =====================================================================================================
  const lowOutput = cacheHitRatio(row(9000, 1000, 0, 10));
  const highOutput = cacheHitRatio(row(9000, 1000, 0, 999_999));
  check("5 outputTokens excluded from the ratio (low- and high-output rows score identically)",
    lowOutput === highOutput && approx(lowOutput, 0.9));
} finally {
  // no DB/fs state — nothing to tear down.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — cacheHitRatio: read-dominated/warm, all-creation/broken-prefix, divide-by-zero guard, pure-read, and outputTokens-excluded cases — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
