"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  buildCheckinReviewAction,
  runCheckinAction,
  type CheckinRunResult,
} from "@/lib/actions";
import { useJobRun } from "@/components/jobs/use-job-run";
import { isTerminalJobStatus, type CheckinScope, type ResolvedCheckinIntent } from "@/lib/types";
import { CheckinReview } from "@/components/today/checkin-review";

/**
 * The full-width universal capture bar. Type a free-form check-in - what you
 * did, what changed, an idea, a vent - and Enter runs the interpret → resolve →
 * propose loop, then shows an inline review whose accepted moves commit as one
 * reversible PlanVersion (reusing the S1 review/commit/undo machinery). The state
 * machine: idle → interpreting → reviewing → (committed, inside the review). The
 * soft gradient orb + ↵ affordance match Direction F.
 *
 * Interpretation is the model call, so it runs on the queue and this polls for it. Stage C -
 * turning the grounded intents into priced proposals - is a second, fast round trip made HERE
 * rather than in the worker, so the odds beside each move are the odds of the plan as it stands
 * when the user reads them. See buildCheckinReviewAction.
 *
 * With a `scope`, the check-in binds to
 * that goal: its entities resolve first and an "I also need to…" clause becomes a
 * real task ON the goal (a live-re-solved `add_tasks` move) rather than a loose
 * capture. The global (unscoped) Today bar is unchanged.
 */

/** What interpretCheckinJob leaves on the job row. */
interface CheckinJobResult {
  resolved: ResolvedCheckinIntent[];
  rawReport: string;
  source: "llm" | "heuristic";
}

function readJobResult(result: Record<string, unknown> | null): CheckinJobResult | null {
  if (!result || !Array.isArray(result.resolved)) return null;
  return {
    resolved: result.resolved as ResolvedCheckinIntent[],
    rawReport: typeof result.rawReport === "string" ? result.rawReport : "",
    source: result.source === "llm" ? "llm" : "heuristic",
  };
}

export function CaptureBar({ scope }: { scope?: CheckinScope }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<CheckinRunResult | null>(null);
  const job = useJobRun();
  // Stage C, which is a plain await rather than a job - no model call, just the joint solver.
  const [building, startBuilding] = useTransition();
  const [buildError, setBuildError] = useState<string | null>(null);
  /** The job whose intents have already been priced, so a re-render can't price them twice. */
  const builtFor = useRef<string | null>(null);

  const runId = job.run?.id ?? null;
  const settled = job.run !== null && isTerminalJobStatus(job.run.status);

  useEffect(() => {
    if (!runId || !settled || builtFor.current === runId) return;
    const interpreted = readJobResult(job.result);
    if (!interpreted) return;
    builtFor.current = runId;
    startBuilding(async () => {
      try {
        setResult(
          await buildCheckinReviewAction(
            interpreted.resolved,
            interpreted.rawReport,
            interpreted.source,
            scope,
          ),
        );
      } catch (err) {
        console.error("could not build the check-in review:", err);
        setBuildError("Read your check-in, but couldn't work out what it changes. Try again.");
      }
    });
    // job.result and scope are read through the settled run this is keyed on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, settled]);

  const pending = job.pending || building;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text || pending) return;
    setBuildError(null);
    builtFor.current = null;
    job.start(() => runCheckinAction(text, scope));
  }

  function reset() {
    setResult(null);
    setValue("");
    setBuildError(null);
    builtFor.current = null;
  }

  // Reviewing - the interpreted proposals replace the input until the user is done.
  if (result) {
    return <CheckinReview result={result} onDone={reset} />;
  }

  // The typed text is deliberately still in the box: a check-in that failed to interpret is a
  // sentence the user wrote and should not have to write again.
  const error = buildError ?? (job.failed ? (job.error ?? "Couldn't read that check-in.") : null);

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 shadow-[var(--shadow-md)]"
    >
      <div className="flex items-center gap-3.5">
        <span
          className={`size-[30px] shrink-0 rounded-full bg-[image:var(--gradient-brand)] ${pending ? "animate-pulse" : ""}`}
          aria-hidden
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
          placeholder={
            pending
              ? "Reading your check-in…"
              : scope
                ? `Log an update on ${scope.goalName} — done, pushed, a new task…`
                : "Type anything — what you did, an update, an idea…"
          }
          aria-label={scope ? `Check in on ${scope.goalName}` : "Capture anything"}
          className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
        />
        <span className="rounded-[7px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-subtle)]">
          ↵
        </span>
      </div>
      {error && (
        <p role="status" className="pl-[44px] text-[12px] text-[var(--color-danger)]">
          {error} Press ↵ to try again.
        </p>
      )}
    </form>
  );
}
