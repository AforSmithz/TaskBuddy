"use client";

import { useState, useTransition } from "react";
import { Undo2, Clock } from "lucide-react";
import { deferTaskAction } from "@/lib/actions";
import { Button } from "@/components/ui/button";

interface DeferredTask {
  id: string;
  title: string;
}

/**
 * Tasks pushed past the deadline by a recovery move. Deferral is reversible:
 * un-defer puts the task back into the forecast.
 */
export function DeferredTasks({ tasks }: { tasks: DeferredTask[] }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [restored, setRestored] = useState<Set<string>>(new Set());

  const visible = tasks.filter((t) => !restored.has(t.id));
  if (visible.length === 0) return null;

  function undefer(id: string) {
    setBusy(id);
    startTransition(async () => {
      await deferTaskAction(id, false);
      setRestored((s) => new Set(s).add(id));
      setBusy(null);
    });
  }

  return (
    <div className="divide-y divide-[var(--color-border)]">
      {visible.map((t) => (
        <div key={t.id} className="flex items-center gap-2.5 px-5 py-2.5">
          <Clock className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-fg-muted)]">
            {t.title}
          </span>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === t.id}
            disabled={pending}
            onClick={() => undefer(t.id)}
          >
            <Undo2 className="size-3.5" />
            Restore
          </Button>
        </div>
      ))}
    </div>
  );
}
