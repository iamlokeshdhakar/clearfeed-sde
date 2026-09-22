import {
  ArrowRightIcon,
  ClockIcon,
  GlobeIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function getCompanies() {
  try {
    return await prisma.company.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        supportTimezone: true,
        maxActiveTicketsPerAgent: true,
        _count: {
          select: {
            agents: true,
            availabilityWindows: true,
          },
        },
      },
    });
  } catch (error) {
    console.error("Failed to load companies:", error);
    return null;
  }
}

export default async function Home() {
  const companies = await getCompanies();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-12 sm:py-16">
      {/* Brand Header */}
      <div className="flex flex-col gap-3 text-center sm:text-left">
        <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
          <Image
            src="/logo.svg"
            alt="ClearFeed Logo"
            width={122}
            height={36}
            priority
            className="h-9 w-auto"
          />
          <Badge
            variant="outline"
            className="border-primary/30 bg-primary/10 text-primary font-semibold text-xs py-1"
          >
            Ticket Assignment Automation
          </Badge>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl mt-1">
          Support Team Workspaces
        </h1>
        <p className="text-muted-foreground max-w-2xl text-base leading-relaxed">
          Select a company workspace to manage agent availability schedules,
          review support coverage gaps, and inspect automated ticket
          assignments.
        </p>
      </div>

      {/* Feature / Status Pills */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
          <div className="flex size-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">
            <ShieldCheckIcon className="size-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">
              Fair Routing Engine
            </span>
            <span className="text-sm font-semibold">
              Active Ticket Cap & Ties
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
          <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
            <ClockIcon className="size-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">
              Auto-Retry System
            </span>
            <span className="text-sm font-semibold">5-Min Pending Sweeps</span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
          <div className="flex size-10 items-center justify-center rounded-lg bg-purple-50 text-purple-600 dark:bg-purple-950/60 dark:text-purple-400">
            <GlobeIcon className="size-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-medium text-muted-foreground">
              Multi-Timezone
            </span>
            <span className="text-sm font-semibold">
              Overnight Window Support
            </span>
          </div>
        </div>
      </div>

      {/* Company List */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">
            Companies ({companies?.length ?? 0})
          </h2>
          <span className="text-xs text-muted-foreground">
            Click a workspace to open
          </span>
        </div>

        {companies === null ? (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="pt-6 text-destructive text-sm">
              Couldn&apos;t reach the database. Make sure Postgres is running (
              <code className="font-mono bg-destructive/10 px-1.5 py-0.5 rounded">
                docker compose up -d db
              </code>
              ) and reload the page.
            </CardContent>
          </Card>
        ) : companies.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground text-sm">
              No companies are seeded yet. Run{" "}
              <code className="font-mono bg-muted px-1.5 py-0.5 rounded">
                npm run seed
              </code>{" "}
              in your terminal.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/companies/${company.id}/availability`}
                className="group"
              >
                <Card className="h-full border-border/80 transition-all duration-200 group-hover:border-primary/50 group-hover:shadow-md">
                  <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold transition-transform group-hover:scale-105">
                        {company.name.charAt(0)}
                      </div>
                      <div>
                        <CardTitle className="text-base font-bold group-hover:text-primary transition-colors">
                          {company.name}
                        </CardTitle>
                        <CardDescription className="flex items-center gap-1 text-xs mt-0.5">
                          <GlobeIcon className="size-3 shrink-0" />
                          {company.supportTimezone}
                        </CardDescription>
                      </div>
                    </div>
                    <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                  </CardHeader>

                  <CardContent className="pt-0 text-xs text-muted-foreground flex flex-wrap items-center gap-3 border-t border-border/40 mt-2 pt-3">
                    <div className="flex items-center gap-1">
                      <UsersIcon className="size-3.5 text-primary/70" />
                      <span>{company._count.agents} agents</span>
                    </div>
                    <span className="text-border">•</span>
                    <div className="flex items-center gap-1">
                      <ClockIcon className="size-3.5 text-primary/70" />
                      <span>{company._count.availabilityWindows} windows</span>
                    </div>
                    <span className="text-border">•</span>
                    <div className="flex items-center gap-1">
                      <span>
                        Max {company.maxActiveTicketsPerAgent} tkt/agent
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
