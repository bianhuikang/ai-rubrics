import { NextResponse } from "next/server";
import { collectPageEvidence } from "@/lib/collector";
import { deleteResultsForTask, getSettings, getTask, listResults, saveResult, updateTask } from "@/lib/db";
import { generateEvidencePlan, scorePage } from "@/lib/llm";
import { logEvidence, logScores, logTaskStep } from "@/lib/server-log";
import type { EvidencePlanStep, Rubric, Settings } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!task.rubrics.length) return NextResponse.json({ error: "Generate or add rubrics first." }, { status: 400 });

  const settings = getSettings();

  try {
    updateTask(id, { status: "scoring", error: undefined });
    deleteResultsForTask(id);
    const evidencePlan = await createEvidencePlanForTask(settings, task.prompt, task.rubrics, id);

    for (const [index, url] of task.urls.entries()) {
      logTaskStep(id, `开始对 URL ${index + 1}/${task.urls.length} 打分`, { url });
      logTaskStep(id, `抓取评分页面 ${index + 1}/${task.urls.length}`, { url });
      const evidence = await collectPageEvidence({ url, prompt: task.prompt, taskId: id, index, rubrics: task.rubrics, evidencePlan });
      logEvidence(id, evidence);
      logTaskStep(id, `评分页面抓取成功 ${index + 1}/${task.urls.length}`, { url });
      logTaskStep(id, `调用模型评分 ${index + 1}/${task.urls.length}`, { url });
      const scored = await scorePage({
        settings,
        prompt: task.prompt,
        rubrics: task.rubrics,
        evidence,
      });
      saveResult({
        taskId: id,
        url,
        evidence,
        scores: scored.scores,
        reasons: scored.reasons,
        rawResponse: scored.rawResponse,
      });
      logScores(id, url, scored.scores, scored.reasons);
      logTaskStep(id, `URL ${index + 1}/${task.urls.length} 打分完成`, {
        url,
        scores: scored.scores,
        total: scored.scores.reduce((sum, score) => sum + score, 0),
      });
    }

    const updated = updateTask(id, { status: "scored", error: undefined });
    logTaskStep(id, "评分任务完成", { results: listResults(id).length });
    return NextResponse.json({ task: updated, results: listResults(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "评分任务失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function createEvidencePlanForTask(
  settings: Settings,
  prompt: string,
  rubrics: Rubric[],
  taskId: string,
): Promise<EvidencePlanStep[]> {
  try {
    logTaskStep(taskId, "开始生成 AI 证据计划", { rubrics: rubrics.length });
    const plan = await generateEvidencePlan(settings, prompt, rubrics);
    logTaskStep(taskId, "AI 证据计划生成成功", {
      steps: plan.length,
      actions: plan.map((step) => ({ rubricId: step.rubricId, action: step.action, hints: step.targetHints })),
    });
    return plan;
  } catch (error) {
    logTaskStep(taskId, "AI 证据计划生成失败，降级使用固定探测器", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
