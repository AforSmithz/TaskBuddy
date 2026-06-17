import Link from "next/link";
import { Plus, FolderKanban } from "lucide-react";
import { listAllTasks, listEntries, listGoals } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { Reveal } from "@/components/motion/reveal";
import { GoalsGrid, type GoalCard } from "@/components/goals/goals-grid";

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

  const cards: GoalCard[] = projects.map((p) => {
    const counts = tasksByProject.get(p.id) ?? { total: 0, open: 0 };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      entryCount: entriesByProject.get(p.id) ?? 0,
      open: counts.open,
      total: counts.total,
    };
  });

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
          <GoalsGrid goals={cards} />
        )}
      </Reveal>
    </main>
  );
}
