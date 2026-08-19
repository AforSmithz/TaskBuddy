"use client";

import { useTransition } from "react";
import {
  AlertTriangle,
  Check,
  GraduationCap,
  Lock,
  Flag,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import {
  COMPLETION_CONFIDENCE_LABELS,
  type JobRun,
  type SkillNode,
} from "@/lib/types";
import { skillProgress, topoSortSkills } from "@/lib/skill";
import { decomposeGoalAction, setSkillAttainedAction } from "@/lib/actions";
import { useJobRun } from "@/components/jobs/use-job-run";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { formatMinutes } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * A learning goal's skill graph: the decomposer's prerequisite ladder of
 * capabilities. Empty until you build the plan (an LLM decomposition). Once
 * built, it tracks the two progress kinds apart - *skill* (checkpoints cleared)
 * vs *effort* (practice minutes attained) - and surfaces which skills are
 * unlocked (prerequisites met) vs still locked.
 *
 * Building the plan is the slowest job in the app - 43 seconds measured - so it
 * runs on the queue and this card watches for it to land. `activeJob` is the
 * server's answer to "is one already running?", which is what keeps the pending
 * state honest across a reload: the work continues in a Lambda whether or not
 * this page is open.
 */
export function SkillPlan({
  goalId,
  nodes,
  activeJob = null,
}: {
  goalId: string;
  nodes: SkillNode[];
  activeJob?: JobRun | null;
}) {
  const job = useJobRun(activeJob);
  const pending = job.pending;
  const progress = skillProgress(nodes);
  const ordered = topoSortSkills(nodes);
  const unlocked = new Set(progress.unlocked);

  function build() {
    if (pending) return;
    job.start(() => decomposeGoalAction(goalId));
  }

  return (
    <Card>
      <CardHeader
        title="Skill plan"
        icon={<GraduationCap className="size-4" />}
        action={
          progress.checkpointsTotal > 0 ? (
            <Pill>
              {progress.checkpointsMet}/{progress.checkpointsTotal} checkpoints
            </Pill>
          ) : undefined
        }
      />

      <div className="px-5 pb-5">
        {nodes.length === 0 ? (
          <div className="py-2">
            <p className="text-[13px] text-[var(--color-fg-subtle)]">
              Break this learning goal into a prerequisite ladder of skills and
              checkpoints. TaskBuddy proposes the plan — you edit reality.
            </p>
            <button
              type="button"
              onClick={build}
              disabled={pending}
              aria-busy={pending}
              className="mt-3 flex h-9 items-center gap-1.5 rounded-[12px] bg-[var(--color-accent-subtle)] px-3 text-[13px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-white disabled:opacity-60"
            >
              <Sparkles className={cn("size-4", pending && "animate-pulse")} />
              {pending ? "Building the plan…" : job.failed ? "Try again" : "Build skill plan"}
            </button>
            <JobNotice pending={pending} error={job.error} />
          </div>
        ) : (
          <>
            <SkillProgressBars progress={progress} />

            <ul className="mt-4 space-y-1.5">
              {ordered.map((n) => (
                <SkillRow
                  key={n.id}
                  node={n}
                  locked={!n.attained && !unlocked.has(n.id)}
                  disabled={pending}
                />
              ))}
            </ul>

            <button
              type="button"
              onClick={build}
              disabled={pending}
              aria-busy={pending}
              className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-60"
            >
              <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
              {pending ? "Rebuilding…" : job.failed ? "Rebuild failed - try again" : "Rebuild plan"}
            </button>
            <JobNotice pending={pending} error={job.error} />
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * What the queue is doing, in words.
 *
 * A spinner alone is not enough once the work outlives the request: the job
 * keeps running if you navigate away, and a failure arrives minutes later with
 * no request left to attach an error to. Both facts are worth saying out loud.
 */
function JobNotice({ pending, error }: { pending: boolean; error: string | null }) {
  if (pending) {
    return (
      <p className="mt-2 text-[12px] text-[var(--color-fg-subtle)]" aria-live="polite">
        Working on it. This takes up to a minute and keeps going if you leave
        this page.
      </p>
    );
  }
  if (!error) return null;
  return (
    <p
      className="mt-2 flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>{error}</span>
    </p>
  );
}

function SkillProgressBars({
  progress,
}: {
  progress: ReturnType<typeof skillProgress>;
}) {
  return (
    <div className="space-y-2.5">
      <ProgressBar
        label="Skill"
        hint={
          progress.checkpointsTotal > 0
            ? `${progress.checkpointsMet}/${progress.checkpointsTotal} checkpoints`
            : `${progress.attained}/${progress.total} skills`
        }
        pct={progress.skillPct}
        tone="accent"
      />
      <ProgressBar
        label="Effort"
        hint={`${formatMinutes(progress.effortMinutesDone)} / ${formatMinutes(
          progress.effortMinutesTotal,
        )}`}
        pct={progress.effortPct}
        tone="muted"
      />
    </div>
  );
}

function ProgressBar({
  label,
  hint,
  pct,
  tone,
}: {
  label: string;
  hint: string;
  pct: number;
  tone: "accent" | "muted";
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <span className="font-semibold text-[var(--color-fg)]">{label}</span>
        <span className="text-[var(--color-fg-muted)]">
          {Math.round(pct * 100)}% · {hint}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-overlay)]">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            tone === "accent"
              ? "bg-[var(--color-accent)]"
              : "bg-[var(--color-fg-subtle)]",
          )}
          style={{ width: `${Math.round(pct * 100)}%` }}
        />
      </div>
    </div>
  );
}

function SkillRow({
  node,
  locked,
  disabled,
}: {
  node: SkillNode;
  locked: boolean;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const busy = pending || disabled;
  const verified = node.attained_confidence === "verified";

  function toggle() {
    if (busy || (locked && !node.attained)) return;
    startTransition(() => setSkillAttainedAction(node.id, !node.attained));
  }
  function verify() {
    if (busy) return;
    startTransition(() => setSkillAttainedAction(node.id, true, "verified"));
  }

  return (
    <li className="group flex items-start gap-2.5">
      <button
        type="button"
        onClick={toggle}
        disabled={busy || (locked && !node.attained)}
        aria-label={
          node.attained
            ? `Mark "${node.title}" not attained`
            : `Mark "${node.title}" attained`
        }
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          node.attained
            ? "border-[var(--color-status-done)] bg-[var(--color-status-done)] text-white"
            : locked
              ? "cursor-not-allowed border-[var(--color-border)] text-transparent"
              : "border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-status-done)]",
        )}
      >
        {locked && !node.attained ? (
          <Lock className="size-2.5 text-[var(--color-fg-subtle)]" />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "text-[13px] font-medium text-[var(--color-fg)]",
              node.attained &&
                "text-[var(--color-fg-muted)] line-through decoration-[var(--color-fg-subtle)]",
              locked && !node.attained && "text-[var(--color-fg-muted)]",
            )}
          >
            {node.title}
          </span>
          {node.is_checkpoint && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--color-accent-fg)]">
              <Flag className="size-2.5" />
              Checkpoint
            </span>
          )}
          {node.attained && node.attained_confidence && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]",
                verified
                  ? "bg-[var(--color-status-done-subtle)] text-[var(--color-status-done)]"
                  : "bg-[var(--color-cut-subtle)] text-[var(--color-cut-fg)]",
              )}
            >
              {COMPLETION_CONFIDENCE_LABELS[node.attained_confidence]}
            </span>
          )}
          {node.attained && !verified && (
            <button
              type="button"
              onClick={verify}
              disabled={busy}
              className="text-[11px] font-semibold text-[var(--color-accent)] opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover:opacity-100"
            >
              Verify
            </button>
          )}
        </div>
        {node.description && (
          <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
            {node.description}
          </p>
        )}
        <p className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">
          {locked && !node.attained ? "Locked · " : ""}
          est {formatMinutes(node.estimated_minutes)}
        </p>
      </div>
    </li>
  );
}
