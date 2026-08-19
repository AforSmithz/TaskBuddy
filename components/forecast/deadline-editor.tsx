"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { setProjectDeadlineAction } from "@/lib/actions";

export function DeadlineEditor({
  projectId,
  deadline,
}: {
  projectId: string;
  deadline: string | null;
}) {
  const [value, setValue] = useState(deadline ?? "");
  const [pending, startTransition] = useTransition();

  function save(next: string) {
    setValue(next);
    startTransition(async () => {
      await setProjectDeadlineAction(projectId, next || null);
    });
  }

  return (
    <label className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-fg-muted)] focus-within:border-[var(--color-accent)]">
      {pending ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : (
        <CalendarClock className="size-4 shrink-0" />
      )}
      <span className="shrink-0">Deadline</span>
      <input
        type="date"
        value={value}
        onChange={(e) => save(e.target.value)}
        disabled={pending}
        className="bg-transparent font-medium text-[var(--color-fg)] focus:outline-none"
      />
    </label>
  );
}
