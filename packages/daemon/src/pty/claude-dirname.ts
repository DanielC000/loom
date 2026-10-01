/**
 * Split out of `claude-doctrine.ts` (card 37310431 delta security review, item 8) so a module that only
 * needs the ONE literal — `paths.ts`, for `LOOM_HOME_INSTRUCTION_WRITE_DENY_REGISTRY` — doesn't acquire
 * `claude-doctrine.ts`'s own `chokidar` dependency transitively. Zero imports, deliberately — this file
 * must stay a true leaf for that guarantee to hold. `claude-doctrine.ts` re-exports this constant so
 * every existing consumer of it stays unchanged.
 */

/** The directory name Claude Code discovers project-local doctrine (skills, settings) under. */
export const CLAUDE_DOCTRINE_DIR = ".claude";
