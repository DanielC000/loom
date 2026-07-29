// Re-chunks an arbitrary byte/string stream into complete lines and hands each one to `onLine`
// with a timestamp appended. Exists because a child process's stdout/stderr "data" events are
// arbitrary byte chunks — they do NOT align with line boundaries (one chunk can hold many lines,
// or split a single line across two chunks) — so a caller that wants "one timestamp per log line"
// has to buffer until it sees the next "\n" rather than stamping each raw chunk.
//
// Timestamp placement: END of line, not a prefix. Every documented measurement recipe against
// scripts/daemon-supervisor.mjs's teed log anchors on line START (e.g. `grep "^[submit]"`,
// `awk index(line, needle)==1`) — that anchoring is load-bearing because spawn argv lines echo
// whole kickoff prompts into the log, so an unanchored grep matches an investigation's own text.
// A prefix would silently break every one of those recipes; a suffix leaves them byte-identical.
//
// Timestamp format: epoch milliseconds, not ISO-8601. The reason a timestamp was requested at all
// (card be9571a4, unblocking 04de8bbf) is to answer TIME-RADIUS questions — "were other messages
// queued/drained within N seconds of this line" — which wants a plain numeric delta, not a string
// that needs parsing back into a Date first. Monotonic ordering matters more than human
// readability here (per the card), and epoch-ms sorts and subtracts directly.
export function createLineTimestamper(onLine, now = () => Date.now()) {
  let buf = "";
  const emit = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw; // tolerate CRLF chunks
    onLine(`${line} ${now()}\n`);
  };
  return {
    write(chunk) {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop(); // last element is the incomplete tail ("" if chunk ended on a newline)
      for (const raw of parts) emit(raw);
    },
    // Call once the source stream has ended, to flush a final line that never got a trailing "\n".
    flush() {
      if (buf.length === 0) return;
      emit(buf);
      buf = "";
    },
  };
}
