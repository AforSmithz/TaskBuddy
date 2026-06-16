import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-5 w-40" />
      <Skeleton className="mt-2 h-8 w-80" />
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Skeleton className="h-40 rounded-md" />
          <Skeleton className="h-56 rounded-md" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-72 rounded-md" />
          <Skeleton className="h-40 rounded-md" />
        </div>
      </div>
    </main>
  );
}
