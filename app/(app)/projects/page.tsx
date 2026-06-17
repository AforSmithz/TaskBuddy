import Link from "next/link";
import { Plus, FolderKanban, ListChecks, ChevronRight } from "lucide-react";
import { listAllTasks, listEntries, listGoals } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";

export const metadata = { title: "Goals — TaskBuddy" };

export default async function ProjectsPage() {
  const [projects, entries, tasks] = await Promise.all([
    listGoals(),
    listEntries(),
    listAllTasks(),
  ]);

  const entriesByProject = new Map<string, number>();
  for (const m of entries) {
    if (m.goal_id)
      entriesByProject.set(
        m.goal_id,
        (entriesByProject.get(m.goal_id) ?? 0) + 1,
      );
  }

  const projectOfEntry = new Map(entries.map((m) => [m.id, m.goal_id]));
  const tasksByProject = new Map<string, { total: number; open: number }>();
  for (const t of tasks) {
    const pid = projectOfEntry.get(t.entry_id);
    if (!pid) continue;
    const counts = tasksByProject.get(pid) ?? { total: 0, open: 0 };
    counts.total += 1;
    if (t.status !== "done") counts.open += 1;
    tasksByProject.set(pid, counts);
  }

  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Goals"
          description="Group related meetings and plans into a single workspace."
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
              title="No goals yet"
              description="Create a goal while adding a meeting or note — it groups everything that belongs together."
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
              const entryCount = entriesByProject.get(p.id) ?? 0;
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
