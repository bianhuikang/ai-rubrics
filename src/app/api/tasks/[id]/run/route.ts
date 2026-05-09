import { NextResponse } from "next/server";
import { collectPageEvidence } from "@/lib/collector";
import { deleteResultsForTask, deleteTaskLogsForTask, getSettings, getTask, listResults, saveResult, updateTask } from "@/lib/db";
import { generateEvidencePlan, generateRubrics, scorePage } from "@/lib/llm";
import { logEvidence, logRubrics, logScores, logTaskStep } from "@/lib/server-log";
import type { EvidencePlanStep, PageEvidence, Rubric, Settings } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const settings = getSettings();

  try {
    const previousEvidence = new Map(listResults(id).map((result) => [result.url, result.evidence]));
    deleteTaskLogsForTask(id);
    logTaskStep(id, "开始执行任务", { urls: task.urls.length });
    logTaskStep(id, `解析到 URL ${task.urls.length} 个`, { urls: task.urls });
    if (previousEvidence.size) {
      logTaskStep(id, `发现历史页面证据 ${previousEvidence.size} 条，将优先复用可匹配证据`, {
        reused: task.urls.filter((url) => previousEvidence.has(url)).length,
      });
    }
    deleteResultsForTask(id);
    updateTask(id, { status: "generating-rubrics", error: undefined });

    let rubrics = task.rubricsSource === "user" ? task.rubrics : [];
    let rubricsSource = task.rubricsSource;
    if (rubrics.length) {
      logTaskStep(id, "使用用户输入 rubrics，跳过自动生成", { count: rubrics.length });
    } else {
      if (task.rubrics.length) {
        logTaskStep(id, "忽略上一次自动生成 rubrics，本次重新生成", { previous: task.rubrics.length });
      }
      logTaskStep(id, "开始生成 rubrics");
      rubrics = await generateRubrics(settings, task.prompt, []);
      rubricsSource = "generated";
      logRubrics(id, rubrics);
      logTaskStep(id, "rubrics 生成成功", { count: rubrics.length });
    }
    const taskWithRubrics = updateTask(id, {
      rubrics,
      rubricsSource,
      status: task.mode === "manual" ? "rubrics-ready" : "scoring",
      error: undefined,
    });

    if (taskWithRubrics.mode === "manual") {
      logTaskStep(id, "手动检查模式已准备完成，等待人工打分", {
        urls: taskWithRubrics.urls.length,
        rubrics: taskWithRubrics.rubrics.length,
      });
      return NextResponse.json({ task: taskWithRubrics, results: listResults(id) });
    }

    const evidencePlan = await createEvidencePlanForTask(settings, taskWithRubrics.prompt, taskWithRubrics.rubrics, id);

    const collected: Array<{ url: string; evidence: PageEvidence }> = [];
    for (const [index, url] of taskWithRubrics.urls.entries()) {
      try {
        const cached = previousEvidence.get(url);
        const cachedMatchesRubrics = cached?.rubricEvidence?.length === taskWithRubrics.rubrics.length;
        const cachedPlanResultCount = cached?.rubricEvidence?.reduce((sum, item) => sum + (item.plannedChecks || []).length, 0) || 0;
        const cachedHasPlanResults =
          evidencePlan.length === 0 || cachedPlanResultCount >= Math.min(evidencePlan.length, taskWithRubrics.rubrics.length);
        if (cached && cachedMatchesRubrics && cachedHasPlanResults) {
          logTaskStep(id, `复用历史页面证据 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
          collected.push({ url, evidence: cached });
          continue;
        }
        if (cached && !cachedMatchesRubrics) {
          logTaskStep(id, `历史证据缺少 rubrics 定向抓取，重新抓取 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
        }

        logTaskStep(id, `按 rubrics 抓取候选产物 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
        const evidence = await collectPageEvidence({
          url,
          prompt: taskWithRubrics.prompt,
          taskId: taskWithRubrics.id,
          index,
          rubrics: taskWithRubrics.rubrics,
          evidencePlan,
        });
        logEvidence(id, evidence);
        logTaskStep(id, `候选产物抓取成功 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
        collected.push({ url, evidence });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logTaskStep(id, `候选产物抓取失败 ${index + 1}/${taskWithRubrics.urls.length}`, {
          url,
          error: message,
        });
        collected.push({ url, evidence: failedEvidence(url, message) });
      }
    }

    for (const [index, collectedItem] of collected.entries()) {
      const { url, evidence } = collectedItem;
      logTaskStep(id, `开始对 URL ${index + 1}/${collected.length} 打分`, { url });
      logTaskStep(id, `调用模型评分 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
      const scored = await scorePage({
        settings,
        prompt: taskWithRubrics.prompt,
        rubrics: taskWithRubrics.rubrics,
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
      logTaskStep(id, `URL ${index + 1}/${collected.length} 打分完成`, {
        url,
        scores: scored.scores,
        total: scored.scores.reduce((sum, score) => sum + score, 0),
      });
    }

    const updated = updateTask(id, { status: "scored", error: undefined });
    logTaskStep(id, "任务执行完成", {
      urls: updated.urls.length,
      rubrics: updated.rubrics.length,
      results: listResults(id).length,
    });
    return NextResponse.json({ task: updated, results: listResults(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "任务执行失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function failedEvidence(url: string, error: string): PageEvidence {
  return {
    url,
    finalUrl: url,
    title: "",
    htmlSample: "",
    visibleText: "",
    requirements: { ids: [], classes: [] },
    requiredElements: [],
    importantElements: [],
    controls: [],
    layout: {},
    visual: {},
    technology: {},
    responsive: {},
    motion: {},
    interactions: [],
    rubricEvidence: [],
    errors: [`Collection failed: ${error}`],
  };
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
