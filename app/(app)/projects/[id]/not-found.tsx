import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <FolderKanban className="size-6 text-[var(--color-fg-subtle)]" />
      </div>
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-[var(--color-fg)]">
          Project not found
        </p>
        <p className="max-w-sm text-[13px] text-[var(--color-fg-muted)]">
          This project may have been removed, or the link is incorrect.
        </p>
      </div>
      <Link href="/projects" className={buttonClasses("secondary", "sm")}>
        Back to projects
      </Link>
    </main>
  );
}
