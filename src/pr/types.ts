// PR + session-lifecycle types for the Sessions & PRs dashboard.
//
// This module is deliberately vscode-free so the pure logic that consumes
// these types (resolvePrStatus, github-facts mapping, detection parsing,
// render-model building) can be unit-tested with node:test without the
// extension host.

// PR lifecycle checkpoint the extension/skills advance explicitly. This is
// NOT the displayed status — the displayed status is resolved by combining
// this checkpoint with live GitHub facts (see resolvePrStatus).
export enum PrCheckpoint {
  Drafting = "drafting", // initial: tied, shipit not yet run
  Shipit = "shipit", // shipit skill running; see shipitStage
  ShipitDone = "shipit-done", // shipit completed (draft vs ready is a gh fact)
  Reviewable = "reviewable", // manual: reviewers asked, waiting on them
  Deployed = "deployed", // manual: merged + in prod, post-merge work
  Done = "done", // manual: terminal
}

// The status shown in the UI — the resolved value. A superset of checkpoints
// plus the gh-derived states. resolvePrStatus() is the single chokepoint that
// maps (checkpoint, GitHub facts) → this.
export enum PrStatus {
  Drafting = "drafting",
  Shipit = "shipit", // rendered "shipit · N"
  FinalizedDraft = "finalized-draft", // shipit done AND still draft
  Finalizing = "finalizing", // not draft, reviewers not yet asked
  Reviewable = "reviewable",
  Fixing = "fixing", // review has comments / CHANGES_REQUESTED
  Merged = "merged",
  Deployed = "deployed",
  Done = "done",
}

// Session lifecycle phase — manual, surfaced only when a session owns no PRs.
export enum SessionStatus {
  Simple = "simple",
  Tool = "tool",
  Researching = "researching",
  Designing = "designing",
  Planning = "planning",
  Implementing = "implementing",
  Implemented = "implemented",
}

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

// Snapshot of live GitHub state from the last `gh pr view`. Undefined on a
// SessionPr until the first successful poll, or after a cache loss — every
// resolvePrStatus rule that reads it guards for that.
export interface GithubFacts {
  isDraft: boolean;
  isMerged: boolean;
  reviewDecision?: ReviewDecision;
  hasUnresolvedReviewComments: boolean;
  title?: string;
  lastFetched: number; // epoch ms; stale-marks the row when old
}

// A PR tied to the session that created it (or added manually).
export interface SessionPr {
  url: string; // canonical https://github.com/<owner>/<repo>/pull/<n>
  repo: string; // "owner/repo"
  number: number;
  sessionId: string; // owning ccId
  origin: "auto" | "manual";
  checkpoint: PrCheckpoint;
  shipitStage?: number; // only meaningful when checkpoint === Shipit
  reviewer?: string; // who was asked to review (set when going Reviewable)
  // Manual hard override of the displayed status. When set, it wins over the
  // checkpoint + GitHub resolution entirely (see resolvePrStatus). Cleared to
  // return the PR to automatic resolution.
  statusOverride?: PrStatus;
  github?: GithubFacts; // last poll snapshot; undefined until first fetch
  addedAt: number;
}
