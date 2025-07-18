"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { loginAction, signupAction } from "@/lib/auth-actions";
import type { AuthState } from "@/lib/types";
import { FieldLabel, TextField } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";

const INITIAL: AuthState = { error: null, notice: null };

/**
 * Email + password form, shared by the login and signup screens. `mode`
 * selects which Server Action runs and which copy is shown.
 */
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const isSignup = mode === "signup";
  const [state, action, pending] = useActionState(
    isSignup ? signupAction : loginAction,
    INITIAL,
  );

  return (
    <div className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-sm">
      <h1 className="text-[19px] font-bold tracking-[-0.01em]">
        {isSignup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="mt-1 text-[13px] text-[var(--color-fg-muted)]">
        {isSignup
          ? "Start turning meeting notes into an execution plan."
          : "Sign in to your TaskBuddy workspace."}
      </p>

      <form action={action} className="mt-6 space-y-4">
        {isSignup && (
          <div>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <TextField
              id="name"
              name="name"
              autoComplete="name"
              placeholder="Jane Doe"
              required
            />
          </div>
        )}

        <div>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <TextField
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </div>

        <div>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <TextField
            id="password"
            name="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            placeholder={isSignup ? "At least 8 characters" : "••••••••"}
            minLength={isSignup ? 8 : undefined}
            required
          />
        </div>

        {state.error && (
          <p className="flex items-start gap-1.5 rounded-sm bg-[var(--color-danger-subtle)] px-2.5 py-2 text-[13px] text-[var(--color-danger)]">
            <AlertCircle className="mt-px size-4 shrink-0" />
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="flex items-start gap-1.5 rounded-sm bg-[var(--color-success-subtle)] px-2.5 py-2 text-[13px] text-[var(--color-success)]">
            <CheckCircle2 className="mt-px size-4 shrink-0" />
            {state.notice}
          </p>
        )}

        <Button type="submit" loading={pending} className="w-full">
          {isSignup ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="mt-5 text-center text-[13px] text-[var(--color-fg-muted)]">
        {isSignup ? "Already have an account? " : "New to TaskBuddy? "}
        <Link
          href={isSignup ? "/login" : "/signup"}
          className="font-medium text-[var(--color-accent-fg)] hover:underline"
        >
          {isSignup ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
