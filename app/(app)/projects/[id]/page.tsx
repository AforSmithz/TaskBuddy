import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FolderKanban,
  GraduationCap,
  CalendarClock,
  ListChecks,
  Gauge,
  Clock,
} from "lucide-react";
import {
  forecastProjectWithRecovery,
  getGoal,
  listAllTasks,
  listEntries,
  listGoalCriteria,
} from "@/lib/store";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { EntryListItem } from "@/components/entries/entry-list-item";
import { TaskList } from "@/components/entries/task-list";
import { ForecastMeter, ForecastCalibration } from "@/components/forecast/forecast-meter";
import { DeadlineEditor } from "@/components/forecast/deadline-editor";
import { RecoveryCallout } from "@/components/forecast/recovery-callout";
import { DeferredTasks } from "@/components/forecast/deferred-tasks";
import { DefinitionOfDone } from "@/components/goals/definition-of-done";
import { GoalKindEditor } from "@/components/goals/goal-kind-badge";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, entries, tasks, criteria, fr] = await Promise.all([
    getGoal(id),
    listEntries(),
    listAllTasks(),
    listGoalCriteria(id),
    forecastProjectWithRecovery(id),
  ]);
  if (!project) notFound();
  const { forecast, recovery, model } = fr;

  const projectEntries = entries.filter((m) => m.goal_id === id);
  // Tasks belong to the goal directly now (the spine) — no longer derived
  // through the entry they were ingested from.
  const allProjectTasks = tasks
    .filter((t) => t.goal_id === id)
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  // Deferred tasks are pushed past the deadline; surface them separately so
  // they don't clutter the active list, but keep them reversible.
  const deferredTasks = allProjectTasks.filter((t) => t.deferred);
  const projectTasks = allProjectTasks.filter((t) => !t.deferred);

  const openCount = projectTasks.filter((t) => t.status !== "done").length;
  const countById = new Map<string, { total: number; open: number }>();
  for (const t of projectTasks) {
    const e = countById.get(t.entry_id) ?? { total: 0, open: 0 };
    e.total += 1;
    if (t.status !== "done") e.open += 1;
    countById.set(t.entry_id, e);
  }

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-4" />
        Goals
      </Link>

      <div className="mt-3 flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-md bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
          {project.kind === "learning" ? (
            <GraduationCap className="size-5" />
          ) : (
            <FolderKanban className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-[var(--color-fg)]">
            {project.name}
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-fg-muted)]">
            {project.description ??
              `${projectEntries.length} entries · ${openCount} open tasks`}
          </p>
        </div>
        <GoalKindEditor goalId={project.id} kind={project.kind} />
      </div>

      {/* Proactive recovery — surfaced only when the project is off track. */}
      {recovery && (
        <div className="mt-5">
          <RecoveryCallout plan={recovery} />
        </div>
      )}

      {/* Completion forecast — the strategist's headline number. */}
      <Card className="mt-5">
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-fg)]">
              <Gauge className="size-4 text-[var(--color-accent)]" />
              Completion forecast
            </p>
            <DeadlineEditor projectId={project.id} deadline={project.deadline} />
          </div>
          {forecast ? (
            <>
              <ForecastMeter forecast={forecast} deadline={forecast.deadline} />
              <ForecastCalibration model={model} />
            </>
          ) : (
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Set a deadline to see the live probability of finishing this
              project&apos;s open work in time.
            </p>
          )}
        </CardBody>
      </Card>

      {/* Definition of done — the goal's real finish line (vs. "all tasks done"). */}
      <div className="mt-5">
        <DefinitionOfDone goalId={project.id} criteria={criteria} />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Tasks"
              icon={<ListChecks className="size-4" />}
              action={<Pill>{projectTasks.length}</Pill>}
            />
            {projectTasks.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No tasks yet"
                description="Add a meeting or note to this goal to populate its tasks."
              />
            ) : (
              <TaskList tasks={projectTasks} />
            )}
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader
              title="Entries"
              icon={<CalendarClock className="size-4" />}
              action={<Pill>{projectEntries.length}</Pill>}
            />
            {projectEntries.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
                No meetings or plans in this project.
              </p>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {projectEntries.map((m) => {
                  const c = countById.get(m.id) ?? { total: 0, open: 0 };
                  return (
                    <EntryListItem
                      key={m.id}
                      id={m.id}
                      title={m.title}
                      summary={m.summary}
                      createdAt={m.created_at}
                      taskCount={c.total}
                      openCount={c.open}
                    />
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Deferred — work pushed past the deadline by a recovery move. Reversible. */}
      {deferredTasks.length > 0 && (
        <Card className="mt-5">
          <CardHeader
            title="Deferred"
            icon={<Clock className="size-4" />}
            action={<Pill>{deferredTasks.length}</Pill>}
          />
          <DeferredTasks
            tasks={deferredTasks.map((t) => ({ id: t.id, title: t.title }))}
          />
        </Card>
      )}
    </main>
  );
}
