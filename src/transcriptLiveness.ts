// Liveness classification of a transcript tail, used to decide whether a
// session stuck on BUSY (no Stop fired — e.g. an Esc interrupt, which emits no
// hook event) can be safely downgraded to idle. vscode-free so it's
// unit-testable. Unrelated to PR tracking — it's pure session-state logic.
//
// "tool-in-flight" — the most recent message is an assistant turn that issued
//   a tool_use with no following result yet. A tool may legitimately run for
//   minutes, so these must NEVER be force-idled.
// "settled" — the most recent message is a user prompt, a tool_result, or
//   assistant text. The turn boundary has passed (or was interrupted), so a
//   long-stale BUSY here is genuinely stuck and safe to downgrade.
export type BusyLiveness = "tool-in-flight" | "settled";

export function classifyBusyTail(tailLines: string[]): BusyLiveness {
  // Walk from the end to the most recent *message* entry (skip system /
  // file-history-snapshot / summary lines that carry no role+content).
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i].trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = obj.message as Record<string, unknown> | undefined;
    const role = msg?.role;
    if (role !== "assistant" && role !== "user") continue; // not a message
    if (role === "assistant" && Array.isArray(msg?.content)) {
      const hasToolUse = (msg!.content as unknown[]).some(
        (b) => (b as Record<string, unknown>)?.type === "tool_use",
      );
      if (hasToolUse) return "tool-in-flight";
    }
    return "settled"; // most recent message is user / tool_result / assistant text
  }
  return "settled"; // no message found — nothing in flight
}
