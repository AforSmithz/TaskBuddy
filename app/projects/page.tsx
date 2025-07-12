import Link from "next/link";
import { Plus, FolderKanban, ListChecks, ChevronRight } from "lucide-react";
import { listAllTasks, listMeetings, listProjects } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";

export const metadata = { title: "Projects — TaskBuddy" };

export default async function ProjectsPage() {
  const [projects, meetings, tasks] = await Promise.all([
    listProjects(),
    listMeetings(),
    listAllTasks(),
  ]);

  const meetingsByProject = new Map<string, number>();
  for (const m of meetings) {
    if (m.project_id)
      meetingsByProject.set(
        m.project_id,
        (meetingsByProject.get(m.project_id) ?? 0) + 1,
      );
  }

  const projectOfMeeting = new Map(meetings.map((m) => [m.id, m.project_id]));
  const tasksByProject = new Map<string, { total: number; open: number }>();
  for (const t of tasks) {
    const pid = projectOfMeeting.get(t.meeting_id);
    if (!pid) continue;
    const entry = tasksByProject.get(pid) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (t.status !== "done") entry.open += 1;
    tasksByProject.set(pid, entry);
  }

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Projects"
          description="Group related meetings and goal plans into a single workspace."
          actions={
            <Link href="/create" className={buttonClasses("primary", "md")}>
              <Plus className="size-4" />
              New Entry
            </Link>
          }
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-7">
        {projects.length === 0 ? (
          <Card>
            <EmptyState
              icon={FolderKanban}
              title="No projects yet"
              description="Create a project while adding a meeting or goal — it groups everything that belongs together."
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
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {projects.map((p) => {
              const counts = tasksByProject.get(p.id) ?? { total: 0, open: 0 };
              const entryCount = meetingsByProject.get(p.id) ?? 0;
              return (
                <Link key={p.id} href={`/projects/${p.id}`}>
                  <Card className="group h-full p-5 transition-colors hover:border-[var(--color-border-strong)]">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-9 items-center justify-center rounded-md bg-[var(--color-accent-subtle)] text-[var(--color-accent)]">
                        <FolderKanban className="size-4" />
                      </span>
                      <ChevronRight className="size-4 text-[var(--color-fg-subtle)] transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="mt-3 text-[15px] font-semibold text-[var(--color-fg)]">
                      {p.name}
                    </p>
                    {p.description && (
                      <p className="mt-0.5 line-clamp-2 text-[13px] text-[var(--color-fg-muted)]">
                        {p.description}
                      </p>
                    )}
                    <div className="mt-3 flex items-center gap-4 text-[12px] text-[var(--color-fg-muted)]">
                      <span>
                        {entryCount} {entryCount === 1 ? "entry" : "entries"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <ListChecks className="size-3.5" />
                        {counts.open}/{counts.total} open
                      </span>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </Reveal>
    </main>
  );
}
