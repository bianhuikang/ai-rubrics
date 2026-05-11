import { NextResponse } from "next/server";
import { getTask, listResults } from "@/lib/db";
import { buildTaskSyncSummary } from "@/lib/task-sync-summary";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404, headers: corsHeaders });
  const results = listResults(id);
  const completedUrls = new Set(results.map((result) => result.url));
  const allUrlsCompleted = task.urls.every((url) => completedUrls.has(url));

  if (task.status !== "scored" || !allUrlsCompleted) {
    return NextResponse.json(
      {
        error: "任务未完成",
        status: task.status,
        resultCount: completedUrls.size,
        urlCount: task.urls.length,
      },
      { status: 409, headers: corsHeaders },
    );
  }

  return NextResponse.json(buildTaskSyncSummary(task, results), { headers: corsHeaders });
}
