import assert from "node:assert";
import { test } from "node:test";
import { buildRenderModel, RenderSessionInput } from "./render";
import { PrCheckpoint, PrStatus, SessionPr, SessionStatus } from "./types";

const live = { label: "idle", dot: "🟢", cold: false };
const coldLive = { label: "cold", dot: "❄️", cold: true };

function mkPr(
  checkpoint: PrCheckpoint,
  github?: Partial<SessionPr["github"]>,
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
          reviewDecision: null,
          lastFetched: 0,
          ...github,
        }
      : undefined,
    addedAt: 0,
  };
}

test("session with PRs hides the lifecycle dropdown", () => {
  const input: RenderSessionInput[] = [
    { id: "cc-1", name: "feat", live, prs: [mkPr(PrCheckpoint.Drafting)] },
  ];
  const m = buildRenderModel(input, 0, 1000);
  assert.equal(m.sessions[0].showSessionStatus, false);
  assert.equal(m.sessions[0].prs.length, 1);
});

test("zero-PR session shows the SessionStatus select with options", () => {
  const input: RenderSessionInput[] = [
    {
      id: "cc-2",
      name: "spike",
      live: coldLive,
      sessionStatus: SessionStatus.Designing,
      prs: [],
    },
  ];
  const m = buildRenderModel(input, 0, 1000);
  assert.equal(m.sessions[0].showSessionStatus, true);
  assert.equal(m.sessions[0].sessionStatus, SessionStatus.Designing);
  assert.ok(m.sessionStatusOptions.includes(SessionStatus.Implemented));
  assert.equal(m.sessions[0].live.cold, true);
});

test("action affordances per resolved status", () => {
  const finalizing = buildRenderModel(
    [
      {
        id: "a",
        name: "a",
        live,
        prs: [mkPr(PrCheckpoint.Drafting, { isDraft: false })],
      },
    ],
    0,
    1000,
  ).sessions[0].prs[0];
  assert.equal(finalizing.status, PrStatus.Finalizing);
  assert.equal(finalizing.canReviewable, true);
  assert.equal(finalizing.canDeployed, false);

  const merged = buildRenderModel(
    [
      {
        id: "b",
        name: "b",
        live,
        prs: [mkPr(PrCheckpoint.Drafting, { isMerged: true })],
      },
    ],
    0,
    1000,
  ).sessions[0].prs[0];
  assert.equal(merged.status, PrStatus.Merged);
  assert.equal(merged.canDeployed, true);
  assert.equal(merged.canDone, true);

  const deployed = buildRenderModel(
    [
      {
        id: "c",
        name: "c",
        live,
        prs: [mkPr(PrCheckpoint.Deployed, { isMerged: true })],
      },
    ],
    0,
    1000,
  ).sessions[0].prs[0];
  assert.equal(deployed.canDone, true);
  assert.equal(deployed.canDeployed, false);
});

test("statusOverride pins status, flags overridden, and suppresses workflow buttons", () => {
  // Underlying github says merged (would be canDeployed/canDone), but override
  // pins drafting → overridden, no workflow buttons.
  const pr = { ...mkPr(PrCheckpoint.Drafting, { isMerged: true }) };
  pr.statusOverride = PrStatus.Drafting;
  const m = buildRenderModel(
    [{ id: "a", name: "a", live, prs: [pr] }],
    0,
    1000,
  );
  const row = m.sessions[0].prs[0];
  assert.equal(row.status, PrStatus.Drafting);
  assert.equal(row.overridden, true);
  assert.equal(row.canDeployed, false);
  assert.equal(row.canDone, false);
  assert.ok(m.statusOptions.includes(PrStatus.Merged));
});

test("non-overridden row reports overridden=false", () => {
  const m = buildRenderModel(
    [{ id: "a", name: "a", live, prs: [mkPr(PrCheckpoint.Drafting)] }],
    0,
    1000,
  );
  assert.equal(m.sessions[0].prs[0].overridden, false);
});

test("reviewer passes through to the row", () => {
  const pr = {
    ...mkPr(PrCheckpoint.Reviewable, { isDraft: false }),
    reviewer: "alice",
  };
  const row = buildRenderModel(
    [{ id: "a", name: "a", live, prs: [pr] }],
    0,
    1000,
  ).sessions[0].prs[0];
  assert.equal(row.status, PrStatus.Reviewable);
  assert.equal(row.reviewer, "alice");
});

test("shipit badge renders the stage", () => {
  const row = buildRenderModel(
    [
      {
        id: "a",
        name: "a",
        live,
        prs: [mkPr(PrCheckpoint.Shipit, { isDraft: true }, 3)],
      },
    ],
    0,
    1000,
  ).sessions[0].prs[0];
  assert.equal(row.status, PrStatus.Shipit);
  assert.equal(row.badge, "shipit · 3");
});

test("staleness dims when lastFetched older than staleAfterMs", () => {
  const now = 10_000;
  const fresh = buildRenderModel(
    [
      {
        id: "a",
        name: "a",
        live,
        prs: [mkPr(PrCheckpoint.Drafting, { lastFetched: now })],
      },
    ],
    now,
    1000,
  ).sessions[0].prs[0];
  assert.equal(fresh.stale, false);

  const stale = buildRenderModel(
    [
      {
        id: "a",
        name: "a",
        live,
        prs: [mkPr(PrCheckpoint.Drafting, { lastFetched: 0 })],
      },
    ],
    now,
    1000,
  ).sessions[0].prs[0];
  assert.equal(stale.stale, true);
});
