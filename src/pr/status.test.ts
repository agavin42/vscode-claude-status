import assert from "node:assert";
import { test } from "node:test";
import { resolvePrStatus, isTerminalForPolling } from "./status";
import {
  GithubFacts,
  PrCheckpoint,
  PrStatus,
  ReviewDecision,
  SessionPr,
} from "./types";

function pr(
  checkpoint: PrCheckpoint,
  github?: Partial<GithubFacts>,
  shipitStage?: number,
): SessionPr {
  return {
    url: "https://github.com/o/r/pull/1",
    repo: "o/r",
    number: 1,
    sessionId: "cc-1",
    origin: "auto",
    checkpoint,
    shipitStage,
    github: github
      ? {
          isDraft: false,
          isMerged: false,
          hasUnresolvedReviewComments: false,
          reviewDecision: null as ReviewDecision,
          lastFetched: 0,
          ...github,
        }
      : undefined,
    addedAt: 0,
  };
}

test("rule 1: Done checkpoint resolves Done", () => {
  assert.equal(resolvePrStatus(pr(PrCheckpoint.Done)).status, PrStatus.Done);
});

test("rule 2: Deployed checkpoint resolves Deployed", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Deployed)).status,
    PrStatus.Deployed,
  );
});

test("rule 3: merged resolves Merged", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Drafting, { isMerged: true })).status,
    PrStatus.Merged,
  );
});

test("rule 4: changes-requested resolves Fixing", () => {
  assert.equal(
    resolvePrStatus(
      pr(PrCheckpoint.Drafting, { reviewDecision: "CHANGES_REQUESTED" }),
    ).status,
    PrStatus.Fixing,
  );
  assert.equal(
    resolvePrStatus(
      pr(PrCheckpoint.Drafting, { hasUnresolvedReviewComments: true }),
    ).status,
    PrStatus.Fixing,
  );
});

test("rule 5: Reviewable checkpoint resolves Reviewable", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Reviewable, { isDraft: false })).status,
    PrStatus.Reviewable,
  );
});

test("rule 6: Shipit checkpoint resolves Shipit with stage", () => {
  const r = resolvePrStatus(pr(PrCheckpoint.Shipit, { isDraft: true }, 3));
  assert.equal(r.status, PrStatus.Shipit);
  assert.equal(r.stage, 3);
});

test("rule 7: ShipitDone + draft resolves FinalizedDraft", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.ShipitDone, { isDraft: true })).status,
    PrStatus.FinalizedDraft,
  );
});

test("rule 8: not-draft resolves Finalizing", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Drafting, { isDraft: false })).status,
    PrStatus.Finalizing,
  );
});

test("rule 9: nothing known resolves Drafting", () => {
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Drafting)).status,
    PrStatus.Drafting,
  );
});

test("Fixing overrides Reviewable", () => {
  // Reviewable checkpoint but reviewers left changes-requested → Fixing.
  assert.equal(
    resolvePrStatus(
      pr(PrCheckpoint.Reviewable, { reviewDecision: "CHANGES_REQUESTED" }),
    ).status,
    PrStatus.Fixing,
  );
});

test("Done/Deployed win with github === undefined (5A regression)", () => {
  assert.equal(resolvePrStatus(pr(PrCheckpoint.Done)).status, PrStatus.Done);
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Deployed)).status,
    PrStatus.Deployed,
  );
});

test("reopened-after-Done stays Done (no live transition resurrects it)", () => {
  // GitHub now reports not-merged, open, draft — Done must still win.
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.Done, { isMerged: false, isDraft: true }))
      .status,
    PrStatus.Done,
  );
});

test("comments cleared on a ShipitDone PR → Finalizing, not Reviewable", () => {
  // No CHANGES_REQUESTED, not draft, checkpoint never manually set Reviewable.
  assert.equal(
    resolvePrStatus(pr(PrCheckpoint.ShipitDone, { isDraft: false })).status,
    PrStatus.Finalizing,
  );
});

test("statusOverride wins over checkpoint + github (rule 0)", () => {
  const p = pr(PrCheckpoint.Drafting, { isMerged: true });
  p.statusOverride = PrStatus.Fixing;
  assert.equal(resolvePrStatus(p).status, PrStatus.Fixing);
  // Even over a Done checkpoint.
  const p2 = pr(PrCheckpoint.Done);
  p2.statusOverride = PrStatus.Drafting;
  assert.equal(resolvePrStatus(p2).status, PrStatus.Drafting);
});

test("statusOverride to Shipit carries the stage", () => {
  const p = pr(PrCheckpoint.Drafting, undefined, 5);
  p.statusOverride = PrStatus.Shipit;
  const r = resolvePrStatus(p);
  assert.equal(r.status, PrStatus.Shipit);
  assert.equal(r.stage, 5);
});

test("isTerminalForPolling true only for Done/Deployed", () => {
  assert.equal(isTerminalForPolling(pr(PrCheckpoint.Done)), true);
  assert.equal(isTerminalForPolling(pr(PrCheckpoint.Deployed)), true);
  assert.equal(
    isTerminalForPolling(pr(PrCheckpoint.Drafting, { isMerged: true })),
    false,
  );
});
