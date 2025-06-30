// Minimal class-name merge helper — joins truthy class strings.
export function cn(
  ...classes: (string | undefined | null | false)[]
): string {
  return classes.filter(Boolean).join(" ");
}
