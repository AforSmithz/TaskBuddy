import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { LocalNowBeacon } from "@/components/layout/local-now-beacon";
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
  const name = displayName(user);
  const firstName = name.split(/\s+/)[0];

  return (
    <>
      <LocalNowBeacon />
      <Sidebar demoMode={demoMode} userName={name} userEmail={user.email ?? ""} />
      <div className="ml-[var(--spacing-sidebar)] min-h-screen">
        <div className="mx-auto max-w-[1180px] px-8 pt-6">
          <TopBar firstName={firstName} />
        </div>
        {children}
      </div>
    </>
  );
}
