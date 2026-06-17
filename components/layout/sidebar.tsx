"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sun,
  Columns3,
  Target,
  FilePlus2,
  Flag,
  RotateCcw,
  SlidersHorizontal,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { logoutAction } from "@/lib/auth-actions";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact: boolean;
};

/** Top "workspace" group + a labelled "Goals" group, mirroring Direction F. */
const NAV: NavItem[] = [
  { href: "/", label: "Today", icon: Sun, exact: true },
  { href: "/strategy", label: "Strategy", icon: Flag, exact: false },
  { href: "/board", label: "Board", icon: Columns3, exact: false },
];

const GOALS_NAV: NavItem[] = [
  { href: "/projects", label: "Goals & projects", icon: Target, exact: false },
  { href: "/activities", label: "Routines", icon: RotateCcw, exact: false },
  { href: "/create", label: "New entry", icon: FilePlus2, exact: false },
];

/** Two-letter initials from a display name, for the account avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "relative flex h-11 items-center gap-3 rounded-[13px] px-3 text-[14.5px] transition-colors",
        active
          ? "bg-[var(--color-surface-raised)] font-semibold text-[var(--color-fg)]"
          : "font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-fg)]",
      )}
    >
      {active && (
        <span className="absolute left-[-18px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-[var(--color-accent)]" />
      )}
      <Icon className="size-[19px] shrink-0" strokeWidth={1.7} />
      {item.label}
    </Link>
  );
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
  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-[var(--spacing-sidebar)] flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)] px-[18px] pb-[18px] pt-[26px]">
      {/* Brand */}
      <div className="flex items-center gap-[11px] px-2.5 pb-[26px]">
        <span
          className="size-[30px] rounded-[10px] bg-[image:var(--gradient-brand)]"
          style={{ boxShadow: "0 4px 14px rgba(169, 130, 244, 0.4)" }}
        />
        <span className="text-[18px] font-bold tracking-[-0.01em]">
          TaskBuddy
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-[3px]">
        {NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item)} />
        ))}

        <div className="my-3.5 h-px bg-[var(--color-border)]" />
        <p className="px-3 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
          Goals
        </p>
        {GOALS_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item)} />
        ))}
      </nav>

      {/* Footer */}
      <div className="mt-auto">
        <NavLink
          item={{
            href: "/settings",
            label: "Value model",
            icon: SlidersHorizontal,
            exact: false,
          }}
          active={isActive({
            href: "/settings",
            label: "Value model",
            icon: SlidersHorizontal,
            exact: false,
          })}
        />
        <div className="my-3.5 h-px bg-[var(--color-border)]" />
        {demoMode && (
          <div className="mb-3 rounded-[13px] bg-[var(--color-surface-raised)] px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Demo mode
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-subtle)]">
              Running offline with sample data. Add Supabase &amp; OpenRouter
              keys to go live.
            </p>
          </div>
        )}
        <div className="flex items-center gap-[11px] rounded-[13px] p-2.5 transition-colors hover:bg-[var(--color-surface-raised)]">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[image:var(--gradient-brand)] text-[11px] font-semibold text-white/95"
            aria-hidden
          >
            {initials(userName)}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13.5px] font-semibold text-[var(--color-fg)]">
              {userName}
            </p>
            <p className="truncate text-[11.5px] font-medium text-[var(--color-fg-subtle)]">
              {userEmail}
            </p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex size-8 items-center justify-center rounded-[10px] text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-surface-overlay)] hover:text-[var(--color-fg)]"
            >
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
