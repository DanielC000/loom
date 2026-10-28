// How the Atlas tree orders its project rows — card ec1aa18e, the owner's own words: "Currently
// running projects should be ordered at the top, ordered alphabetically. Above projects that are not
// currently running."
//
// A pure comparator in its own module, not a `.sort()` inlined in the tree, because the ordering is
// the part of that card with a real specification (two groups, a named sort within each, and a
// tiebreak) and it is the part worth pinning with a hermetic unit test. The tree supplies the
// liveness reading; nothing here knows how liveness is derived.
//
// 🔴 THIS REPLACES THE TREE'S OLD "source order, never reordered by liveness" RULE, which argued that
// a nav rail whose rows move as sessions start and stop is one you stop trusting to be where you left
// it. The owner overruled it: a workspace with many projects buries the two that are actually working
// below a list of idle ones, and the rail is read to find what is running. The cost is real and
// accepted — a row CAN move under the cursor when a session starts — not overlooked.
import type { Project } from "@loom/shared";

/** Is this project one of the "currently running" group — does anything live belong to it? */
export type IsRunning = (project: Project) => boolean;

/**
 * Projects ordered running-first, alphabetical within each group.
 *
 * Alphabetical is `localeCompare` with `sensitivity: "base"`, so "atlas" and "Atlas" sort together
 * rather than splitting on case the way a raw `<` comparison on UTF-16 code units does (every
 * capitalised name would otherwise lead every lowercase one). A name collision falls back to the
 * project's own id, so the order is TOTAL: two projects sharing a name never swap places between
 * renders just because the input array arrived in a different order.
 *
 * Returns a NEW array — the caller's list (ActiveProjectProvider's own memoised `projects`) is shared
 * state and must not be sorted in place.
 */
export function sortProjectsRunningFirst(projects: readonly Project[], isRunning: IsRunning): Project[] {
  return projects.slice().sort((a, b) => {
    const ra = isRunning(a) ? 0 : 1;
    const rb = isRunning(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}
