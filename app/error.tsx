"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <AlertTriangle className="size-6 text-[var(--color-danger)]" />
      </div>
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-[var(--color-fg)]">
          Something went wrong
        </p>
        <p className="max-w-sm text-[13px] text-[var(--color-fg-muted)]">
          {error.message || "An unexpected error occurred while loading this page."}
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => unstable_retry()}>
        Try again
      </Button>
    </main>
  );
}
