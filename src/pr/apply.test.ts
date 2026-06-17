import assert from "node:assert";
import { test } from "node:test";
import { applyGithubFactsToMap, upsertPrCheckpoint } from "./apply";
import { GithubFacts, PrCheckpoint, SessionPr } from "./types";

function facts(over: Partial<GithubFacts> = {}): GithubFacts {
  return {
    isDraft: false,
    isMerged: false,
    hasUnresolvedReviewComments: false,
    reviewDecision: null,
    lastFetched: 100,
    ...over,
  };
}

function mkPr(url: string): SessionPr {
  return {
    url,
    repo: "o/r",
    number: 1,
    sessionId: "cc-1",
    origin: "auto",
    checkpoint: PrCheckpoint.Drafting,
    addedAt: 0,
  };
}

test("applies facts to the matching PR", () => {
  const pr = mkPr("https://github.com/o/r/pull/1");
  const map = new Map([["cc-1", [pr]]]);
  const changed = applyGithubFactsToMap(map, [
    { ccId: "cc-1", url: pr.url, facts: facts({ isMerged: true }) },
  ]);
  assert.equal(changed, true);
  assert.equal(pr.github?.isMerged, true);
});

test("update for a detached PR is dropped (race guard), not resurrected", () => {
  // The session exists but the PR was detached between dispatch and callback.
  const map = new Map<string, SessionPr[]>([["cc-1", []]]);
  const changed = applyGithubFactsToMap(map, [
    { ccId: "cc-1", url: "https://github.com/o/r/pull/1", facts: facts() },
  ]);
  assert.equal(changed, false);
  assert.equal(map.get("cc-1")!.length, 0); // not re-created
});

test("update for a deleted session is dropped", () => {
  const map = new Map<string, SessionPr[]>();
  const changed = applyGithubFactsToMap(map, [
    { ccId: "gone", url: "https://github.com/o/r/pull/1", facts: facts() },
  ]);
  assert.equal(changed, false);
  assert.equal(map.size, 0);
});

test("returns false when no updates match", () => {
  const map = new Map([["cc-1", [mkPr("https://github.com/o/r/pull/1")]]]);
  assert.equal(applyGithubFactsToMap(map, []), false);
});

test("upsertPrCheckpoint sets checkpoint + stage on an existing PR", () => {
  const pr = mkPr("https://github.com/o/r/pull/1");
  const map = new Map([["cc-1", [pr]]]);
  const r = upsertPrCheckpoint(
    map,
    "cc-1",
    "https://github.com/o/r/pull/1",
    PrCheckpoint.Shipit,
    3,
    50,
  );
  assert.equal(r?.checkpoint, PrCheckpoint.Shipit);
  assert.equal(r?.shipitStage, 3);
  assert.equal(map.get("cc-1")!.length, 1); // not duplicated
});

test("upsertPrCheckpoint tolerantly creates a PR when none is tied yet", () => {
  const map = new Map<string, SessionPr[]>();
  const r = upsertPrCheckpoint(
    map,
    "cc-1",
    "github.com/o/r/pull/9",
    PrCheckpoint.ShipitDone,
    undefined,
    50,
  );
  assert.equal(r?.url, "https://github.com/o/r/pull/9");
  assert.equal(r?.repo, "o/r");
  assert.equal(r?.number, 9);
  assert.equal(r?.origin, "auto");
  assert.equal(r?.addedAt, 50);
  assert.equal(map.get("cc-1")!.length, 1);
});

test("upsertPrCheckpoint clears stale shipitStage on a non-Shipit checkpoint", () => {
  const pr = { ...mkPr("https://github.com/o/r/pull/1"), shipitStage: 2 };
  const map = new Map([["cc-1", [pr]]]);
  upsertPrCheckpoint(
    map,
    "cc-1",
    "https://github.com/o/r/pull/1",
    PrCheckpoint.Reviewable,
    undefined,
    0,
  );
  assert.equal(pr.shipitStage, undefined);
});

test("upsertPrCheckpoint returns undefined for an uncanonicalizable url with no existing PR", () => {
  const map = new Map<string, SessionPr[]>();
  assert.equal(
    upsertPrCheckpoint(
      map,
      "cc-1",
      "not-a-pr",
      PrCheckpoint.Done,
      undefined,
      0,
    ),
    undefined,
  );
});
