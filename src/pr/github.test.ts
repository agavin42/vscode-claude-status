import assert from "node:assert";
import { test } from "node:test";
import { mapGhJsonToFacts } from "./github";

test("maps a draft, unreviewed open PR", () => {
  const f = mapGhJsonToFacts(
    { state: "OPEN", isDraft: true, reviewDecision: "", title: "WIP" },
    1000,
  );
  assert.equal(f.isDraft, true);
  assert.equal(f.isMerged, false);
  assert.equal(f.reviewDecision, null);
  assert.equal(f.hasUnresolvedReviewComments, false);
  assert.equal(f.title, "WIP");
  assert.equal(f.lastFetched, 1000);
});

test("isMerged from state and from mergedAt", () => {
  assert.equal(mapGhJsonToFacts({ state: "MERGED" }, 0).isMerged, true);
  assert.equal(
    mapGhJsonToFacts({ state: "CLOSED", mergedAt: "2026-06-16T00:00:00Z" }, 0)
      .isMerged,
    true,
  );
  assert.equal(
    mapGhJsonToFacts({ state: "OPEN", mergedAt: "" }, 0).isMerged,
    false,
  );
});

test("hasUnresolvedReviewComments from reviewDecision", () => {
  const f = mapGhJsonToFacts(
    { state: "OPEN", reviewDecision: "CHANGES_REQUESTED" },
    0,
  );
  assert.equal(f.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(f.hasUnresolvedReviewComments, true);
});

test("hasUnresolvedReviewComments from a latestReviews entry", () => {
  const f = mapGhJsonToFacts(
    {
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      latestReviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
    },
    0,
  );
  assert.equal(f.hasUnresolvedReviewComments, true);
});

test("approved review → no unresolved comments", () => {
  const f = mapGhJsonToFacts(
    {
      state: "OPEN",
      reviewDecision: "APPROVED",
      latestReviews: [{ state: "APPROVED" }],
    },
    0,
  );
  assert.equal(f.hasUnresolvedReviewComments, false);
  assert.equal(f.reviewDecision, "APPROVED");
});

test("missing/garbage fields are tolerated", () => {
  const f = mapGhJsonToFacts({}, 5);
  assert.equal(f.isDraft, false);
  assert.equal(f.isMerged, false);
  assert.equal(f.reviewDecision, null);
  assert.equal(f.hasUnresolvedReviewComments, false);
  assert.equal(f.title, undefined);
  assert.equal(f.lastFetched, 5);
});
