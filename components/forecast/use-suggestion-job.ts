"use client";

import { useEffect, useRef, useState } from "react";
import { useJobRun } from "@/components/jobs/use-job-run";
import { isTerminalJobStatus, type JobHandle } from "@/lib/types";

/**
 * The three strategist cards, which are the same card three times.
 *
 * Each fires one read-only proposal job on mount, waits, and either renders a suggestion or
 * disappears. That was three copies of a promise-and-phase dance while the actions still
 * awaited the model; now that they enqueue, it would have been three copies of a poll, and the
 * mount-once guard is exactly the sort of thing that gets right in two files out of three.
 *
 * A failed job renders as `empty`, deliberately. These sit UNDER the deterministic recovery
 * moves, which have already rendered and are the part the user can always act on. The
 * strategist not finding anything and the strategist falling over look the same from here, and
 * neither is worth an error the user cannot do anything with.
 */
export type SuggestionPhase = "loading" | "ready" | "empty";

export function useSuggestionJob<T>(
  /** False when this project's signals don't warrant the call at all - no job is started. */
  enabled: boolean,
  action: () => Promise<JobHandle>,
  /** A suggestion the card would render as nothing is `empty`, not `ready`. */
  isUseful: (suggestion: T) => boolean,
): { phase: SuggestionPhase; suggestion: T | null } {
  const job = useJobRun();
  const { start } = job;

  // Read only inside the effect, so a ref is the right shape here: it guards a fire-once and
  // nothing renders from it.
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    start(action);
    // Fire-once. `action` closes over props and so is a new function every render; depending on
    // it would enqueue the strategist again on every one of them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, start]);

  // Whether a run has EVER been seen, adjusted during render (React's adjust-state-on-change
  // pattern, as useJobRun does with `adopted`) rather than from an effect. It has to be
  // readable while rendering, which rules out a ref: mutating one schedules no re-render, so
  // the phase below would go stale.
  const [seenRun, setSeenRun] = useState(false);
  if (job.run !== null && !seenRun) setSeenRun(true);

  // The job row is the only thing that knows whether the strategist found anything, so the
  // suggestion is read back off it rather than held in state beside it.
  const suggestion = (job.result?.suggestion ?? null) as T | null;
  const settled = job.run !== null && isTerminalJobStatus(job.run.status);
  // The row was pruned or its owner deleted mid-poll: nothing is coming, and nothing is wrong.
  const vanished = seenRun && job.run === null;

  if (!enabled || job.failed || vanished) return { phase: "empty", suggestion: null };
  if (!settled) return { phase: "loading", suggestion: null };
  return suggestion && isUseful(suggestion)
    ? { phase: "ready", suggestion }
    : { phase: "empty", suggestion: null };
}
