import assert from "node:assert";
import { test } from "node:test";
import { classifyBusyTail } from "./transcriptLiveness";

test("interrupted-after-prompt (last msg = user prompt) → settled", () => {
  // Mirrors the real stuck trace: system/snapshot lines then a user prompt.
  const tail = [
    JSON.stringify({ type: "system" }),
    JSON.stringify({ type: "file-history-snapshot" }),
    JSON.stringify({ message: { role: "user", content: "Do something" } }),
  ];
  assert.equal(classifyBusyTail(tail), "settled");
});

test("assistant tool_use awaiting result → tool-in-flight", () => {
  const tail = [
    JSON.stringify({ message: { role: "user", content: "build it" } }),
    JSON.stringify({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", name: "Bash" },
        ],
      },
    }),
  ];
  assert.equal(classifyBusyTail(tail), "tool-in-flight");
});

test("tool_result is most recent → settled", () => {
  const tail = [
    JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash" }],
      },
    }),
    JSON.stringify({
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ok" }],
      },
    }),
  ];
  assert.equal(classifyBusyTail(tail), "settled");
});

test("assistant text turn → settled; empty/garbage → settled", () => {
  assert.equal(
    classifyBusyTail([
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ]),
    "settled",
  );
  assert.equal(
    classifyBusyTail(["", "not json", JSON.stringify({ type: "system" })]),
    "settled",
  );
});
