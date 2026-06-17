"use client";

import { useState, useTransition } from "react";
import { quickAddErrandAction } from "@/lib/actions";

/**
 * The full-width universal capture bar. For now Enter drops whatever you type
 * into today's queue as a one-off errand (the same action as Quick-add); the
 * natural-language register-router that splits ideas / status / vents comes in a
 * later phase. The soft gradient orb + ↵ affordance match Direction F.
 */
export function CaptureBar() {
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text || pending) return;
    startTransition(async () => {
      await quickAddErrandAction(text, null);
      setValue("");
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-3.5 rounded-[18px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 shadow-[var(--shadow-md)]"
    >
      <span
        className="size-[30px] shrink-0 rounded-full bg-[image:var(--gradient-brand)]"
        aria-hidden
      />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        placeholder="Type anything — an idea, an update, what's on your mind…"
        aria-label="Capture anything"
        className="min-w-0 flex-1 bg-transparent text-[15px] font-medium text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
      />
      <span className="rounded-[7px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg-subtle)]">
        ↵
      </span>
    </form>
  );
}
