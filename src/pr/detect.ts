// PR detection parsing — pure helpers shared by the forward (.prs.log) and
// retroactive (transcript scan) detection paths, plus manual "Add PR" input.
// vscode-free so it can be unit-tested.

export interface DetectedPr {
  url: string; // canonical https://github.com/<owner>/<repo>/pull/<n>
  repo: string; // "owner/repo"
  number: number;
  // True when the signal proves THIS session created the PR (the transcript's
  // gitOperation.pr.action === "created"). False/absent for a bare URL match,
  // which may be a referenced PR. Callers may choose to tie only created PRs.
  created?: boolean;
}

const PR_URL_RE = /github\.com\/([^/\s"]+)\/([^/\s"]+)\/pull\/(\d+)/g;

function makeDetected(owner: string, repo: string, num: number): DetectedPr {
  return {
    repo: `${owner}/${repo}`,
    number: num,
    url: `https://github.com/${owner}/${repo}/pull/${num}`,
  };
}

// Extract every PR URL appearing in arbitrary text (a .prs.log line, a tool
// result body). De-duplicated by canonical URL, order-preserving.
export function extractPrUrls(text: string): DetectedPr[] {
  const out: DetectedPr[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PR_URL_RE)) {
    const d = makeDetected(m[1], m[2], parseInt(m[3], 10));
    if (!seen.has(d.url)) {
      seen.add(d.url);
      out.push(d);
    }
  }
  return out;
}

// Parse a single canonical PR ref from a string — a full URL, a bare
// `owner/repo#n`, or `#n`/`n` resolved against a fallback repo. Returns null
// if nothing parseable. Used by the manual "Add PR" input.
export function parsePrRef(
  input: string,
  fallbackRepo?: string,
): DetectedPr | null {
  const trimmed = input.trim();
  const urls = extractPrUrls(trimmed);
  if (urls.length > 0) return urls[0];

  // owner/repo#123
  const full = trimmed.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (full) return makeDetected(full[1], full[2], parseInt(full[3], 10));

  // #123 or 123 — needs a fallback repo
  const bare = trimmed.match(/^#?(\d+)$/);
  if (bare && fallbackRepo && fallbackRepo.includes("/")) {
    const [owner, repo] = fallbackRepo.split("/");
    return makeDetected(owner, repo, parseInt(bare[1], 10));
  }
  return null;
}

// One parsed JSONL transcript line. The shapes we care about:
//   - assistant tool_use: message.content[] {type:"tool_use", name:"Bash", input:{command}}
//   - user tool_result:   message.content[] {type:"tool_result", content:"...url..."}
//   - top-level toolUseResult.gitOperation.pr {number, url, action}
// We accept the already-JSON.parsed object and pull the PR signal from it.
//
// Prefer the structured gitOperation.pr (action === "created" precisely means
// THIS session created the PR). Fall back to a Bash `gh pr create` command +
// any PR URL in the paired result body.
export function detectPrInTranscriptLine(line: unknown): DetectedPr[] {
  if (!line || typeof line !== "object") return [];
  const obj = line as Record<string, unknown>;

  // Structured signal — the strongest tie.
  const tur = obj.toolUseResult as Record<string, unknown> | undefined;
  const gitOp = tur?.gitOperation as Record<string, unknown> | undefined;
  const pr = gitOp?.pr as Record<string, unknown> | undefined;
  if (pr && typeof pr.url === "string") {
    const fromUrl = extractPrUrls(pr.url);
    if (fromUrl.length > 0) {
      const created = pr.action === "created";
      return [{ ...fromUrl[0], created }];
    }
  }

  // Fallback — scan content blocks. A Bash `gh pr create` tool_use signals a
  // creation; a tool_result body carries the URL. We gate on the presence of
  // a `gh pr create` command anywhere in this line's content so a bare
  // referenced URL in unrelated output isn't mistaken for a creation.
  const content = ((obj.message as Record<string, unknown>)?.content ??
    obj.content) as unknown;
  if (!Array.isArray(content)) return [];

  let sawCreateCommand = false;
  const urls: DetectedPr[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && b.name === "Bash") {
      const cmd = (b.input as Record<string, unknown>)?.command;
      if (typeof cmd === "string" && /gh\s+pr\s+create/.test(cmd)) {
        sawCreateCommand = true;
      }
    }
    if (b.type === "tool_result" && typeof b.content === "string") {
      urls.push(...extractPrUrls(b.content));
    }
  }
  if (sawCreateCommand) {
    return urls.map((u) => ({ ...u, created: true }));
  }
  return [];
}

// Scan a whole transcript (JSONL text) for PRs THIS session created. Returns
// only created PRs (action === "created", or the gh-pr-create-command
// fallback), de-duplicated by canonical URL. Malformed lines are skipped.
export function scanTranscriptForCreatedPrs(jsonlText: string): DetectedPr[] {
  const out: DetectedPr[] = [];
  const seen = new Set<string>();
  for (const raw of jsonlText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const d of detectPrInTranscriptLine(parsed)) {
      if (d.created && !seen.has(d.url)) {
        seen.add(d.url);
        out.push(d);
      }
    }
  }
  return out;
}
