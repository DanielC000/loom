// SHARED GIT-ARGV-MATCHING HELPER FOR STUB `gitFactory`s (card 7557fac7).
//
// WHY THIS EXISTS: a `gitFactory` test stub recognizes a real git call by pattern-matching `args` (the
// array handed to `raw(args)`). Card 3a5c5d4a (commit c056c607) prepended `["-c",
// "worktree.useRelativePaths=false"]` to createWorktree's own `worktree add` calls — a real, LEGITIMATE
// argv shape change — and every stub keyed on a HARDCODED index (`args[0]`/`args[1]`) went silently dead:
// the condition it was built to match stopped matching, so the stub fell through to its "else" branch
// (usually real, unmocked git) instead of ever throwing, delaying, or hanging as the test intended. The
// test FILE still ran and reported a result; it just wasn't testing what it claimed to.
//
// `gitSubcommand`/`gitSubSubcommand` fix this at the ROOT: they locate the subcommand by SKIPPING any
// number of leading `-c <key>=<value>` pairs (never assuming zero, one, or any other fixed count), and
// return the subcommand's OWN NEIGHBOUR index — never a caller-hardcoded position — so a future argv
// change (another `-c` pair, or none at all) can't silently desync a stub's matching from where the
// subcommand actually landed.
//
// Use `gitSubSubcommand(args)` for a TWO-LEVEL git command ("worktree add", "worktree prune", "branch
// --list") and bare `gitSubcommand(args)` for a one-level command ("rev-parse", "status", "commit").
// Use `argsAfterConfig(args)` when a stub also needs to read POSITIONAL args that follow the command
// (e.g. `worktree add`'s own worktree-path/branch arguments) — it returns a fresh array re-based at the
// subcommand, so every existing relative index (`rest[2]`, `rest.indexOf("-b")`, …) keeps working exactly
// as if no `-c` prefix were ever there. Never reintroduce a bare `args[0]`/`args[1]`/`args[2]` check in a
// NEW stub — grep this file's own name before adding one, and import from here instead.
//
// Card 75199847: the EXACT same desync class hit a DIFFERENT argv position. `landBranchCommitsIndividually`
// used to pass a batch candidate's own commit message via `-m <text>` — several stubs recognized WHICH
// candidate a `commit`/`--amend` call was landing by pattern-matching that literal text somewhere in
// `args`. Switching to `-F <tempfile>` (removes the Windows argv ENAMETOOLONG ceiling) moved the message
// OFF argv entirely — onto disk — so every such stub silently stopped matching, exactly like the `-c`-pair
// case above: the test kept running and reporting a result, just not testing what it claimed to.
// `commitMessageArgvText(args)` is the fix at the SAME root: it resolves the message text regardless of
// which form carried it (`-m`'s literal value, or `-F`'s file read synchronously) — a stub matching on
// message CONTENT should call this instead of scanning `args` for the text directly.
import fs from "node:fs";

/** The real subcommand a `git.raw(args)` call names — e.g. "worktree", "branch", "rev-parse", "status" —
 *  skipping any number of leading `-c <key>=<value>` PAIRS (each consumes two array slots). */
export function gitSubcommand(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args[i];
}

/** The subcommand PLUS its own next argv slot — e.g. {sub:"worktree", subSub:"add"} for `worktree add`,
 *  {sub:"branch", subSub:"--list"} for `branch --list` — read relative to WHERE the subcommand actually
 *  landed (via {@link gitSubcommand}'s own skip logic), never a hardcoded `args[1]`. */
export function gitSubSubcommand(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return { sub: args[i], subSub: args[i + 1] };
}

/** `args`, with any leading `-c <key>=<value>` pairs stripped, so index 0 is always the real subcommand
 *  regardless of how many (if any) config pairs preceded it — a stub reading POSITIONAL args after the
 *  subcommand (e.g. `rest[2]` for `worktree add`'s own worktree-path) should slice this, never `args`
 *  itself. */
export function argsAfterConfig(args) {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args.slice(i);
}

/**
 * The commit message text a `git commit`/`git commit --amend` call carries, regardless of whether it rode
 * `-m <text>` (the literal next argv element) or `-F <path>` (read synchronously from disk) — card
 * 75199847. Returns `""` when `args` carries neither flag, or when a named `-F` file can't be read (e.g. a
 * stub racing a real write — never throws). A stub that used to scan `args` for message text directly
 * (`args.some(x => x.includes(...))`/`.startsWith(...)`) should call this instead and match against the
 * RETURNED text, so it keeps working whichever form production code uses to carry the message.
 */
export function commitMessageArgvText(args) {
  if (!Array.isArray(args)) return "";
  const mIdx = args.indexOf("-m");
  if (mIdx !== -1 && typeof args[mIdx + 1] === "string") return args[mIdx + 1];
  const fIdx = args.indexOf("-F");
  if (fIdx !== -1 && typeof args[fIdx + 1] === "string") {
    try { return fs.readFileSync(args[fIdx + 1], "utf8"); } catch { return ""; }
  }
  return "";
}
