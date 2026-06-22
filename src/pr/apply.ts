// Pure helper for applying a batch of freshly-polled GitHub facts onto the
// PR map. Extracted from SessionStore so the race-guard (re-look-up each PR by
// (ccId, url); skip if detached mid-poll) is unit-testable without the
// extension host.

import { extractPrUrls } from "./detect";
import { GithubFacts, PrCheckpoint, SessionPr } from "./types";

export interface GithubFactsUpdate {
  ccId: string;
  url: string;
  facts: GithubFacts;
}

// Mutates `prs` in place. Returns true if any record was updated. An update
// whose (ccId, url) no longer resolves (the PR was detached or its session
// deleted between poll dispatch and completion) is dropped, never resurrected.
export function applyGithubFactsToMap(
  prs: Map<string, SessionPr[]>,
  updates: GithubFactsUpdate[],
): boolean {
  let changed = false;
  for (const u of updates) {
    const pr = prs.get(u.ccId)?.find((p) => p.url === u.url);
    if (!pr) continue;
    pr.github = u.facts;
    changed = true;
  }
  return changed;
}

// Set a PR's checkpoint (+ optional shipit stage), tolerantly creating the
// record if it isn't tied yet — shipit may report a stage before the
// create-hook detection lands, and the stage shouldn't be lost. Mutates `prs`
// in place. Returns the record, or undefined if the url can't be canonicalized
// into a new record. `now` is injected so the helper stays pure.
export function upsertPrCheckpoint(
  prs: Map<string, SessionPr[]>,
  ccId: string,
  url: string,
  checkpoint: PrCheckpoint,
  stage: number | undefined,
  now: number,
): SessionPr | undefined {
  const canonical = extractPrUrls(url)[0];
  const key = canonical?.url ?? url;
  const list = prs.get(ccId) ?? [];
  let pr = list.find((p) => p.url === key);
  if (!pr) {
    if (!canonical) return undefined;
    pr = {
      url: canonical.url,
      repo: canonical.repo,
      number: canonical.number,
      sessionId: ccId,
      origin: "auto",
      checkpoint,
      addedAt: now,
    };
    list.push(pr);
    prs.set(ccId, list);
  }
  pr.checkpoint = checkpoint;
  pr.shipitStage = checkpoint === PrCheckpoint.Shipit ? stage : undefined;
  return pr;
}
