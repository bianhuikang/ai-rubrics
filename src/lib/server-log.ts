import type { PageEvidence, Rubric } from "./types";
import { saveTaskLog } from "./db";

export function logTaskStep(taskId: string, message: string, extra?: unknown) {
  try {
    saveTaskLog({ taskId, message, extra });
  } catch (error) {
    console.warn(`[judge][task:${taskId}] failed to persist task log`, error);
  }
  console.log(`[judge][task:${taskId}] ${message}`);
  if (extra !== undefined) {
    console.log(typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  }
}

export function logEvidence(taskId: string, evidence: PageEvidence) {
  const presentRequired = evidence.requiredElements.filter((item) => item.exists).length;
  const missingRequired = evidence.requiredElements.filter((item) => !item.exists).map((item) => item.selector);

  console.log(`[judge][${taskId}] evidence collected`);
  console.log(
    JSON.stringify(
      {
        url: evidence.url,
        finalUrl: evidence.finalUrl,
        title: evidence.title,
        visibleTextSample: evidence.visibleText.slice(0, 800),
        requiredElements: {
          total: evidence.requiredElements.length,
          present: presentRequired,
          missing: missingRequired,
        },
        controls: evidence.controls.slice(0, 30),
        layout: evidence.layout,
        interactions: evidence.interactions,
        rubricEvidence: evidence.rubricEvidence.map((item) => ({
          rubricId: item.rubricId,
          keywords: item.keywords,
          textMatches: item.textMatches.length,
          controls: item.controls.length,
          elements: item.elements.length,
          technologyMatches: item.technologyMatches,
          relatedInteractions: item.relatedInteractions.map((probe) => probe.name),
          plannedChecks: (item.plannedChecks || []).map((check) => ({
            action: check.action,
            passed: check.passed,
          })),
        })),
        screenshotPath: evidence.screenshotPath,
        errors: evidence.errors,
      },
      null,
      2,
    ),
  );
}

export function logRubrics(taskId: string, rubrics: Rubric[]) {
  console.log(`\n[judge][${taskId}] ===== RUBRICS GENERATED (${rubrics.length}) =====`);
  console.log(rubrics.map((rubric, index) => `${index + 1}. ${rubric.description}`).join("\n"));
  console.log(`[judge][${taskId}] ===== RUBRICS JSON =====`);
  console.log(JSON.stringify(rubrics, null, 2));
  console.log(`[judge][${taskId}] ===== END RUBRICS =====\n`);
}

export function logScores(taskId: string, url: string, scores: number[], reasons: string[]) {
  console.log(`[judge][${taskId}] scored ${url}`);
  console.log(JSON.stringify({ scores, reasons }, null, 2));
}
