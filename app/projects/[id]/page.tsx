import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FolderKanban,
  CalendarClock,
  ListChecks,
} from "lucide-react";
import { getProject, listAllTasks, listMeetings } from "@/lib/store";
import { Card, CardHeader } from "@/components/ui/card";
import { Pill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { MeetingListItem } from "@/components/meetings/meeting-list-item";
import { TaskList } from "@/components/meetings/task-list";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, meetings, tasks] = await Promise.all([
    getProject(id),
    listMeetings(),
    listAllTasks(),
  ]);
  if (!project) notFound();

  const projectMeetings = meetings.filter((m) => m.project_id === id);
  const meetingIds = new Set(projectMeetings.map((m) => m.id));
  const projectTasks = tasks
    .filter((t) => meetingIds.has(t.meeting_id))
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  const openCount = projectTasks.filter((t) => t.status !== "done").length;
  const countById = new Map<string, { total: number; open: number }>();
  for (const t of projectTasks) {
    const e = countById.get(t.meeting_id) ?? { total: 0, open: 0 };
    e.total += 1;
    if (t.status !== "done") e.open += 1;
    countById.set(t.meeting_id, e);
  }

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <ArrowLeft className="size-4" />
        Projects
      </Link>

      <div className="mt-3 flex items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-md bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
          <FolderKanban className="size-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-[var(--color-fg)]">
            {project.name}
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-fg-muted)]">
            {project.description ??
              `${projectMeetings.length} entries · ${openCount} open tasks`}
          </p>
        </div>
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
                description="Add a meeting or goal to this project to populate its tasks."
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
              action={<Pill>{projectMeetings.length}</Pill>}
            />
            {projectMeetings.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
                No meetings or plans in this project.
              </p>
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {projectMeetings.map((m) => {
                  const c = countById.get(m.id) ?? { total: 0, open: 0 };
                  return (
                    <MeetingListItem
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
    </main>
  );
}
