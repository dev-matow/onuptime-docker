import { Logo } from "@/components/logo";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_12%,transparent),transparent_68%)]"
      />
      <div className="relative flex w-full max-w-md flex-col items-center gap-8">
        <Logo className="text-foreground" />
        <div className="w-full">{children}</div>
        <p className="text-muted-foreground text-center text-xs">
          Secure, self-hosted uptime monitoring
        </p>
      </div>
    </div>
  );
}
