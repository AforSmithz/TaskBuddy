import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[1280px] px-8 py-8">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-4 w-96" />
      <div className="mt-7 flex gap-4 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-96 w-[272px] shrink-0 rounded-lg" />
        ))}
      </div>
    </main>
  );
}
