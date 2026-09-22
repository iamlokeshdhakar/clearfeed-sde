"use client";

import { cn } from "cn";
import {
  CalendarIcon,
  PieChartIcon,
  PlusCircleIcon,
  TicketIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface CompanyNavTabsProps {
  companyId: string;
}

export function CompanyNavTabs({ companyId }: CompanyNavTabsProps) {
  const pathname = usePathname();

  const tabs = [
    {
      label: "Availability",
      href: `/companies/${companyId}/availability`,
      icon: CalendarIcon,
    },
    {
      label: "Coverage",
      href: `/companies/${companyId}/coverage`,
      icon: PieChartIcon,
    },
    {
      label: "Assignments",
      subtitle: "review only",
      href: `/companies/${companyId}/assignments`,
      icon: TicketIcon,
    },
    {
      label: "Ticket Sandbox",
      subtitle: "create & test",
      href: `/companies/${companyId}/tickets`,
      icon: PlusCircleIcon,
    },
  ];

  return (
    <nav className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-3 text-sm font-medium">
      {tabs.map((tab) => {
        const isActive = pathname.startsWith(tab.href);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3.5 py-2 transition-all duration-150",
              isActive
                ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span>{tab.label}</span>
            {tab.subtitle && (
              <span
                className={cn(
                  "text-[10px] rounded px-1.5 py-0.5 font-normal uppercase tracking-wider",
                  isActive
                    ? "bg-primary-foreground/20 text-primary-foreground"
                    : "bg-muted-foreground/15 text-muted-foreground",
                )}
              >
                {tab.subtitle}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
