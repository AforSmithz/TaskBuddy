"use client";

import { useState } from "react";
import { AlertTriangle, Mail, Copy, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateFollowUpAction } from "@/lib/actions";
import { useJobRun } from "@/components/jobs/use-job-run";
import { formatDate, isToday } from "@/lib/format";
import type { JobRun } from "@/lib/types";

/** The last draft that landed for this entry, read off its settled job row. */
export interface LastDraft {
  message: string;
  /** When that run settled, so a draft from last week does not read as current. */
  at: string;
}

/**
 * The follow-up draft for one entry.
 *
 * Queue-backed like the other model calls: the action publishes and returns, and the draft
 * arrives on the job row rather than as the action's return value.
 *
 * The draft is not persisted anywhere else, and does not need to be - `job_runs.result` already
 * holds it, RLS-scoped, pruned with the rest. What it does need is to be READ back, which is why
 * the page hands in `lastDraft`: this card tells the user the work "keeps running if you leave
 * this page", and a card that says that and then shows an empty pane on their return is lying.
 */
export function FollowUp({
  entryId,
  activeJob = null,
  lastDraft = null,
}: {
  entryId: string;
  /** A draft already in flight for this entry, per the server. */
  activeJob?: JobRun | null;
  /** The last draft that landed, per the server. Survives reloads and navigation. */
  lastDraft?: LastDraft | null;
}) {
  const [copied, setCopied] = useState(false);
  const job = useJobRun(activeJob);

  // Checked rather than cast because `result` is free-form jsonb: a row written
  // by an older worker can hold any shape, and a bad cast renders
  // "[object Object]" straight into the user's clipboard.
  const fresh =
    typeof job.result?.message === "string" ? job.result.message : null;

  // This run's draft wins; otherwise the last one the server knows about. No
  // local latch is needed for that: `lastDraft` still holds the PREVIOUS draft
  // while a regenerate is in flight, so the pane keeps its text instead of
  // blanking, and a regenerate that fails leaves the good draft standing.
  const message = fresh ?? lastDraft?.message ?? null;
  // Date only a draft that could actually be stale. One generated today needs no
  // warning, and "Drafted Aug 20" against work done an hour ago reads as older
  // than it is - the line is there to prompt a regenerate, not to timestamp.
  const draftedAt =
    fresh === null && lastDraft && !isToday(lastDraft.at) ? lastDraft.at : null;

  function generate() {
    if (job.pending) return;
    job.start(() => generateFollowUpAction(entryId));
  }

  async function copy() {
    if (!message) return;
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="p-5">
      {!message && !job.pending && (
        <p className="mb-3 text-[13px] text-[var(--color-fg-muted)]">
          Draft a message that confirms your tasks and asks to resolve the
          open questions and blockers.
        </p>
      )}

      {message && (
        <div className="mb-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[13px] leading-relaxed text-[var(--color-fg)]">
          {message}
        </div>
      )}

      {draftedAt && (
        <p className="mb-3 text-xs text-[var(--color-fg-subtle)]">
          Drafted {formatDate(draftedAt)}. Regenerate to reflect any changes
          since.
        </p>
      )}

      {!job.pending && job.error && (
        <p
          className="mb-3 flex items-start gap-1.5 text-[13px] text-[var(--color-danger)]"
          role="status"
          aria-live="polite"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>{job.error}</span>
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant={message ? "secondary" : "primary"}
          size="sm"
          onClick={generate}
          disabled={job.pending}
          aria-busy={job.pending}
          loading={job.pending}
        >
          {!job.pending &&
            (message || job.failed ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <Mail className="size-3.5" />
            ))}
          {message ? "Regenerate" : job.failed ? "Try again" : "Generate message"}
        </Button>
        {message && (
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>

      {job.pending && (
        <p className="text-fg-subtle mt-2 text-xs" aria-live="polite">
          Drafting. This keeps running if you leave this page.
        </p>
      )}
    </div>
  );
}
