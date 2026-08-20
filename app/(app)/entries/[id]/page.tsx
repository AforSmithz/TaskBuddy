import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  ListChecks,
  GitBranch,
  HelpCircle,
  CalendarClock,
  Target,
  Mail,
  Quote,
  Flag,
  AlertTriangle,
  Lightbulb,
  FolderKanban,
} from "lucide-react";
import {
  activeJobRun,
  getEntry,
  getEntrySchedule,
  getGoal,
  latestSucceededJobRun,
} from "@/lib/store";
import { formatDate } from "@/lib/format";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { TaskList } from "@/components/entries/task-list";
import { ScheduleTimeline } from "@/components/entries/schedule-timeline";
import { FollowUp } from "@/components/entries/follow-up";

/** Named once: the page reads two different questions off this job type. */
const FOLLOW_UP_JOB = "entry.follow_up.requested";

export default async function EntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const entry = await getEntry(id);
  if (!entry) notFound();
  // Drafts are not yet live - send them to the review gate.
  if (entry.status === "draft") redirect(`/entries/${id}/review`);

  const isPlan = entry.kind === "plan";
  const [project, scheduleDays, followUpJob, lastFollowUp] = await Promise.all([
    entry.goal_id ? getGoal(entry.goal_id) : Promise.resolve(null),
    getEntrySchedule(entry),
    // A draft still in flight, so a reload mid-run shows the spinner rather
    // than an idle button beside running work.
    activeJobRun(FOLLOW_UP_JOB, id),
    // ...and the last one that landed, because the draft lives nowhere else.
    // Without this the card promises the job "keeps running if you leave this
    // page" and then has nothing to show the user who takes it up on that.
    latestSucceededJobRun(FOLLOW_UP_JOB, id),
  ]);
  const lastDraft =
    typeof lastFollowUp?.result?.message === "string"
      ? { message: lastFollowUp.result.message, at: lastFollowUp.updatedAt }
      : null;

  const countPill = (n: number) => <Pill>{n}</Pill>;

  return (
    <main className="mx-auto max-w-[1280px] px-8 py-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
        >
          <ArrowLeft className="size-4" />
          Dashboard
        </Link>
        {project && (
          <Link
            href={`/projects/${project.id}`}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-accent)]"
          >
            <FolderKanban className="size-4" />
            {project.name}
          </Link>
        )}
      </div>

      <div className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          {isPlan && (
            <span className="inline-flex items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
              <Target className="size-3" />
              Goal plan
            </span>
          )}
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-[-0.02em] text-[var(--color-fg)]">
          {entry.title}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
          {isPlan ? "Created" : "Captured"} {formatDate(entry.created_at)}
          {entry.stakeholders.length > 0 &&
            ` · ${entry.stakeholders.join(", ")}`}
        </p>
      </div>

      {/* Summary */}
      <Card className="mt-5">
        <CardBody className="space-y-4">
          {entry.daily_objective && (
            <div className="flex items-start gap-3 rounded-sm bg-[var(--color-accent-subtle)] px-4 py-3">
              <Target className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-fg)]">
                  Today&apos;s objective
                </p>
                <p className="mt-0.5 text-[14px] text-[var(--color-fg)]">
                  {entry.daily_objective}
                </p>
              </div>
            </div>
          )}
          {entry.summary && (
            <p className="text-[14px] leading-relaxed text-[var(--color-fg)]">
              {entry.summary}
            </p>
          )}
          {entry.discussion_points.length > 0 && (
            <ul className="space-y-1">
              {entry.discussion_points.map((p, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[13px] text-[var(--color-fg-muted)]"
                >
                  <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-fg-subtle)]" />
                  {p}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Left: tasks, decisions, questions */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Tasks"
              icon={<ListChecks className="size-4" />}
              action={countPill(entry.tasks.length)}
            />
            <TaskList tasks={entry.tasks} />
          </Card>

          {!isPlan && (
          <Card>
            <CardHeader
              title="Decision log"
              icon={<GitBranch className="size-4" />}
              action={countPill(entry.decisions.length)}
            />
            {entry.decisions.length === 0 ? (
              <Empty text="No decisions were recorded in this entry." />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {entry.decisions.map((d) => (
                  <div key={d.id} className="px-5 py-3.5">
                    <p className="text-[14px] font-medium text-[var(--color-fg)]">
                      {d.decision}
                    </p>
                    {d.source_quote && (
                      <p className="mt-1 flex items-start gap-1.5 text-[12px] italic text-[var(--color-fg-subtle)]">
                        <Quote className="mt-0.5 size-3 shrink-0" />
                        {d.source_quote}
                      </p>
                    )}
                    {d.confidence && (
                      <Pill className="mt-2">{d.confidence} confidence</Pill>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          )}

          {!isPlan && (
          <Card>
            <CardHeader
              title="Open questions"
              icon={<HelpCircle className="size-4" />}
              action={countPill(entry.open_questions.length)}
            />
            {entry.open_questions.length === 0 ? (
              <Empty text="No unresolved questions — everything is clear." />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {entry.open_questions.map((q) => (
                  <div key={q.id} className="px-5 py-3.5">
                    <p className="text-[14px] font-medium text-[var(--color-fg)]">
                      {q.question}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--color-fg-muted)]">
                      {q.related_stakeholder && (
                        <span>Owner: {q.related_stakeholder}</span>
                      )}
                      {q.confidence && (
                        <Pill>{q.confidence} confidence</Pill>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          )}
        </div>

        {/* Right: planner, schedule, follow-up */}
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Recommended schedule"
              icon={<CalendarClock className="size-4" />}
            />
            <ScheduleTimeline days={scheduleDays} />
          </Card>

          <Card>
            <CardHeader
              title="Daily planner"
              icon={<Target className="size-4" />}
            />
            <CardBody className="space-y-4">
              <PlannerList
                label="Key deliverables"
                icon={<Flag className="size-3.5" />}
                items={entry.key_deliverables}
              />
              <PlannerList
                label="Assumptions"
                icon={<Lightbulb className="size-3.5" />}
                items={entry.assumptions}
              />
              <PlannerList
                label="Risks"
                icon={<AlertTriangle className="size-3.5" />}
                items={entry.risks}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Follow-up message"
              icon={<Mail className="size-4" />}
            />
            <FollowUp
              entryId={entry.id}
              activeJob={followUpJob}
              lastDraft={lastDraft}
            />
          </Card>
        </div>
      </div>
    </main>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
      {text}
    </p>
  );
}

function PlannerList({
  label,
  icon,
  items,
}: {
  label: string;
  icon: React.ReactNode;
  items: string[];
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg)]">
        <span className="text-[var(--color-fg-muted)]">{icon}</span>
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-[12px] text-[var(--color-fg-subtle)]">
          None identified.
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-[13px] text-[var(--color-fg-muted)]"
            >
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-fg-subtle)]" />
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
