"use client";

import { AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryExtractionAction } from "@/lib/actions";
import { useJobRun } from "@/components/jobs/use-job-run";
import { Card, CardBody } from "@/components/ui/card";
import type { JobRun } from "@/lib/types";

/**
 * What the review page shows while the extraction job is still working, or after it failed.
 *
 * The entry row exists from the moment the user submits, so this stands in for the tasks rather
 * than for the whole page: the raw input is already saved, and a failure here costs a retry, not
 * the notes. useJobRun refreshes the route when the job lands, which is what swaps this card out
 * for the real review.
 */
export function ExtractionStatus({
  entryId,
  job: initial,
}: {
  entryId: string;
  /** The newest extraction run for this entry, whatever state it is in. */
  job: JobRun | null;
}) {
  const job = useJobRun(initial);

  function retry() {
    if (job.pending) return;
    job.start(() => retryExtractionAction(entryId));
  }

  if (job.pending) {
    return (
      <Card className="mt-5">
        <CardBody className="flex items-start gap-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 animate-pulse text-[var(--color-accent)]" />
          <div>
            <p className="text-[14px] font-medium text-[var(--color-fg)]">
              Pulling out the tasks
            </p>
            <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]" aria-live="polite">
              This keeps running if you close the page. Your notes are already
              saved, so you can come back to this entry any time.
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="mt-5">
      <CardBody className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" />
        <div>
          <p className="text-[14px] font-medium text-[var(--color-fg)]">
            Could not pull out the tasks
          </p>
          <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]" role="status">
            {job.error ??
              "Nothing came back from that run. Your notes are saved, so this can be retried."}
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={retry}>
            Try extracting again
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
