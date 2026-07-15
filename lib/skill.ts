import type { SkillNode, SkillProgress } from "./types";

/**
 * Derive a learning goal's progress from its skill nodes. Pure - nothing is
 * stored, so it can't drift from the rows.
 *
 * The point of §5.3b is that two kinds of progress are NOT the same and we keep
 * them apart:
 *  - **effort** progress = attained minutes / total minutes (you put in the time);
 *  - **skill** progress = checkpoints met / total checkpoints (you can demonstrate
 *    a milestone). When a plan has no checkpoints we fall back to nodes attained,
 *    so skillPct is always defined.
 * They diverge exactly when you've ground out hours on prep without yet clearing a
 * milestone - which is the signal worth surfacing.
 *
 * `unlocked` is the actionable frontier: unattained nodes whose prerequisites are
 * all attained.
 */
export function skillProgress(nodes: SkillNode[]): SkillProgress {
  const total = nodes.length;
  const attainedNodes = nodes.filter((n) => n.attained);
  const attained = attainedNodes.length;

  const checkpoints = nodes.filter((n) => n.is_checkpoint);
  const checkpointsTotal = checkpoints.length;
  const checkpointsMet = checkpoints.filter((n) => n.attained).length;

  const effortMinutesTotal = nodes.reduce(
    (sum, n) => sum + n.estimated_minutes,
    0,
  );
  const effortMinutesDone = attainedNodes.reduce(
    (sum, n) => sum + n.estimated_minutes,
    0,
  );

  const effortPct =
    effortMinutesTotal > 0 ? effortMinutesDone / effortMinutesTotal : 0;
  // Skill progress is checkpoint-led; with no checkpoints, every node counts.
  const skillPct =
    checkpointsTotal > 0
      ? checkpointsMet / checkpointsTotal
      : total > 0
        ? attained / total
        : 0;

  const attainedIds = new Set(attainedNodes.map((n) => n.id));
  const unlocked = nodes
    .filter(
      (n) =>
        !n.attained && n.prerequisites.every((p) => attainedIds.has(p)),
    )
    .map((n) => n.id);

  return {
    total,
    attained,
    checkpointsTotal,
    checkpointsMet,
    effortMinutesDone,
    effortMinutesTotal,
    effortPct,
    skillPct,
    unlocked,
  };
}

/**
 * Order nodes for display: a stable topological sort (prerequisites before
 * dependents), breaking ties by `sort_index`. Falls back gracefully if the
 * stored graph somehow contains a cycle (leftover nodes are appended).
 */
export function topoSortSkills(nodes: SkillNode[]): SkillNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  const out: SkillNode[] = [];
  const bySort = [...nodes].sort((a, b) => a.sort_index - b.sort_index);

  let progressed = true;
  while (out.length < nodes.length && progressed) {
    progressed = false;
    for (const n of bySort) {
      if (placed.has(n.id)) continue;
      const ready = n.prerequisites.every((p) => !byId.has(p) || placed.has(p));
      if (ready) {
        out.push(n);
        placed.add(n.id);
        progressed = true;
      }
    }
  }
  // Append any nodes caught in a cycle so nothing is dropped.
  for (const n of bySort) if (!placed.has(n.id)) out.push(n);
  return out;
}
