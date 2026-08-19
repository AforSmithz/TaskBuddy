import { Sparkles } from "lucide-react";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-[var(--color-bg)] px-6 py-12">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white">
          <Sparkles className="size-5" />
        </span>
        <span className="text-xl font-bold tracking-[-0.01em]">TaskBuddy</span>
      </div>
      {children}
    </div>
  );
}
