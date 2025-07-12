import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-[960px] px-8 py-8">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="mt-3 h-8 w-64" />
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Skeleton className="h-96 rounded-md lg:col-span-2" />
        <Skeleton className="h-96 rounded-md" />
      </div>
    </main>
  );
}
