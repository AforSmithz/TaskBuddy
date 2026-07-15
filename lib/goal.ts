// Pure reads over a goal's definition-of-done. No I/O - easy to unit-test.

import {
  COMPLETION_CONFIDENCE_RANK,
  type CompletionConfidence,
  type GoalCompletion,
  type GoalCriterion,
} from "./types";

/**
 * Derive a goal's completion from its definition-of-done criteria. A goal is
 * `complete` when it has criteria and every one is met; `verified` when every met
 * criterion was checked at `verified` confidence; `confidence` is the *weakest*
 * confidence across met criteria (a met criterion with no recorded confidence is
 * treated as the weakest, `inferred`). This stays derived - nothing is stored,
 * so it can never drift out of sync with the criteria rows.
 */
export function goalCompletion(criteria: GoalCriterion[]): GoalCompletion {
  const total = criteria.length;
  const met = criteria.filter((c) => c.met);
  const metCount = met.length;
  const complete = total > 0 && metCount === total;

  let confidence: CompletionConfidence | null = null;
  for (const c of met) {
    const conf = c.met_confidence ?? "inferred";
    if (
      confidence === null ||
      COMPLETION_CONFIDENCE_RANK[conf] < COMPLETION_CONFIDENCE_RANK[confidence]
    ) {
      confidence = conf;
    }
  }

  const verified = complete && met.every((c) => c.met_confidence === "verified");
  return { complete, verified, confidence, metCount, total };
}
