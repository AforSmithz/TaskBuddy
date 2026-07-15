"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { createActivityAction } from "@/lib/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const inputCls =
  "h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none";

/**
 * Create a routine (daily, streak-based) or goal (weekly session target). Direct
 * create - no LLM extraction. The strategist defaults to protecting routines and
 * treating goals as discretionary; the user can flip that here or per-row later.
 */
export function ActivityForm() {
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [perWeek, setPerWeek] = useState(3);
  const [weekdaysOnly, setWeekdaysOnly] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const [area, setArea] = useState("Personal");
  const [isProtected, setIsProtected] = useState(true);

  function pickPeriod(next: "day" | "week") {
    setPeriod(next);
    // Sensible default: routines are protected, goals are discretionary flex.
    setIsProtected(next === "day");
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || pending) return;
    startTransition(async () => {
      await createActivityAction({
        title: title.trim(),
        area: area.trim() || "Personal",
        period,
        target_count: period === "week" ? Math.max(1, perWeek) : 1,
        weekdays: period === "day" && weekdaysOnly ? [1, 2, 3, 4, 5] : null,
        estimated_minutes: Math.max(1, minutes),
        protected: isProtected,
      });
      setTitle("");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Read Quran, Piano practice, Workout…"
        aria-label="Activity title"
        className={cn(inputCls, "w-full")}
      />

      <div className="flex flex-wrap items-end gap-3">
        {/* Type */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--color-fg-subtle)]">
            Type
          </span>
          <div className="flex overflow-hidden rounded-md border border-[var(--color-border)]">
            <TypeButton
              label="Routine"
              hint="daily"
              active={period === "day"}
              onClick={() => pickPeriod("day")}
            />
            <TypeButton
              label="Goal"
              hint="weekly"
              active={period === "week"}
              onClick={() => pickPeriod("week")}
            />
          </div>
        </div>

        {/* Cadence detail */}
        {period === "week" ? (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-[var(--color-fg-subtle)]">
              Times / week
            </span>
            <input
              type="number"
              min={1}
              max={14}
              value={perWeek}
              onChange={(e) => setPerWeek(Number(e.target.value))}
              aria-label="Times per week"
              className={cn(inputCls, "w-20")}
            />
          </label>
        ) : (
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={weekdaysOnly}
              onChange={(e) => setWeekdaysOnly(e.target.checked)}
            />
            <span className="text-[13px] text-[var(--color-fg-muted)]">
              Weekdays only
            </span>
          </label>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--color-fg-subtle)]">
            Minutes
          </span>
          <input
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            aria-label="Minutes per session"
            className={cn(inputCls, "w-20")}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--color-fg-subtle)]">
            Area
          </span>
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            aria-label="Life area"
            className={cn(inputCls, "w-28")}
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isProtected}
            onChange={(e) => setIsProtected(e.target.checked)}
          />
          <span className="text-[13px] text-[var(--color-fg-muted)]">
            Protect — the strategist won&apos;t sacrifice this when the week tightens
          </span>
        </label>
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>
    </form>
  );
}

function TypeButton({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-baseline gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
          : "bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
      <span className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</span>
    </button>
  );
}
