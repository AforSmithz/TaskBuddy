import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { isSupabaseConfigured } from "@/lib/store";
import { isLLMConfigured } from "@/lib/extraction";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TaskBuddy — Meeting-to-Execution Dashboard",
  description:
    "Turn messy meeting notes into a structured execution plan: tasks, priorities, schedule, and a Kanban workflow.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const demoMode = !isSupabaseConfigured() || !isLLMConfigured();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Sidebar demoMode={demoMode} />
        <div className="ml-[var(--spacing-sidebar)] min-h-screen">
          {children}
        </div>
      </body>
    </html>
  );
}
