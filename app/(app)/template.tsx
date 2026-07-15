import { PageTransition } from "@/components/motion/page-transition";

/**
 * Root template - remounts on every top-level navigation, so the
 * <PageTransition> entrance animation replays as the user moves between
 * Dashboard, Board and Entries.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
