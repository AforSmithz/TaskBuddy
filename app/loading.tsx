import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[1280px] px-8 py-8">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-80" />
      <div className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-md lg:col-span-2" />
        <Skeleton className="h-72 rounded-md" />
      </div>
    </main>
  );
}
