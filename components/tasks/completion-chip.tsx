"use client";

import { useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import {
  COMPLETION_CONFIDENCE_LABELS,
  type Task,
} from "@/lib/types";
import { verifyTaskAction } from "@/lib/actions";
import { cn } from "@/lib/cn";

/**
 * A small chip on a done task showing how sure we are it's really finished
 * (verified / self-assessed / inferred). When it isn't yet verified, a one-click
 * "verify" elevates it. Renders nothing for open or untagged tasks.
 */
export function CompletionChip({ task }: { task: Task }) {
  const [pending, startTransition] = useTransition();
  if (task.status !== "done" || !task.completion_confidence) return null;
  const verified = task.completion_confidence === "verified";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]",
          verified
            ? "bg-[var(--color-status-done-subtle)] text-[var(--color-status-done)]"
            : "bg-[var(--color-cut-subtle)] text-[var(--color-cut-fg)]",
        )}
      >
        {verified && <ShieldCheck className="size-3" />}
        {COMPLETION_CONFIDENCE_LABELS[task.completion_confidence]}
      </span>
      {!verified && (
        <button
          type="button"
          onClick={() =>
            !pending && startTransition(() => verifyTaskAction(task.id))
          }
          disabled={pending}
          className="text-[11px] font-semibold text-[var(--color-accent)] hover:underline disabled:opacity-50"
        >
          Verify
        </button>
      )}
    </span>
  );
}
