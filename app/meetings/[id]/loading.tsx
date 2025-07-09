import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[1280px] px-8 py-8">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-8 w-72" />
      <Skeleton className="mt-2 h-4 w-48" />
      <Skeleton className="mt-5 h-40 rounded-md" />
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Skeleton className="h-80 rounded-md" />
          <Skeleton className="h-48 rounded-md" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-64 rounded-md" />
          <Skeleton className="h-48 rounded-md" />
        </div>
      </div>
    </main>
  );
}
