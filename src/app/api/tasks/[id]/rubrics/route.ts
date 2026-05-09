import { NextResponse } from "next/server";
import { getSettings, getTask, updateTask } from "@/lib/db";
import { generateRubrics } from "@/lib/llm";
import { logRubrics, logTaskStep } from "@/lib/server-log";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  try {
    const settings = getSettings();
    updateTask(id, { status: "generating-rubrics", error: undefined });
    logTaskStep(id, "开始生成 rubrics");
    const rubrics = await generateRubrics(settings, task.prompt, []);
    logRubrics(id, rubrics);
    logTaskStep(id, "rubrics 生成成功", { count: rubrics.length });
    const updated = updateTask(id, { rubrics, rubricsSource: "generated", status: "rubrics-ready", error: undefined });
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "rubrics 生成失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
