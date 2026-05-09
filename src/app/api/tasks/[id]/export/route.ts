import { NextResponse } from "next/server";
import { getTask, listResults } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const results = listResults(id);
  const format = new URL(request.url).searchParams.get("format") ?? "json";

  if (format === "csv") {
    const header = ["url", ...task.rubrics.map((rubric) => rubric.id), "total", "max", "reasons"];
    const rows = results.map((result) => {
      const total = result.scores.reduce((sum, score) => sum + score, 0);
      return [
        result.url,
        ...task.rubrics.map((_, index) => String(result.scores[index] ?? 0)),
        String(total),
        String(task.rubrics.length),
        result.reasons.join(" | "),
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${task.id}.csv"`,
      },
    });
  }

  return NextResponse.json({
    task,
    results,
    exportedAt: new Date().toISOString(),
  });
}

function csvCell(value: string) {
  const normalized = value.replace(/\r?\n/g, " ");
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}
