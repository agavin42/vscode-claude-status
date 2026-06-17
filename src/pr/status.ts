// resolvePrStatus — the single chokepoint that maps a PR's stored checkpoint
// plus live GitHub facts to the status shown in the UI. Everything downstream
// (rendering, sorting, badge color) reads the resolved value, never the raw
// checkpoint.

import { GithubFacts, PrCheckpoint, PrStatus, SessionPr } from "./types";

export interface ResolvedPrStatus {
  status: PrStatus;
  stage?: number; // set only when status === Shipit
}

// Resolution order (first match wins). pr.github may be undefined (no fetch
// yet, or sidecar/cache loss), so every rule that reads it guards for that.
//
// Rules 1–2 (manual terminal checkpoints Done/Deployed) rank FIRST and do not
// depend on a live fact: a cache loss that nulls `github` must not drop a
// manually-Deployed PR through to Drafting. The consequence is intentional —
// no live GitHub transition resurrects a Done or Deployed PR.
export function resolvePrStatus(pr: SessionPr): ResolvedPrStatus {
  const g: GithubFacts | undefined = pr.github;

  // Rule 0: a manual status override wins over everything — the user pinned
  // this PR's displayed status. Stage carries only when overriding to Shipit.
  if (pr.statusOverride) {
    return {
      status: pr.statusOverride,
      stage: pr.statusOverride === PrStatus.Shipit ? pr.shipitStage : undefined,
    };
  }

  if (pr.checkpoint === PrCheckpoint.Done) {
    return { status: PrStatus.Done };
  }
  if (pr.checkpoint === PrCheckpoint.Deployed) {
    return { status: PrStatus.Deployed };
  }
  if (g?.isMerged) {
    return { status: PrStatus.Merged };
  }
  if (
    g?.hasUnresolvedReviewComments ||
    g?.reviewDecision === "CHANGES_REQUESTED"
  ) {
    return { status: PrStatus.Fixing };
  }
  if (pr.checkpoint === PrCheckpoint.Reviewable) {
    return { status: PrStatus.Reviewable };
  }
  if (pr.checkpoint === PrCheckpoint.Shipit) {
    return { status: PrStatus.Shipit, stage: pr.shipitStage };
  }
  // ShipitDone + still-draft (or draft-state unknown) → finalized draft.
  if (pr.checkpoint === PrCheckpoint.ShipitDone && g?.isDraft !== false) {
    return { status: PrStatus.FinalizedDraft };
  }
  if (g && g.isDraft === false) {
    return { status: PrStatus.Finalizing };
  }
  return { status: PrStatus.Drafting };
}

// Whether a PR is "terminal" for polling purposes — the poller skips these to
// bound cost. A merged PR is only terminal once the user has settled it
// (Deployed/Done); an open merged PR still polls so the merge is observed.
export function isTerminalForPolling(pr: SessionPr): boolean {
  return (
    pr.checkpoint === PrCheckpoint.Done ||
    pr.checkpoint === PrCheckpoint.Deployed
  );
}
