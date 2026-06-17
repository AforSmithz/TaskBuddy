import Link from "next/link";
import { Plus, CalendarClock, Gauge } from "lucide-react";
import {
  forecastDashboard,
  getAvailability,
  getCachedStrategy,
  getRecurringState,
  listAllDependencies,
  listAllTasks,
  listEntries,
} from "@/lib/store";
import {
  assessStaleness,
  deterministicStrategyFrom,
} from "@/lib/portfolio-strategist";
import { isLLMConfigured } from "@/lib/extraction";
import { CaptureBar } from "@/components/today/capture-bar";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { EntryListItem } from "@/components/entries/entry-list-item";
import { Reveal } from "@/components/motion/reveal";
import { recurringAgendaTask } from "@/lib/recurring";
import { TodayAgenda } from "@/components/today/today-agenda";
import { QuickAdd } from "@/components/today/quick-add";
import { TodayPlan } from "@/components/today/today-plan";
import {
  ProbabilityPill,
  ForecastCalibration,
} from "@/components/forecast/forecast-meter";
import { StrategyCard } from "@/components/strategy/strategy-card";
import { TimeBudget } from "@/components/forecast/time-budget";

export default async function TodayPage() {
  const [
    allTasks,
    entries,
    dependencies,
    dashboard,
    availability,
    cached,
    recurringStates,
  ] = await Promise.all([
    listAllTasks(),
    listEntries(),
    listAllDependencies(),
    forecastDashboard(),
    getAvailability(),
    getCachedStrategy(),
    getRecurringState(),
  ]);
  const { forecasts, recoveries, pitWall, globalPlan, agendaOrder, model } =
    dashboard;

  // The Today load NEVER regenerates (no LLM). It renders the cached strategy
  // when present — marked stale only if the situation moved the odds materially or
  // it aged out — or a deterministic fallback when nothing is cached yet. The card
  // decides whether to auto-regenerate in the background (aggressive policy).
  const strategy =
    cached ??
    deterministicStrategyFrom(
      recoveries,
      pitWall,
      forecasts,
      new Map(allTasks.map((t) => [t.id, t])),
    );
  const strategyStale =
    cached !== null && assessStaleness(cached, forecasts).stale;
  const canUseLLM = isLLMConfigured();
  // Escalate the banner only when a hard deadline is genuinely at risk (a critical
  // divergence reason) — otherwise it stays the calm front door.
  const bannerSeverity = recoveries.some((p) =>
    p.reasons.some((r) => r.severity === "critical"),
  )
    ? "escalated"
    : "gentle";
  // taskId → project name (every open task is in the global order) so the strategy
  // card can tag each deferred task with the project it belongs to.
  const projectNames = Object.fromEntries(
    globalPlan.order.map((o) => [o.taskId, o.projectName]),
  );
  // Deferred tasks are parked out of scope for their deadline — keep them out of
  // the active working views too (they live in the project's Deferred section).
  const tasks = allTasks.filter((t) => !t.deferred);

  const todayISO = new Date().toISOString().slice(0, 10);

  // Recurring routines/goals due today, woven into the one agenda list as
  // synthetic rows (their hours are already drained into capacity upstream).
  const recurringStateById = Object.fromEntries(
    recurringStates.map((s) => [s.activity.id, s]),
  );
  const recurringRows = recurringStates
    .filter((s) => s.dueToday)
    .map((s) => recurringAgendaTask(s.activity, todayISO));
  const agendaTasks = [...tasks, ...recurringRows];

  const entryTitles = Object.fromEntries(entries.map((m) => [m.id, m.title]));

  const taskCountByEntry = new Map<string, { total: number; open: number }>();
  for (const t of tasks) {
    const counts = taskCountByEntry.get(t.entry_id) ?? { total: 0, open: 0 };
    counts.total += 1;
    if (t.status !== "done") counts.open += 1;
    taskCountByEntry.set(t.entry_id, counts);
  }

  return (
    <main className="mx-auto max-w-[1180px] px-8 pb-12 pt-6">
      <Reveal>
        <CaptureBar />
      </Reveal>

      {/* Direction F two-column shell: the actionable flow (strategy -> agenda ->
          plan) in the wide column, status & context in the right rail. Collapses
          to one column under 980px (matches the f-webapp mockup). */}
      <div className="mt-7 grid grid-cols-1 items-start gap-[18px] min-[980px]:grid-cols-[1.7fr_1fr]">
        {/* Wide column — what to do next */}
        <div className="min-w-0 space-y-5">
          {/* One portfolio-wide strategy — the cross-project recommendation. The
              full detail (contention, per-project options, heavy AI tools) lives
              at /strategy. */}
          <Reveal delay={0.05}>
            <StrategyCard
              strategy={strategy}
              stale={strategyStale}
              canUseLLM={canUseLLM}
              projectNames={projectNames}
              severity={bannerSeverity}
            />
          </Reveal>

          <Reveal delay={0.1} className="flex justify-end">
            <QuickAdd />
          </Reveal>

          <Reveal delay={0.12}>
            <TodayAgenda
              tasks={agendaTasks}
              entryTitles={entryTitles}
              dependencies={dependencies}
              order={agendaOrder}
              recurringStateById={recurringStateById}
            />
          </Reveal>

          <Reveal delay={0.15}>
            <TodayPlan days={globalPlan.days} todayISO={todayISO} />
          </Reveal>
        </div>

        {/* Right rail — status & context */}
        <div className="min-w-0 space-y-5">
          <Reveal delay={0.18}>
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
          </Reveal>

          <Reveal delay={0.2}>
            <TimeBudget availability={availability} today={todayISO} />
          </Reveal>

          <Reveal delay={0.25}>
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
        </div>
      </div>
    </main>
  );
}
