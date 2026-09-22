import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(): Promise<NextResponse> {
  const companies = await prisma.company.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, supportTimezone: true },
  });
  return NextResponse.json({
    companies: companies.map((company) => ({
      id: company.id,
      name: company.name,
      support_timezone: company.supportTimezone,
    })),
  });
}
