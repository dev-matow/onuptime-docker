import { Skeleton } from "@/components/ui/skeleton";

export default function MonitorDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-20" />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2.5">
          <Skeleton className="h-8 w-56" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-28" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-7 w-20" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="bg-card ring-foreground/10 space-y-2 p-3 ring-1"
          >
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </div>

      <div className="bg-card ring-foreground/10 space-y-3 p-3 ring-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3.5 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>

      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <div className="bg-card ring-foreground/10 ring-1">
          <div className="flex items-center gap-4 border-b px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0"
            >
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
