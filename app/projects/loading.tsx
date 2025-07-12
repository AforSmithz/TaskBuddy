import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-4 w-96" />
      <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-md" />
        ))}
      </div>
    </main>
  );
}
