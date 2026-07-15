"use client";

import { useState, useTransition } from "react";
import { Check, Plus, ShieldCheck, X } from "lucide-react";
import {
  COMPLETION_CONFIDENCE_LABELS,
  type GoalCriterion,
} from "@/lib/types";
import { goalCompletion } from "@/lib/goal";
import {
  addGoalCriterionAction,
  removeGoalCriterionAction,
  setGoalCriterionMetAction,
} from "@/lib/actions";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A goal's definition-of-done: the criteria checklist that decides when a goal is
 * actually finished (distinct from "all tasks done"). Checking a criterion marks
 * it met at `self_assessed` confidence; a met criterion can be elevated to
 * `verified`. The summary line surfaces "provisionally complete" when every
 * criterion is met but not all verified.
 */
export function DefinitionOfDone({
  goalId,
  criteria,
}: {
  goalId: string;
  criteria: GoalCriterion[];
}) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const completion = goalCompletion(criteria);

  function add() {
    const text = draft.trim();
    if (!text || pending) return;
    setDraft("");
    startTransition(() => addGoalCriterionAction(goalId, text));
  }

  return (
    <Card>
      <CardHeader
        title="Definition of done"
        icon={<ListChecks className="size-4" />}
        action={
          criteria.length > 0 ? (
            <Pill>
              {completion.metCount}/{completion.total} met
            </Pill>
          ) : undefined
        }
      />

      <div className="px-5 pb-5">
        {criteria.length === 0 ? (
          <p className="py-2 text-[13px] text-[var(--color-fg-subtle)]">
            What does &ldquo;done&rdquo; mean for this goal? Add the criteria you&apos;ll
            measure completion against.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {criteria.map((c) => (
              <CriterionRow key={c.id} criterion={c} disabled={pending} />
            ))}
          </ul>
        )}

        {/* Completion state - the honest read, not just task counts. */}
        {completion.complete && (
          <p
            className={cn(
              "mt-3 flex items-center gap-1.5 text-[12px] font-semibold",
              completion.verified
                ? "text-[var(--color-status-done)]"
                : "text-[var(--color-cut-fg)]",
            )}
          >
            {completion.verified ? (
              <>
                <ShieldCheck className="size-3.5" />
                Complete — verified
              </>
            ) : (
              <>
                <Check className="size-3.5" />
                Provisionally complete — verify the met criteria to confirm
              </>
            )}
          </p>
        )}

        {/* Add a criterion. */}
        <div className="mt-3 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add a criterion…"
            className="h-9 min-w-0 flex-1 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent-subtle)]"
          />
          <button
            type="button"
            onClick={add}
            disabled={pending || !draft.trim()}
            className="flex h-9 items-center gap-1.5 rounded-[12px] bg-[var(--color-accent-subtle)] px-3 text-[13px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-white disabled:opacity-50 disabled:hover:bg-[var(--color-accent-subtle)] disabled:hover:text-[var(--color-accent)]"
          >
            <Plus className="size-4" />
            Add
          </button>
        </div>
      </div>
    </Card>
  );
}

function CriterionRow({
  criterion: c,
  disabled,
}: {
  criterion: GoalCriterion;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const busy = pending || disabled;
  const verified = c.met_confidence === "verified";

  function toggle() {
    if (busy) return;
    startTransition(() => setGoalCriterionMetAction(c.id, !c.met));
  }
  function verify() {
    if (busy) return;
    startTransition(() => verifyCriterion(c.id));
  }
  function remove() {
    if (busy) return;
    startTransition(() => removeGoalCriterionAction(c.id));
  }

  return (
    <li className="group flex items-center gap-2.5">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={c.met ? `Mark "${c.text}" not met` : `Mark "${c.text}" met`}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          c.met
            ? "border-[var(--color-status-done)] bg-[var(--color-status-done)] text-white"
            : "border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-status-done)]",
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </button>

      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px] text-[var(--color-fg)]",
          c.met && "text-[var(--color-fg-muted)] line-through decoration-[var(--color-fg-subtle)]",
        )}
      >
        {c.text}
      </span>

      {c.met && c.met_confidence && (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]",
            verified
              ? "bg-[var(--color-status-done-subtle)] text-[var(--color-status-done)]"
              : "bg-[var(--color-cut-subtle)] text-[var(--color-cut-fg)]",
          )}
        >
          {COMPLETION_CONFIDENCE_LABELS[c.met_confidence]}
        </span>
      )}

      {c.met && !verified && (
        <button
          type="button"
          onClick={verify}
          disabled={busy}
          className="shrink-0 text-[11px] font-semibold text-[var(--color-accent)] opacity-0 transition-opacity hover:underline focus-visible:opacity-100 group-hover:opacity-100"
        >
          Verify
        </button>
      )}

      <button
        type="button"
        onClick={remove}
        disabled={busy}
        aria-label={`Remove "${c.text}"`}
        className="shrink-0 text-[var(--color-fg-subtle)] opacity-0 transition-opacity hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
}

/** Elevate a met criterion to `verified` confidence (keeps it met). */
function verifyCriterion(id: string) {
  return setGoalCriterionMetAction(id, true, "verified");
}
