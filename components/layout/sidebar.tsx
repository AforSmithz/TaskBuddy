"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  Columns3,
  FolderKanban,
  FilePlus2,
  Sparkles,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { logoutAction } from "@/lib/auth-actions";

const NAV = [
  { href: "/", label: "Today", icon: Sun, exact: true },
  { href: "/board", label: "Board", icon: Columns3, exact: false },
  { href: "/projects", label: "Projects", icon: FolderKanban, exact: false },
  { href: "/create", label: "New Entry", icon: FilePlus2, exact: false },
];

/** Two-letter initials from a display name, for the account avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({
  demoMode,
  userName,
  userEmail,
}: {
  demoMode: boolean;
  userName: string;
  userEmail: string;
}) {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-[var(--spacing-sidebar)] flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex size-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-white">
          <Sparkles className="size-4" />
        </span>
        <span className="text-[15px] font-bold tracking-[-0.01em]">
          TaskBuddy
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3">
        <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
          Workspace
        </p>
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md px-2 text-[15px] font-medium transition-colors",
                    active
                      ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
                      : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--color-border)] p-3">
        {demoMode && (
          <div className="mb-3 rounded-md bg-[var(--color-surface-raised)] px-2.5 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Demo mode
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-subtle)]">
              Running offline with sample data. Add Supabase &amp; OpenRouter
              keys to go live.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-raised)] text-[11px] font-medium text-[var(--color-fg-muted)]">
            {initials(userName)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[var(--color-fg)]">
              {userName}
            </p>
            <p className="truncate text-[11px] text-[var(--color-fg-muted)]">
              {userEmail}
            </p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex size-7 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]"
            >
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
