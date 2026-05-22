"use client";

import { useState, useTransition } from "react";
import { Mail, Copy, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateFollowUpAction } from "@/lib/actions";

export function FollowUp({ entryId }: { entryId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function generate() {
    startTransition(async () => {
      setError(null);
      const res = await generateFollowUpAction(entryId);
      if (res.error) setError(res.error);
      else setMessage(res.message);
    });
  }

  async function copy() {
    if (!message) return;
    await navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="p-5">
      {!message && !pending && (
        <p className="mb-3 text-[13px] text-[var(--color-fg-muted)]">
          Draft a message that confirms your tasks and asks to resolve the
          open questions and blockers.
        </p>
      )}

      {message && (
        <div className="mb-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[13px] leading-relaxed text-[var(--color-fg)]">
          {message}
        </div>
      )}

      {error && (
        <p className="mb-3 text-[13px] text-[var(--color-danger)]">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant={message ? "secondary" : "primary"}
          size="sm"
          onClick={generate}
          loading={pending}
        >
          {!pending &&
            (message ? (
              <RefreshCw className="size-3.5" />
            ) : (
              <Mail className="size-3.5" />
            ))}
          {message ? "Regenerate" : "Generate message"}
        </Button>
        {message && (
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
    </div>
  );
}
