"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pollJobRunAction } from "@/lib/actions";
import {
  JOB_STALE_MS,
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
 * exists to catch, and it takes the bill from ~$10/mo to ~$50/mo.
 *
 * So the loop has FOUR independent stops, because each one covers a case the
 * others do not:
 *
 *   1. a terminal status          - the normal ending;
 *   2. the abandonment window     - the worker died without settling the row;
 *   3. a wall-clock deadline      - nothing is coming back at all;
 *   4. consecutive poll failures  - the POLL is broken rather than the job.
 *
 * (3) and (4) are not redundant with (2). A poll that keeps REJECTING - an
 * expired session, a 500, a redeploy that invalidated the action id, a closed
 * laptop lid - never updates state, so nothing re-renders, so an abandonment
 * check that only runs on a successful response would never be reached and the
 * loop would spin for as long as the tab is open.
 */

/** Poll cadence: tight while a fast job might still land, slack afterwards. */
const FAST_INTERVAL_MS = 2_000;
const SLOW_INTERVAL_MS = 8_000;
const FAST_WINDOW_MS = 30_000;
/** Consecutive rejected polls before we stop believing the poll itself. */
const MAX_POLL_FAILURES = 5;

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

/** The run a just-returned handle describes, before any poll has happened. */
function runFromHandle(handle: JobHandle): JobRun {
  const now = new Date().toISOString();
  return {
    id: handle.jobId,
    type: "",
    subjectId: null,
    status: handle.status,
    // The inline path finishes the work before returning, so its outcome is on
    // the handle and no poll will ever fetch it - a terminal run is never
    // polled. Dropping these here is how an inline failure loses its message.
    result: handle.result,
    error: handle.error,
    createdAt: now,
    updatedAt: now,
  };
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
  // The enqueue round trip itself. On the inline path (no bus) it IS the job,
  // all 43 seconds of it, so leaving it out would show an idle, clickable
  // button for the entire run.
  const [enqueueing, startTransition] = useTransition();
  /** Set when we stop watching for a reason the row itself cannot express. */
  const [gaveUp, setGaveUp] = useState<string | null>(null);

  // Adopt a job the SERVER reports, but only when it is really reporting one.
  //
  // Deliberately not symmetric: `activeJobRun` returns null the moment a job
  // settles, and this hook calls `router.refresh()` exactly then - so treating
  // "server says null" as authoritative would wipe the finished run, along with
  // the result the card was about to render and the error message explaining
  // why it failed, on every single completion.
  // State rather than a ref, because this runs DURING render: React's own
  // "adjust state when a prop changes" pattern. A ref read here is both a lint
  // error and a real hazard, since a ref mutation schedules no re-render.
  const [adopted, setAdopted] = useState(initial?.id ?? null);
  if (initial && initial.id !== adopted) {
    setAdopted(initial.id);
    setRun(initial);
    setGaveUp(null);
  }

  const start = useCallback(
    (action: () => Promise<JobHandle>) => {
      setGaveUp(null);
      startTransition(async () => {
        let handle: JobHandle;
        try {
          handle = await action();
        } catch (err) {
          // The enqueue itself failed - before any job row exists to record it.
          // Without this the rejection escapes the transition and the button
          // simply goes idle again, having apparently done nothing.
          console.error("could not start job:", err);
          setGaveUp(
            err instanceof Error ? err.message : "Could not start that job.",
          );
          return;
        }
        setRun(runFromHandle(handle));
        // The inline path already did the work and revalidated server-side
        // before returning; all that is left is to re-render with the result.
        if (handle.ranInline) router.refresh();
      });
    },
    [router],
  );

  const id = run?.id ?? null;
  const settled = run ? isTerminalJobStatus(run.status) : true;

  useEffect(() => {
    if (!id || settled || gaveUp) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let lastPollAt = 0;
    const startedAt = Date.now();

    function stop(reason: string) {
      if (!cancelled) setGaveUp(reason);
    }

    async function tick() {
      if (cancelled) return;
      // Paused, not stopped: the visibilitychange listener resumes the loop the
      // moment the tab is looked at again, so a job that lands in a background
      // tab is picked up on return rather than missed.
      if (typeof document !== "undefined" && document.hidden) return;

      // Stop (3): nothing has come back inside the window the queue itself
      // needs to exhaust every attempt. Checked before the request so it also
      // ends a loop whose every poll has been failing.
      if (Date.now() - startedAt > JOB_STALE_MS) {
        stop("That took longer than expected and stopped reporting back. Try again.");
        return;
      }

      lastPollAt = Date.now();
      let next: JobRun | null = null;
      try {
        next = await pollJobRunAction(id!);
      } catch {
        // A dropped poll is not a failed job - the network blipped, or the web
        // Lambda cold-started. But a poll that keeps failing is its own fault
        // and must not spin: nothing it does changes state, so nothing else
        // here would ever notice.
        if (++failures >= MAX_POLL_FAILURES) {
          stop("Lost track of this job. Reload the page to check on it.");
          return;
        }
        schedule();
        return;
      }
      if (cancelled) return;
      failures = 0;

      if (!next) {
        // The row is gone (pruned, or its user deleted). Nothing left to watch.
        setRun(null);
        return;
      }
      setRun(next);
      if (isTerminalJobStatus(next.status)) {
        // The worker wrote to the database from a process with no render pass,
        // so this is the moment the page can actually show what it did. A
        // failed job gets the same refresh: it may have committed some of its
        // writes before it died, and the page should show what is really there.
        router.refresh();
        return;
      }
      if (isJobAbandoned(next)) return; // stop (2); `failed` below reports it
      schedule();
    }

    function schedule() {
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), intervalFor(startedAt));
    }

    function onVisible() {
      if (document.hidden || cancelled) return;
      // Poll on return to the tab, but never faster than the cadence - a window
      // being focused repeatedly must not become a burst of requests.
      const due = Math.max(0, intervalFor(startedAt) - (Date.now() - lastPollAt));
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), due);
    }

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, settled, gaveUp, router]);

  // Abandonment is read here rather than held in state so it becomes true on
  // its own once the loop has stopped, without scheduling another render.
  const abandoned = run !== null && !settled && isJobAbandoned(run);
  const failed = run?.status === "failed" || abandoned || gaveUp !== null;

  return {
    run,
    pending: enqueueing || (run !== null && !settled && !abandoned && !gaveUp),
    failed,
    error:
      gaveUp ??
      (abandoned
        ? "That took longer than expected and stopped reporting back. Try again."
        : (run?.error ?? null)),
    result: run?.result ?? null,
    start,
  };
}
