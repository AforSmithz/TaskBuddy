import Link from "next/link";
import { Plus, CalendarClock, Gauge } from "lucide-react";
import {
  forecastDashboard,
  getAvailability,
  getCachedStrategy,
  listAllDependencies,
  listAllTasks,
  listEntries,
} from "@/lib/store";
import {
  assessStaleness,
  deterministicStrategyFrom,
} from "@/lib/portfolio-strategist";
import { isLLMConfigured } from "@/lib/extraction";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { EntryListItem } from "@/components/entries/entry-list-item";
import { Reveal } from "@/components/motion/reveal";
import { TodayAgenda } from "@/components/today/today-agenda";
import { TodayPlan } from "@/components/today/today-plan";
import { ProbabilityPill, ForecastCalibration } from "@/components/forecast/forecast-meter";
import { StrategyCard } from "@/components/strategy/strategy-card";
import { TimeBudget } from "@/components/forecast/time-budget";

export default async function TodayPage() {
  const [allTasks, entries, dependencies, dashboard, availability, cached] =
    await Promise.all([
      listAllTasks(),
      listEntries(),
      listAllDependencies(),
      forecastDashboard(),
      getAvailability(),
      getCachedStrategy(),
    ]);
  const { forecasts, recoveries, pitWall, globalPlan, model } = dashboard;

  // The Today load NEVER regenerates (no LLM). It renders the cached strategy
  // when present — marked stale only if the situation moved the odds materially or
  // it aged out — or a deterministic fallback when nothing is cached yet. The card
  // decides whether to auto-regenerate in the background (aggressive policy).
  const strategy = cached ?? deterministicStrategyFrom(recoveries, pitWall, forecasts);
  const strategyStale = cached !== null && assessStaleness(cached, forecasts).stale;
  const canUseLLM = isLLMConfigured();
  // Deferred tasks are parked out of scope for their deadline — keep them out of
  // the active working views too (they live in the project's Deferred section).
  const tasks = allTasks.filter((t) => !t.deferred);

  const todayISO = new Date().toISOString().slice(0, 10);

  const entryTitles = Object.fromEntries(
    entries.map((m) => [m.id, m.title]),
  );

  const taskCountByEntry = new Map<string, { total: number; open: number }>();
  for (const t of tasks) {
    const counts = taskCountByEntry.get(t.entry_id) ?? { total: 0, open: 0 };
    counts.total += 1;
    if (t.status !== "done") counts.open += 1;
    taskCountByEntry.set(t.entry_id, counts);
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Today"
          description={`${today} — what to focus on right now.`}
          actions={
            <Link href="/create" className={buttonClasses("primary", "md")}>
              <Plus className="size-4" />
              New Entry
            </Link>
          }
        />
      </Reveal>

      {/* One portfolio-wide strategy — the cross-project recommendation. Replaces
          the old pit-wall + per-project "Needs attention" stack; the full detail
          (contention, per-project options, heavy AI tools) lives at /strategy. */}
      <Reveal delay={0.05} className="mt-7">
        <StrategyCard strategy={strategy} stale={strategyStale} canUseLLM={canUseLLM} />
      </Reveal>

      <Reveal delay={0.1} className="mt-7">
        <TodayAgenda
          tasks={tasks}
          entryTitles={entryTitles}
          dependencies={dependencies}
          order={globalPlan.order}
        />
      </Reveal>

      <Reveal delay={0.15} className="mt-5">
        <TodayPlan days={globalPlan.days} todayISO={todayISO} />
      </Reveal>

      <Reveal delay={0.2} className="mt-5">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <TimeBudget availability={availability} today={todayISO} />
          <Card>
            <CardHeader title="On track" icon={<Gauge className="size-4" />} />
            {forecasts.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={Gauge}
                  title="No deadlines set"
                  description="Give a project a deadline to forecast your odds of finishing it in time."
                />
              </div>
            ) : (
              <div className="space-y-2 p-3">
                {forecasts.map((f) => (
                  <ProbabilityPill
                    key={f.projectId}
                    projectId={f.projectId}
                    name={f.projectName}
                    probability={f.probability}
                  />
                ))}
                <ForecastCalibration model={model} />
              </div>
            )}
          </Card>
        </div>
      </Reveal>

      <Reveal delay={0.25} className="mt-5">
        <Card>
          <CardHeader
            title="Recent activity"
            icon={<CalendarClock className="size-4" />}
          />
          {entries.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing here yet"
              description="Add a meeting transcript or a personal goal to generate tasks."
              action={
                <Link
                  href="/create"
                  className={buttonClasses("primary", "sm")}
                >
                  <Plus className="size-4" />
                  New Entry
                </Link>
              }
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {entries.map((m) => {
                const counts = taskCountByEntry.get(m.id) ?? {
                  total: 0,
                  open: 0,
                };
                return (
                  <EntryListItem
                    key={m.id}
                    id={m.id}
                    title={m.title}
                    summary={m.summary}
                    createdAt={m.created_at}
                    taskCount={counts.total}
                    openCount={counts.open}
                    kind={m.kind}
                  />
                );
              })}
            </div>
          )}
        </Card>
      </Reveal>
    </main>
  );
}
