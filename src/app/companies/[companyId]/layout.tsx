import { ArrowLeftIcon, GlobeIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CompanyNavTabs } from "@/components/CompanyNavTabs";
import { Badge } from "@/components/ui/badge";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function CompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      supportTimezone: true,
      maxActiveTicketsPerAgent: true,
    },
  });

  if (!company) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
      {/* Top Header / Breadcrumbs */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center hover:opacity-90 transition-opacity"
            >
              <Image
                src="/logo.svg"
                alt="ClearFeed Logo"
                width={110}
                height={32}
                priority
                className="h-7 w-auto"
              />
            </Link>
            <span className="text-border text-sm">/</span>
            <Link
              href="/"
              className="group inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5 transition-transform group-hover:-translate-x-1" />
              <span>All Workspaces</span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex size-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-muted-foreground font-mono">
              Routing Active
            </span>
          </div>
        </div>

        {/* Company Title Banner */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-xs">
          <div className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground font-bold text-xl shadow-xs brand-gradient-bg">
              {company.name.charAt(0)}
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">
                  {company.name}
                </h1>
                <Badge variant="secondary" className="gap-1 text-xs">
                  <GlobeIcon className="size-3 text-primary" />
                  {company.supportTimezone}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Max Workload Limit:{" "}
                <span className="font-semibold text-foreground font-mono">
                  {company.maxActiveTicketsPerAgent} active tickets / agent
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Dynamic Navigation Tabs */}
        <CompanyNavTabs companyId={company.id} />
      </div>

      {/* Page Content */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
