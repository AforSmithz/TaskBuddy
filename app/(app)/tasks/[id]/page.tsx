import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Quote,
  Sparkles,
  ListTree,
  GitBranch,
  Gauge,
  Clock,
  ScrollText,
  Settings2,
  MoonStar,
  Lock,
} from "lucide-react";
import {
  forecastDashboard,
  listAllDependencies,
  listAllTasks,
  listEntries,
  listGoals,
} from "@/lib/store";
import type { Task } from "@/lib/types";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { PriorityBadge, StatusBadge, Pill } from "@/components/ui/badge";
import { FactorBreakdown } from "@/components/entries/task-detail-row";
import {
  ProbabilityPill,
  ForecastCalibration,
} from "@/components/forecast/forecast-meter";
import { TaskActions } from "@/components/tasks/task-actions";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";

function DepRow({ task, reason }: { task: Task; reason: string | null }) {
  return (
    <li className="flex items-start gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <StatusBadge status={task.status} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <Link
          href={`/tasks/${task.id}`}
          className="block truncate text-[13px] font-medium text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
        >
          {task.title}
        </Link>
        {reason && (
          <p className="mt-0.5 text-[12px] text-[var(--color-fg-muted)]">
            {reason}
          </p>
        )}
      </div>
    </li>
  );
}

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [tasks, entries, projects, deps, dashboard] = await Promise.all([
    listAllTasks(),
    listEntries(),
    listGoals(),
    listAllDependencies(),
    forecastDashboard(),
  ]);

  const task = tasks.find((t) => t.id === id);
  if (!task) notFound();

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const entry = entries.find((e) => e.id === task.entry_id) ?? null;
  const project = entry?.goal_id
    ? projects.find((p) => p.id === entry.goal_id) ?? null
    : null;

  const { globalPlan, model, forecasts } = dashboard;
  const orderEntry = globalPlan.order.find((o) => o.taskId === id) ?? null;
  const forecast = project
    ? forecasts.find((f) => f.projectId === project.id) ?? null
    : null;

  // Dependency edges, resolved to live tasks: what this waits on, what waits on it.
  const dependsOn = deps
    .filter((d) => d.task_id === id)
    .map((d) => ({ task: byId.get(d.depends_on_task_id), reason: d.reason }))
    .filter((x): x is { task: Task; reason: string | null } => !!x.task);
  const blocks = deps
    .filter((d) => d.depends_on_task_id === id)
    .map((d) => ({ task: byId.get(d.task_id), reason: d.reason }))
    .filter((x): x is { task: Task; reason: string | null } => !!x.task);
  const waitingCount = dependsOn.filter((d) => d.task.status !== "done").length;

  const overdue = isOverdue(task.due_date) && task.status !== "done";
  const back = project
    ? { href: `/projects/${project.id}`, label: project.name }
    : { href: `/entries/${task.entry_id}`, label: "entry" };

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Link
        href={back.href}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-3.5" />
        {back.label}
      </Link>

      {/* Header - identity, status, and the at-a-glance flags. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PriorityBadge label={task.priority_label} score={task.priority_score} />
        <StatusBadge status={task.status} />
        {task.is_ai_suggested && (
          <span className="inline-flex items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
            <Sparkles className="size-3" />
            AI suggested
          </span>
        )}
        {overdue && (
          <Pill className="bg-[var(--color-danger-subtle)] text-[var(--color-danger)]">
            Overdue
          </Pill>
        )}
        {task.deferred && (
          <Pill className="gap-1 text-[var(--color-fg-muted)]">
            <MoonStar className="size-3" />
            Deferred
          </Pill>
        )}
        {task.blocked_by && (
          <Pill className="gap-1 bg-[var(--color-status-blocked-subtle)] text-[var(--color-status-blocked-fg)]">
            <Lock className="size-3" />
            Blocked
          </Pill>
        )}
      </div>
      <h1 className="mt-2 text-[22px] font-semibold leading-snug text-[var(--color-fg)]">
        {task.title}
      </h1>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--color-fg-muted)]">
        {project && (
          <Link
            href={`/projects/${project.id}`}
            className="font-medium text-[var(--color-accent-fg)] transition-colors hover:text-[var(--color-accent)]"
          >
            {project.name}
          </Link>
        )}
        <Pill>{task.area}</Pill>
        {task.category && (
          <span className="text-[var(--color-fg-subtle)]">{task.category}</span>
        )}
        {task.owner && <span>{task.owner}</span>}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Main column - the homeless context: provenance, rationale, graph. */}
        <div className="space-y-5 lg:col-span-2">
          {/* Provenance - where this task came from. */}
          <Card>
            <CardHeader title="Origin" icon={<ScrollText className="size-4" />} />
            <CardBody className="space-y-3">
              {task.description ? (
                <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">
                  {task.description}
                </p>
              ) : (
                <p className="text-[13px] italic text-[var(--color-fg-subtle)]">
                  No description.
                </p>
              )}
              {task.source_quote && (
                <blockquote className="flex items-start gap-2 rounded-sm border-l-2 border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-[13px] italic text-[var(--color-fg-muted)]">
                  <Quote className="mt-0.5 size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
                  <span>{task.source_quote}</span>
                </blockquote>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-fg-subtle)]">
                {entry && (
                  <Link
                    href={`/entries/${entry.id}`}
                    className="inline-flex items-center gap-1 font-medium text-[var(--color-accent-fg)] transition-colors hover:text-[var(--color-accent)]"
                  >
                    From: {entry.title}
                    <ArrowRight className="size-3" />
                  </Link>
                )}
                <span>Added {formatDate(task.created_at)}</span>
              </div>
            </CardBody>
          </Card>

          {/* Priority rationale - the deterministic score, made legible. */}
          <Card>
            <CardHeader
              title="Why this priority"
              icon={<ListTree className="size-4" />}
              action={
                task.priority_score != null ? (
                  <span className="font-mono text-[12px] tabular-nums text-[var(--color-fg-muted)]">
                    {task.priority_score.toFixed(2)}
                  </span>
                ) : undefined
              }
            />
            <CardBody className="space-y-2">
              {task.priority_reason && (
                <p className="text-[13px] text-[var(--color-fg-muted)]">
                  {task.priority_reason}
                </p>
              )}
              <FactorBreakdown
                factors={{
                  urgency: task.urgency_score,
                  impact: task.impact_score,
                  dependency: task.dependency_score,
                  risk: task.risk_score,
                  confidence: task.confidence_score,
                  effort: task.effort_score,
                }}
              />
            </CardBody>
          </Card>

          {/* Dependency graph - what gates this, and what it gates. */}
          <Card>
            <CardHeader
              title="Dependencies"
              icon={<GitBranch className="size-4" />}
            />
            <CardBody className="space-y-4">
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  Depends on
                  {waitingCount > 0 && (
                    <span className="ml-1.5 normal-case tracking-normal text-[var(--color-status-blocked-fg)]">
                      · waiting on {waitingCount}
                    </span>
                  )}
                </p>
                {dependsOn.length === 0 ? (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Nothing — this task can start whenever it&apos;s scheduled.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {dependsOn.map(({ task: t, reason }) => (
                      <DepRow key={t.id} task={t} reason={reason} />
                    ))}
                  </ul>
                )}
              </div>
              {task.blocked_by && (
                <p className="text-[12px] text-[var(--color-status-blocked-fg)]">
                  Blocked by: {task.blocked_by}
                </p>
              )}
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  Blocks
                </p>
                {blocks.length === 0 ? (
                  <p className="text-[12px] text-[var(--color-fg-subtle)]">
                    Nothing downstream waits on this task.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {blocks.map(({ task: t, reason }) => (
                      <DepRow key={t.id} task={t} reason={reason} />
                    ))}
                  </ul>
                )}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Sidebar - actions, schedule, estimation, plan position. */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Actions" icon={<Settings2 className="size-4" />} />
            <CardBody>
              <TaskActions task={task} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Estimate" icon={<Clock className="size-4" />} />
            <CardBody className="space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-fg-muted)]">Estimated</span>
                <span className="font-mono tabular-nums text-[var(--color-fg)]">
                  {formatMinutes(task.estimated_minutes)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-fg-muted)]">Actual</span>
                <span className="font-mono tabular-nums text-[var(--color-fg)]">
                  {task.actual_minutes > 0
                    ? formatMinutes(task.actual_minutes)
                    : "—"}
                </span>
              </div>
              <div
                className={cn(
                  "flex items-center justify-between border-t border-[var(--color-border)] pt-2",
                )}
              >
                <span className="text-[var(--color-fg-muted)]">Due</span>
                <span
                  className={cn(
                    "tabular-nums",
                    overdue
                      ? "text-[var(--color-danger)]"
                      : "text-[var(--color-fg)]",
                  )}
                >
                  {formatDate(task.due_date)}
                </span>
              </div>
              <div className="pt-1">
                <ForecastCalibration model={model} />
              </div>
            </CardBody>
          </Card>

          {/* Where this task sits in the cross-project plan. */}
          {(orderEntry || forecast) && (
            <Card>
              <CardHeader
                title="In the plan"
                icon={<Gauge className="size-4" />}
              />
              <CardBody className="space-y-3 text-[13px]">
                {orderEntry && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-fg-muted)]">
                      Global order
                    </span>
                    <span className="font-mono tabular-nums text-[var(--color-fg)]">
                      #{orderEntry.rank + 1} of {globalPlan.order.length}
                    </span>
                  </div>
                )}
                {orderEntry?.pulledAhead && (
                  <p className="text-[12px] text-[var(--color-accent-fg)]">
                    {orderEntry.reason}
                  </p>
                )}
                {forecast && project && (
                  <div className="border-t border-[var(--color-border)] pt-3">
                    <p className="mb-1.5 text-[12px] text-[var(--color-fg-muted)]">
                      Its project&apos;s odds of landing on time:
                    </p>
                    <ProbabilityPill
                      projectId={project.id}
                      name={project.name}
                      probability={forecast.probability}
                    />
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
