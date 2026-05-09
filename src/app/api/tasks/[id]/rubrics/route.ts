import { NextResponse } from "next/server";
import { collectPageEvidence } from "@/lib/collector";
import { getSettings, getTask, updateTask } from "@/lib/db";
import { generateRubrics } from "@/lib/llm";
import { trimForPrompt } from "@/lib/requirement-parser";
import { logEvidence, logRubrics, logTaskStep } from "@/lib/server-log";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  try {
    const settings = getSettings();
    const candidates = [];
    for (const [index, url] of task.urls.entries()) {
      try {
        logTaskStep(id, `抓取 rubrics 生成候选 ${index + 1}/${task.urls.length}`, { url });
        const evidence = await collectPageEvidence({ url, prompt: task.prompt, taskId: task.id, index });
        logEvidence(id, evidence);
        logTaskStep(id, `rubrics 候选抓取成功 ${index + 1}/${task.urls.length}`, { url });
        candidates.push({
          url,
          summary: {
            title: evidence.title,
            visibleText: trimForPrompt(evidence.visibleText, 4000),
            requirements: evidence.requirements,
            requiredElements: evidence.requiredElements,
            controls: evidence.controls.slice(0, 60),
            layout: evidence.layout,
            visual: evidence.visual,
            technology: evidence.technology,
            responsive: evidence.responsive,
            motion: evidence.motion,
            interactions: evidence.interactions,
            errors: evidence.errors,
          },
        });
      } catch (error) {
        logTaskStep(id, `rubrics 候选抓取失败 ${index + 1}/${task.urls.length}`, {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        candidates.push({
          url,
          summary: {
            errors: [error instanceof Error ? error.message : String(error)],
          },
        });
      }
    }

    logTaskStep(id, "开始生成 rubrics");
    const rubrics = await generateRubrics(settings, task.prompt, candidates);
    logRubrics(id, rubrics);
    logTaskStep(id, "rubrics 生成成功", { count: rubrics.length });
    const updated = updateTask(id, { rubrics, status: "rubrics-ready", error: undefined });
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "rubrics 生成失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
