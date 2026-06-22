// Mapping from `gh pr view --json …` output to GithubFacts. Pure + defensive
// (tolerates missing/extra fields) so it's unit-testable with a fake payload.
//
// Valid `gh pr view` JSON fields (gh 2.93) include: state, isDraft,
// reviewDecision, latestReviews, mergedAt, title, url, number. NOTE there is
// no `reviewThreads` field on `gh pr view` — review feedback is derived from
// reviewDecision + latestReviews instead.

import { GithubFacts, ReviewDecision } from "./types";

export const GH_PR_VIEW_FIELDS = [
  "state",
  "isDraft",
  "reviewDecision",
  "latestReviews",
  "mergedAt",
  "title",
  "url",
  "number",
] as const;

interface LatestReview {
  state?: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
}

function coerceReviewDecision(v: unknown): ReviewDecision {
  if (
    v === "APPROVED" ||
    v === "CHANGES_REQUESTED" ||
    v === "REVIEW_REQUIRED"
  ) {
    return v;
  }
  return null;
}

export function mapGhJsonToFacts(
  json: Record<string, unknown>,
  now: number,
): GithubFacts {
  const reviewDecision = coerceReviewDecision(json.reviewDecision);

  const latest = Array.isArray(json.latestReviews)
    ? (json.latestReviews as LatestReview[])
    : [];
  // "Review has comments" = a reviewer asked for changes. CHANGES_REQUESTED
  // clears when they re-approve or the review is dismissed, so it doesn't pin
  // Fixing forever (unlike COMMENTED, which GitHub never auto-clears).
  const hasUnresolvedReviewComments =
    reviewDecision === "CHANGES_REQUESTED" ||
    latest.some((r) => r.state === "CHANGES_REQUESTED");

  const isMerged =
    json.state === "MERGED" ||
    (typeof json.mergedAt === "string" && json.mergedAt.length > 0);

  return {
    isDraft: json.isDraft === true,
    isMerged,
    reviewDecision,
    hasUnresolvedReviewComments,
    title: typeof json.title === "string" ? json.title : undefined,
    lastFetched: now,
  };
}
