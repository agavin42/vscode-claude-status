// Pure render-model builder: turns plain session+PR data into the row model
// the dashboard webview renders. vscode-free and side-effect-free so it's
// unit-testable; extension.ts maps its Session objects into RenderSessionInput
// and hands the result to the webview as JSON.

import { resolvePrStatus } from "./status";
import { PrStatus, SessionPr, SessionStatus } from "./types";

// Live-session presentation, computed by extension.ts (it owns ClaudeState /
// STATE_CONFIG and the cold case). We keep it as plain strings here so this
// module stays vscode-free.
export interface LiveStateView {
  label: string; // e.g. "BUSY", "idle", "cold"
  dot: string; // emoji/marker, e.g. "🟡", "🟢", "❄️"
  cold: boolean;
}

export interface RenderSessionInput {
  id: string;
  name: string;
  live: LiveStateView;
  sessionStatus?: SessionStatus;
  prs: SessionPr[];
}

export interface RenderPrRow {
  url: string;
  repo: string;
  number: number;
  title?: string;
  status: PrStatus;
  stage?: number;
  badge: string; // status label for display ("shipit · 3", "merged", …)
  reviewer?: string; // who was asked (shown on reviewable/fixing rows)
  overridden: boolean; // true when statusOverride is pinning the status
  stale: boolean;
  canReviewable: boolean;
  canDeployed: boolean;
  canDone: boolean;
}

export interface RenderSessionRow {
  id: string;
  name: string;
  live: LiveStateView;
  // Only present when the session owns zero PRs (manual lifecycle dropdown).
  sessionStatus?: SessionStatus;
  showSessionStatus: boolean;
  prs: RenderPrRow[];
}

export interface RenderModel {
  sessions: RenderSessionRow[];
  sessionStatusOptions: SessionStatus[];
  statusOptions: PrStatus[]; // for the per-PR status-override picker
}

function badgeFor(status: PrStatus, stage?: number): string {
  if (status === PrStatus.Shipit) {
    return stage !== undefined ? `shipit · ${stage}` : "shipit";
  }
  return status.replace("-", " ");
}

function buildPrRow(
  pr: SessionPr,
  now: number,
  staleAfterMs: number,
): RenderPrRow {
  const { status, stage } = resolvePrStatus(pr);
  const stale =
    pr.github !== undefined && now - pr.github.lastFetched > staleAfterMs;
  const overridden = pr.statusOverride !== undefined;
  return {
    url: pr.url,
    repo: pr.repo,
    number: pr.number,
    title: pr.github?.title,
    status,
    stage,
    badge: badgeFor(status, stage),
    reviewer: pr.reviewer,
    overridden,
    stale,
    // Action affordances driven by the resolved status. Suppressed under an
    // override — the status is manually pinned, so workflow advances (which
    // act on the checkpoint) would be masked and confusing.
    canReviewable: !overridden && status === PrStatus.Finalizing,
    canDeployed: !overridden && status === PrStatus.Merged,
    canDone:
      !overridden &&
      (status === PrStatus.Merged || status === PrStatus.Deployed),
  };
}

export function buildRenderModel(
  sessions: RenderSessionInput[],
  now: number,
  staleAfterMs: number,
): RenderModel {
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      live: s.live,
      sessionStatus: s.sessionStatus,
      showSessionStatus: s.prs.length === 0,
      prs: s.prs.map((pr) => buildPrRow(pr, now, staleAfterMs)),
    })),
    sessionStatusOptions: Object.values(SessionStatus),
    statusOptions: Object.values(PrStatus),
  };
}
