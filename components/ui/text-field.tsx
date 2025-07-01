import { cn } from "@/lib/cn";

const FIELD_BASE =
  "w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] " +
  "text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] " +
  "hover:border-[var(--color-border-strong)] focus:outline-none focus:border-[var(--color-accent)] " +
  "transition-colors disabled:opacity-60 disabled:bg-[var(--color-surface-raised)]";

export function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[13px] font-medium text-[var(--color-fg)] mb-1.5"
    >
      {children}
    </label>
  );
}

export function TextField(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  const { className, ...rest } = props;
  return <input className={cn(FIELD_BASE, "h-9 px-3", className)} {...rest} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const { className, ...rest } = props;
  return (
    <textarea
      className={cn(
        FIELD_BASE,
        "rounded-md p-4 leading-relaxed resize-y min-h-[300px]",
        className,
      )}
      {...rest}
    />
  );
}

const SELECT_BASE =
  "h-9 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] " +
  "px-2.5 text-[14px] text-[var(--color-fg)] transition-colors " +
  "hover:border-[var(--color-border-strong)] focus:border-[var(--color-accent)] focus:outline-none " +
  "disabled:opacity-60";

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
) {
  const { className, ...rest } = props;
  return <select className={cn(SELECT_BASE, className)} {...rest} />;
}
