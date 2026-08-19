import type { FactorScores, PriorityLabel } from "@/lib/types";

// Deterministic priority engine.
// The LLM (or heuristic extractor) supplies 1-5 factor ratings; this module
// turns them into a transparent, reproducible score and label.

export const PRIORITY_WEIGHTS = {
  urgency: 0.3,
  impact: 0.25,
  dependency: 0.2,
  risk: 0.15,
  confidence: 0.1,
  effort: -0.1, // effort is subtracted: harder tasks are slightly penalised
} as const;

function clampFactor(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export interface PriorityResult {
  score: number; // 0.00 - 5.00, 2 decimals
  label: PriorityLabel;
}

/** Weighted priority score from the six 1-5 factor ratings. */
export function computePriority(factors: FactorScores): PriorityResult {
  const f = {
    urgency: clampFactor(factors.urgency),
    impact: clampFactor(factors.impact),
    dependency: clampFactor(factors.dependency),
    risk: clampFactor(factors.risk),
    confidence: clampFactor(factors.confidence),
    effort: clampFactor(factors.effort),
  };

  const raw =
    f.urgency * PRIORITY_WEIGHTS.urgency +
    f.impact * PRIORITY_WEIGHTS.impact +
    f.dependency * PRIORITY_WEIGHTS.dependency +
    f.risk * PRIORITY_WEIGHTS.risk +
    f.confidence * PRIORITY_WEIGHTS.confidence +
    f.effort * PRIORITY_WEIGHTS.effort;

  const score = Math.round(Math.max(0, raw) * 100) / 100;
  return { score, label: labelFor(score) };
}

/** Map a numeric score to its priority label band. */
export function labelFor(score: number): PriorityLabel {
  if (score >= 4.25) return "Critical";
  if (score >= 3.5) return "High";
  if (score >= 2.5) return "Medium";
  if (score >= 1.5) return "Low";
  return "Backlog";
}

/** Order used when sorting tasks by priority, highest first. */
export const PRIORITY_RANK: Record<PriorityLabel, number> = {
  Critical: 5,
  High: 4,
  Medium: 3,
  Low: 2,
  Backlog: 1,
};
