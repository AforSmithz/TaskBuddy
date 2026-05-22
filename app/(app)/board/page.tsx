import Link from "next/link";
import { Plus, Columns3 } from "lucide-react";
import { listAllTasks, listEntries } from "@/lib/store";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { KanbanBoard } from "@/components/board/kanban-board";
import { Reveal } from "@/components/motion/reveal";

export const metadata = { title: "Board — TaskBuddy" };

export default async function BoardPage() {
  const [tasks, entries] = await Promise.all([
    listAllTasks(),
    listEntries(),
  ]);

  const entryTitles = Object.fromEntries(
    entries.map((m) => [m.id, m.title]),
  );

  return (
    <main className="mx-auto max-w-[1280px] px-8 py-8">
      <Reveal>
        <PageHeader
          title="Board"
          description="Every task across all entries. Drag cards or use the status menu."
          actions={
            <Link href="/create" className={buttonClasses("primary", "md")}>
              <Plus className="size-4" />
              New Entry
            </Link>
          }
        />
      </Reveal>

      <div className="mt-7">
        {tasks.length === 0 ? (
          <Reveal delay={0.1}>
            <EmptyState
              icon={Columns3}
              title="No tasks yet"
              description="Add a meeting or goal to extract tasks onto the board."
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
          </Reveal>
        ) : (
          <KanbanBoard tasks={tasks} entryTitles={entryTitles} />
        )}
      </div>
    </main>
  );
}
