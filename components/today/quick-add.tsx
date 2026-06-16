"use client";

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { quickAddErrandAction } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const inputCls =
  "h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none";

/**
 * Quick-capture a one-off errand ("groceries tomorrow") straight into today's
 * queue — a plain task under the reserved Errands project, no project or LLM
 * extraction needed. Recurring routines/goals are set up on the Routines page.
 */
export function QuickAdd() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || pending) return;
    startTransition(async () => {
      await quickAddErrandAction(title.trim(), due || null);
      setTitle("");
      setDue("");
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
      >
        <Plus className="size-4" />
        Quick-add an errand
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Groceries, call the bank, return package…"
        aria-label="Errand"
        className={cn(inputCls, "min-w-0 flex-1")}
      />
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        aria-label="Due date (optional)"
        className={inputCls}
      />
      <Button type="submit" variant="primary" size="sm" loading={pending}>
        Add
      </Button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close"
        className="flex size-8 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition-colors hover:text-[var(--color-fg-muted)]"
      >
        <X className="size-4" />
      </button>
    </form>
  );
}
