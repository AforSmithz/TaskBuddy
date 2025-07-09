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
import { getMeeting, getProject } from "@/lib/store";
import { formatDate } from "@/lib/format";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { TaskList } from "@/components/meetings/task-list";
import { ScheduleTimeline } from "@/components/meetings/schedule-timeline";
import { FollowUp } from "@/components/meetings/follow-up";

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const meeting = await getMeeting(id);
  if (!meeting) notFound();
  // Drafts are not yet live — send them to the review gate.
  if (meeting.status === "draft") redirect(`/meetings/${id}/review`);

  const isPlan = meeting.kind === "plan";
  const project = meeting.project_id
    ? await getProject(meeting.project_id)
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
          {meeting.title}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
          {isPlan ? "Created" : "Captured"} {formatDate(meeting.created_at)}
          {meeting.stakeholders.length > 0 &&
            ` · ${meeting.stakeholders.join(", ")}`}
        </p>
      </div>

      {/* Summary */}
      <Card className="mt-5">
        <CardBody className="space-y-4">
          {meeting.daily_objective && (
            <div className="flex items-start gap-3 rounded-sm bg-[var(--color-accent-subtle)] px-4 py-3">
              <Target className="mt-0.5 size-4 shrink-0 text-[var(--color-accent)]" />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-fg)]">
                  Today&apos;s objective
                </p>
                <p className="mt-0.5 text-[14px] text-[var(--color-fg)]">
                  {meeting.daily_objective}
                </p>
              </div>
            </div>
          )}
          {meeting.summary && (
            <p className="text-[14px] leading-relaxed text-[var(--color-fg)]">
              {meeting.summary}
            </p>
          )}
          {meeting.discussion_points.length > 0 && (
            <ul className="space-y-1">
              {meeting.discussion_points.map((p, i) => (
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
              action={countPill(meeting.tasks.length)}
            />
            <TaskList tasks={meeting.tasks} />
          </Card>

          {!isPlan && (
          <Card>
            <CardHeader
              title="Decision log"
              icon={<GitBranch className="size-4" />}
              action={countPill(meeting.decisions.length)}
            />
            {meeting.decisions.length === 0 ? (
              <Empty text="No decisions were recorded in this meeting." />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {meeting.decisions.map((d) => (
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
              action={countPill(meeting.open_questions.length)}
            />
            {meeting.open_questions.length === 0 ? (
              <Empty text="No unresolved questions — everything is clear." />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {meeting.open_questions.map((q) => (
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
            <ScheduleTimeline blocks={meeting.schedule} />
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
                items={meeting.key_deliverables}
              />
              <PlannerList
                label="Assumptions"
                icon={<Lightbulb className="size-3.5" />}
                items={meeting.assumptions}
              />
              <PlannerList
                label="Risks"
                icon={<AlertTriangle className="size-3.5" />}
                items={meeting.risks}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Follow-up message"
              icon={<Mail className="size-4" />}
            />
            <FollowUp meetingId={meeting.id} />
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
