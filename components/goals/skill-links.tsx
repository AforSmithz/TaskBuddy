"use client";

import { useTransition } from "react";
import { AlertTriangle, Check, Link2, Sparkles, X } from "lucide-react";
import type { JobRun, SkillTaskLink } from "@/lib/types";
import { setSkillLinkStatusAction, suggestSkillLinksAction } from "@/lib/actions";
import { useJobRun } from "@/components/jobs/use-job-run";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/** A link joined to the titles of the two rows it connects (resolved server-side). */
export interface HydratedLink extends SkillTaskLink {
  nodeTitle: string;
  taskTitle: string;
  taskGoalName: string;
}

/**
 * Linked work: the explicit "these two are the same work" edges between this goal's
 * skills and your tasks. Spillover reads only the CONFIRMED ones - so when you finish
 * a linked task, the app offers to credit the skill, and vice versa.
 *
 * A suggestion is inert until you confirm it. Dismissing one retires the pair for good
 * rather than re-proposing it on the next pass.
 */
export function SkillLinks({
  goalId,
  links,
  activeJob = null,
}: {
  goalId: string;
  links: HydratedLink[];
  /** A proposal run already in flight for this goal, per the server. */
  activeJob?: JobRun | null;
}) {
  const [pending, startTransition] = useTransition();
  // Proposing links judges every candidate pair with its own model call, which
  // is why it runs on the queue: in-process, a burst of throttles made
  // `filterVerified` drop good pairs and report success, while on the queue the
  // same burst is a retry with a DLQ behind it.
  const job = useJobRun(activeJob);

  const suggested = links.filter((l) => l.status === "suggested");
  const confirmed = links.filter((l) => l.status === "confirmed");

  function findLinks() {
    if (pending || job.pending) return;
    job.start(() => suggestSkillLinksAction(goalId));
  }

  function setStatus(id: string, status: "confirmed" | "dismissed") {
    if (pending) return;
    startTransition(() => void setSkillLinkStatusAction(id, status));
  }

  // The count the action used to return, read back off the job row. Without it
  // a run that proposed nothing looks identical to one that never happened.
  const proposed =
    job.run?.status === "succeeded" && typeof job.result?.created === "number"
      ? (job.result.created as number)
      : null;

  return (
    <Card>
      <CardHeader
        title="Linked work"
        icon={<Link2 className="size-4" />}
        action={
          confirmed.length > 0 ? (
            <Pill>
              {confirmed.length} linked
            </Pill>
          ) : undefined
        }
      />

      <div className="px-5 pb-5">
        <p className="text-fg-muted mb-4 text-sm">
          Tasks that demonstrate a skill here. Finish one and the check-in offers to
          credit the skill it proves, and the other way round. Only skills you&apos;ve
          unlocked can be credited this way.
        </p>

        {suggested.length > 0 && (
          <ul className="mb-4 space-y-2">
            {suggested.map((l) => (
              <li
                key={l.id}
                className="border-border bg-bg-subtle rounded-lg border px-3 py-2.5"
              >
                <div className="text-sm">
                  <span className="font-medium">{l.taskTitle}</span>
                  <span className="text-fg-subtle"> demonstrates </span>
                  <span className="font-medium">{l.nodeTitle}</span>
                </div>
                {l.rationale && (
                  <p className="text-fg-muted mt-1 text-xs">{l.rationale}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStatus(l.id, "confirmed")}
                    disabled={pending}
                    className={cn(
                      "focus-visible:ring-accent inline-flex items-center gap-1 rounded-[14px] px-2.5 py-1",
                      "text-xs font-medium focus-visible:ring-2 focus-visible:outline-none",
                      "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]",
                      "disabled:opacity-50",
                    )}
                  >
                    <Check className="size-3" /> Link them
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatus(l.id, "dismissed")}
                    disabled={pending}
                    className={cn(
                      "focus-visible:ring-accent inline-flex items-center gap-1 rounded-[14px] px-2.5 py-1",
                      "text-fg-muted text-xs font-medium focus-visible:ring-2 focus-visible:outline-none",
                      "border-border border disabled:opacity-50",
                    )}
                  >
                    <X className="size-3" /> Not the same
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {confirmed.length > 0 && (
          <ul className="mb-4 space-y-1.5">
            {confirmed.map((l) => (
              <li key={l.id} className="flex items-start gap-2 text-sm">
                <Check className="text-accent mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">{l.taskTitle}</span>
                  <span className="text-fg-subtle"> demonstrates </span>
                  <span className="font-medium">{l.nodeTitle}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {suggested.length === 0 && confirmed.length === 0 && (
          <p className="text-fg-subtle mb-4 text-sm">
            Nothing linked yet. These pairs are worded too differently to spot by name,
            so they get proposed for you to confirm.
          </p>
        )}

        <button
          type="button"
          onClick={findLinks}
          disabled={pending || job.pending}
          aria-busy={job.pending}
          className={cn(
            "focus-visible:ring-accent inline-flex items-center gap-1.5 rounded-[14px] px-3 py-1.5",
            "border-border border text-sm font-medium focus-visible:ring-2 focus-visible:outline-none",
            "hover:bg-bg-subtle disabled:opacity-50",
          )}
        >
          <Sparkles className={cn("size-3.5", job.pending && "animate-pulse")} />
          {job.pending
            ? "Looking…"
            : job.failed
              ? "Try again"
              : "Find linked work"}
        </button>

        {job.pending && (
          <p className="text-fg-subtle mt-2 text-xs" aria-live="polite">
            Checking each pair. This keeps running if you leave this page.
          </p>
        )}
        {!job.pending && job.error && (
          <p
            className="mt-2 flex items-start gap-1.5 text-xs text-[var(--color-danger)]"
            role="status"
            aria-live="polite"
          >
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
            <span>{job.error}</span>
          </p>
        )}
        {!job.pending && proposed === 0 && (
          <p className="text-fg-subtle mt-2 text-xs" aria-live="polite">
            Nothing new to link. Every pair worth proposing is already on record.
          </p>
        )}
      </div>
    </Card>
  );
}
