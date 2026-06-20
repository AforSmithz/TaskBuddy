"use client";

import { useState, useTransition } from "react";
import { Undo2, Clock, Coins } from "lucide-react";
import { deferTaskAction } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { formatMinutes } from "@/lib/format";

interface DeferredTask {
  id: string;
  title: string;
  /** `"debt"` ⇒ work a scope-cut set aside; styled as owed, not just deferred. */
  origin?: string | null;
  estimatedMinutes?: number | null;
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
      {visible.map((t) => {
        const isDebt = t.origin === "debt";
        return (
          <div key={t.id} className="flex items-center gap-2.5 px-5 py-2.5">
            {isDebt ? (
              <Coins className="size-3.5 shrink-0 text-[var(--color-cut-fg)]" />
            ) : (
              <Clock className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-fg-muted)]">
              {t.title}
            </span>
            {isDebt && (
              <span className="shrink-0 rounded-xs bg-[var(--color-cut-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-cut-fg)]">
                Owed
                {typeof t.estimatedMinutes === "number" &&
                  ` · ${formatMinutes(t.estimatedMinutes)}`}
              </span>
            )}
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
        );
      })}
    </div>
  );
}
