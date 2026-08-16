"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pollJobRunAction } from "@/lib/actions";
import {
  isJobAbandoned,
  isTerminalJobStatus,
  type JobHandle,
  type JobRun,
} from "@/lib/types";

/**
 * Watch one queue-backed job and tell the page when it lands.
 *
 * The three slow LLM actions publish an event and return, so the component that
 * started the work no longer receives its result. This hook is the other half:
 * it polls the job row until the job settles, then refreshes the route so the
 * server re-renders with whatever the worker wrote.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POLL IS SO CAREFULLY BOUNDED
 * ---------------------------------------------------------------------------
 * Each tick is a Lambda invocation and a database round trip. A tab left open
 * on a finished page would otherwise poll ~43,000 times a day, and - far worse
 * than the invocations - it would keep touching Aurora forever. The cluster's
 * whole cost model is scale-to-zero after 15 idle minutes; a background poll
 * that never stops is the exact failure the `taskbuddy-db-not-pausing` alarm
 * exists to catch, and it takes the bill from ~$10/mo to ~$50/mo. So the loop
 * stops on a terminal status, stops when the job is abandoned, backs off, and
 * pauses entirely while the tab is hidden.
 */

/** Poll cadence: tight while a fast job might still land, slack afterwards. */
const FAST_INTERVAL_MS = 2_000;
const SLOW_INTERVAL_MS = 8_000;
const FAST_WINDOW_MS = 30_000;

function intervalFor(startedAt: number): number {
  return Date.now() - startedAt < FAST_WINDOW_MS
    ? FAST_INTERVAL_MS
    : SLOW_INTERVAL_MS;
}

export interface JobWatch {
  /** The job being watched, or null when there has never been one. */
  run: JobRun | null;
  /** True while the work is still expected to land. Drives every spinner. */
  pending: boolean;
  /** Terminal failure, or a job that stopped reporting. Drives the retry copy. */
  failed: boolean;
  /** The failure message worth showing the user, or null. */
  error: string | null;
  /** Whatever the job returned, e.g. `{ created: 4 }` from the link proposer. */
  result: Record<string, unknown> | null;
  /** Fire the action that enqueues the job, and start watching what it returns. */
  start: (action: () => Promise<JobHandle>) => void;
}

/**
 * @param initial the live run the server found for this subject, or null.
 *   Already filtered by `activeJobRun`, so a value here means "genuinely still
 *   in flight" - which is what lets a page reload keep showing the pending
 *   state instead of an idle button beside work that is still running.
 */
export function useJobRun(initial: JobRun | null = null): JobWatch {
  const router = useRouter();
  const [run, setRun] = useState<JobRun | null>(initial);
  const [, startTransition] = useTransition();

  // The server is the authority whenever it re-renders us with a different job:
  // a refresh that reveals a finished run must not be overwritten by our stale
  // local copy, and vice versa.
  const initialId = initial?.id ?? null;
  const seenId = useRef(initialId);
  if (initialId !== seenId.current) {
    seenId.current = initialId;
    setRun(initial);
  }

  const start = useCallback(
    (action: () => Promise<JobHandle>) => {
      startTransition(async () => {
        const handle = await action();
        const now = new Date().toISOString();
        setRun({
          id: handle.jobId,
          type: "",
          subjectId: null,
          status: handle.status,
          result: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        // The inline path already finished the work and revalidated server-side
        // before returning; all that is left is to re-render with the result.
        if (handle.ranInline && handle.status === "succeeded") router.refresh();
      });
    },
    [router],
  );

  const id = run?.id ?? null;
  const settled = run ? isTerminalJobStatus(run.status) : true;

  useEffect(() => {
    if (!id || settled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    async function tick() {
      if (cancelled) return;
      // Paused, not stopped: the visibilitychange listener resumes the loop the
      // moment the tab is looked at again, so a job that lands in a background
      // tab is picked up on return rather than missed.
      if (typeof document !== "undefined" && document.hidden) return;

      let next: JobRun | null = null;
      try {
        next = await pollJobRunAction(id!);
      } catch {
        // A dropped poll is not a failed job - the network blipped, or the web
        // Lambda cold-started. Try again on the next tick; the abandonment
        // window is what eventually calls it.
        schedule();
        return;
      }
      if (cancelled) return;

      if (!next) {
        // The row is gone (pruned, or its user deleted). Nothing left to watch.
        setRun(null);
        return;
      }
      setRun(next);
      if (isTerminalJobStatus(next.status)) {
        // The worker wrote to the database from a process with no render pass,
        // so this is the moment the page can actually show what it did.
        if (next.status === "succeeded") router.refresh();
        return;
      }
      if (isJobAbandoned(next)) return; // stop; `failed` below reports it
      schedule();
    }

    function schedule() {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), intervalFor(startedAt));
    }

    function onVisible() {
      if (!document.hidden && !cancelled) {
        clearTimeout(timer);
        void tick();
      }
    }

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, settled, router]);

  // Abandonment is read here rather than in state so it becomes true on its own
  // once the loop has stopped, without another render being scheduled for it.
  const abandoned = run !== null && !settled && isJobAbandoned(run);
  const failed = run?.status === "failed" || abandoned;

  return {
    run,
    pending: run !== null && !settled && !abandoned,
    failed,
    error: abandoned
      ? "That took longer than expected and stopped reporting back. Try again."
      : (run?.error ?? null),
    result: run?.result ?? null,
    start,
  };
}
