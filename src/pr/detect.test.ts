import assert from "node:assert";
import { test } from "node:test";
import {
  detectPrInTranscriptLine,
  extractPrUrls,
  parsePrRef,
  scanTranscriptForCreatedPrs,
} from "./detect";

test("extractPrUrls pulls + canonicalizes a URL", () => {
  const out = extractPrUrls(
    "Created https://github.com/lumalabs/luma-core/pull/12309\nShell cwd reset",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://github.com/lumalabs/luma-core/pull/12309");
  assert.equal(out[0].repo, "lumalabs/luma-core");
  assert.equal(out[0].number, 12309);
});

test("extractPrUrls dedups repeated URLs", () => {
  const u = "see github.com/o/r/pull/5 and github.com/o/r/pull/5 again";
  assert.equal(extractPrUrls(u).length, 1);
});

test("extractPrUrls returns nothing for input without a URL", () => {
  assert.equal(extractPrUrls("gh pr create --title x").length, 0);
});

test("parsePrRef handles full URL, owner/repo#n, and #n with fallback", () => {
  assert.equal(parsePrRef("https://github.com/o/r/pull/7")?.number, 7);
  assert.equal(parsePrRef("o/r#8")?.url, "https://github.com/o/r/pull/8");
  assert.equal(parsePrRef("#9", "o/r")?.url, "https://github.com/o/r/pull/9");
  assert.equal(parsePrRef("9", "o/r")?.number, 9);
  assert.equal(parsePrRef("9"), null); // no fallback repo
  assert.equal(parsePrRef("garbage"), null);
});

test("transcript: structured gitOperation.pr action=created → created PR", () => {
  const line = {
    toolUseResult: {
      gitOperation: {
        pr: {
          number: 12309,
          url: "https://github.com/lumalabs/luma-core/pull/12309",
          action: "created",
        },
      },
    },
  };
  const out = detectPrInTranscriptLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 12309);
  assert.equal(out[0].created, true);
});

test("transcript: gitOperation action != created → not flagged created", () => {
  const line = {
    toolUseResult: {
      gitOperation: { pr: { url: "github.com/o/r/pull/3", action: "viewed" } },
    },
  };
  const out = detectPrInTranscriptLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].created, false);
});

test("transcript: Bash gh pr create + result url → created (fallback path)", () => {
  const line = {
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "gh pr create -d" },
        },
        { type: "tool_result", content: "https://github.com/o/r/pull/42 done" },
      ],
    },
  };
  const out = detectPrInTranscriptLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 42);
  assert.equal(out[0].created, true);
});

test("transcript: referenced URL with no create command → no detection", () => {
  const line = {
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "gh pr view 42" } },
        { type: "tool_result", content: "https://github.com/o/r/pull/42" },
      ],
    },
  };
  assert.equal(detectPrInTranscriptLine(line).length, 0);
});

test("transcript: non-object / empty lines are safe", () => {
  assert.equal(detectPrInTranscriptLine(null).length, 0);
  assert.equal(detectPrInTranscriptLine("string").length, 0);
  assert.equal(detectPrInTranscriptLine({}).length, 0);
});

test("scanTranscriptForCreatedPrs: created PR over JSONL, dedup, skips malformed + referenced", () => {
  const jsonl = [
    "not json",
    JSON.stringify({
      toolUseResult: {
        gitOperation: {
          pr: { url: "github.com/o/r/pull/1", action: "created" },
        },
      },
    }),
    // duplicate of #1 via a later line → deduped
    JSON.stringify({
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "gh pr create" },
          },
          { type: "tool_result", content: "github.com/o/r/pull/1" },
        ],
      },
    }),
    // a merely-referenced PR → not collected
    JSON.stringify({
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "gh pr view 2" },
          },
          { type: "tool_result", content: "github.com/o/r/pull/2" },
        ],
      },
    }),
    "",
  ].join("\n");
  const out = scanTranscriptForCreatedPrs(jsonl);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 1);
});
