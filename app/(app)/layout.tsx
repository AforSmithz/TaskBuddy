import { Sidebar } from "@/components/layout/sidebar";
import { isSupabaseConfigured } from "@/lib/store";
import { isLLMConfigured } from "@/lib/extraction";
import { requireUser, displayName } from "@/lib/auth";

/**
 * Shell for every signed-in page: the sidebar plus the main content column.
 * {@link requireUser} both guards the section and supplies the account shown
 * in the sidebar footer.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const demoMode = !isSupabaseConfigured() || !isLLMConfigured();

  return (
    <>
      <Sidebar
        demoMode={demoMode}
        userName={displayName(user)}
        userEmail={user.email ?? ""}
      />
      <div className="ml-[var(--spacing-sidebar)] min-h-screen">{children}</div>
    </>
  );
}
