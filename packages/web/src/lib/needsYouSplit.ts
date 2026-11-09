// The Workspace node's `needs you` figure, split into what it is made of (card 73b41b5d, Atlas audit
// A-15). The tile counted every attention item while the Inbox tab beside it counts Requests only, so
// the page showed "Needs you 12" next to "Inbox 10" with nothing saying why. The split names the parts.
//
// Pure, no React and no app imports, so the hermetic unit test (test/needs-you-split.mjs) imports the
// real function rather than a copy.

/** The fields of an attention item this reads. Structural, so the test can pass plain objects. */
export interface NeedsYouItem {
  kind: string;
  questionId?: string | null;
  isNotice?: boolean;
}

export interface NeedsYouSplit {
  /** Requests waiting on an answer. The same rows the Inbox tab counts as pending. */
  requests: number;
  /** Worker branches awaiting review. */
  merges: number;
  /** Unread notices. A notice needs reading, not an answer, so the Inbox count leaves it out. */
  notices: number;
  /** Everything else: fleet alerts (stuck, rate-limited, crashed, context overflow, ...). */
  alerts: number;
}

export function needsYouSplit(items: readonly NeedsYouItem[]): NeedsYouSplit {
  const split: NeedsYouSplit = { requests: 0, merges: 0, notices: 0, alerts: 0 };
  for (const it of items) {
    if (it.questionId != null) {
      if (it.isNotice) split.notices++;
      else split.requests++;
    } else if (it.kind === "MERGE REQUEST") split.merges++;
    else split.alerts++;
  }
  return split;
}

/** "10 requests · 1 merge · 1 notice". Zero parts are left out; nothing at all reads "nothing waiting". */
export function needsYouSummary(split: NeedsYouSplit): string {
  const parts: string[] = [];
  const add = (n: number, one: string) => { if (n > 0) parts.push(`${n} ${n === 1 ? one : `${one}s`}`); };
  add(split.requests, "request");
  add(split.merges, "merge");
  add(split.notices, "notice");
  add(split.alerts, "alert");
  return parts.length > 0 ? parts.join(" · ") : "nothing waiting";
}
