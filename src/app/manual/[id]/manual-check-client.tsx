"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ScoreResult, Task } from "@/lib/types";

type ManualCheckClientProps = {
  taskId: string;
  url: string;
  qaRubrics?: string;
};

type ManualDraft = {
  scores: number[];
  reasons: string[];
  answeredCount: number;
  updatedAt?: string;
};

const MANUAL_TARGET_FRAME_ALLOW = [
  "accelerometer *",
  "ambient-light-sensor *",
  "autoplay *",
  "camera *",
  "clipboard-read *",
  "clipboard-write *",
  "compute-pressure *",
  "display-capture *",
  "document-domain *",
  "encrypted-media *",
  "execution-while-not-rendered *",
  "execution-while-out-of-viewport *",
  "fullscreen *",
  "gamepad *",
  "geolocation *",
  "gyroscope *",
  "hid *",
  "identity-credentials-get *",
  "idle-detection *",
  "local-fonts *",
  "magnetometer *",
  "microphone *",
  "midi *",
  "otp-credentials *",
  "payment *",
  "picture-in-picture *",
  "publickey-credentials-get *",
  "screen-wake-lock *",
  "serial *",
  "speaker-selection *",
  "storage-access *",
  "sync-xhr *",
  "usb *",
  "web-share *",
  "window-management *",
  "xr-spatial-tracking *",
].join("; ");

export function ManualCheckClient({ taskId, url, qaRubrics = "" }: ManualCheckClientProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [scores, setScores] = useState<number[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [pendingFailIndex, setPendingFailIndex] = useState<number | null>(null);
  const [pendingPageFail, setPendingPageFail] = useState(false);
  const [failReason, setFailReason] = useState("");
  const [pageFailReason, setPageFailReason] = useState("");
  const [lastChoice, setLastChoice] = useState<number | null>(null);
  const [allDoneFlash, setAllDoneFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [qualityRubricIndexes, setQualityRubricIndexes] = useState<number[]>([]);

  useEffect(() => {
    function syncQualityLocator() {
      const saved = window.localStorage.getItem(qualityLocatorStorageKey(taskId));
      setQualityRubricIndexes(saved ? parseQualityRubricIndexes(qaRubrics) : []);
    }

    syncQualityLocator();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === qualityLocatorStorageKey(taskId)) syncQualityLocator();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [qaRubrics, taskId]);

  useEffect(() => {
    async function load() {
      const [taskResponse, resultsResponse, draftResponse] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/results`),
        fetch(`/api/tasks/${taskId}/manual-draft?url=${encodeURIComponent(url)}`),
      ]);
      if (!taskResponse.ok) throw new Error(await taskResponse.text());
      if (!resultsResponse.ok) throw new Error(await resultsResponse.text());
      if (!draftResponse.ok) throw new Error(await draftResponse.text());

      const nextTask = (await taskResponse.json()) as Task;
      const resultData = (await resultsResponse.json()) as { results: ScoreResult[] };
      const draftData = (await draftResponse.json()) as { draft: ManualDraft | null };
      const existing = resultData.results.find((result) => result.url === url);
      const draft = draftData.draft;
      const useDraft = Boolean(draft && (!existing || new Date(draft.updatedAt ?? 0).getTime() > new Date(existing.createdAt).getTime()));
      const nextScores = (useDraft ? draft?.scores : existing?.scores) ?? nextTask.rubrics.map(() => 0);
      const nextReasons = ensureReasonLength((useDraft ? draft?.reasons : existing?.reasons) ?? undefined, nextTask.rubrics.length);
      const nextAnsweredCount = useDraft || !existing ? firstUnansweredIndex(nextReasons, nextTask.rubrics.length) : nextTask.rubrics.length;
      const firstQualityIndex = qualityRubricIndexes.find((index) => index < nextTask.rubrics.length);

      setTask(nextTask);
      setResults(resultData.results);
      setScores(nextScores);
      setReasons(nextReasons);
      setAnsweredCount(nextAnsweredCount);
      setCurrentIndex(firstQualityIndex ?? Math.min(nextAnsweredCount, nextTask.rubrics.length));
      if (useDraft && !existing) {
        if (nextTask.rubrics.length > 0 && nextAnsweredCount >= nextTask.rubrics.length) {
          void saveManualScore(nextScores, nextReasons);
        }
      }
      setNotice(existing && !useDraft ? "已完成" : useDraft ? "已恢复服务端进度" : "");
    }

    load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [taskId, url, qualityRubricIndexes]);

  const completedCount = useMemo(() => reasons.filter((reason) => reason.trim()).length, [reasons]);
  const failReasonSuggestions = useMemo(() => {
    if (!task || pendingFailIndex !== currentIndex) return [];
    const currentUrlIndex = task.urls.findIndex((item) => item === url);
    if (currentUrlIndex <= 0) return [];

    const uniqueReasons: string[] = [];
    const seen = new Set<string>();
    for (const taskUrl of task.urls.slice(0, currentUrlIndex)) {
      const result = results.find((item) => item.url === taskUrl);
      if (!result || result.scores[currentIndex] !== 0) continue;
      const reason = result?.reasons[currentIndex]?.trim();
      if (!reason || reason === "人工标记符合" || seen.has(reason)) continue;
      seen.add(reason);
      uniqueReasons.push(reason);
    }
    return uniqueReasons.slice(0, 12);
  }, [currentIndex, pendingFailIndex, results, task, url]);

  const scoreSummary = useMemo(() => {
    return `进度 ${completedCount}/${scores.length}`;
  }, [completedCount, scores.length]);

  const currentRubric = task?.rubrics[currentIndex];
  const showFailReason = pendingPageFail || pendingFailIndex === currentIndex;
  const isComplete = Boolean(task?.rubrics.length && completedCount >= task.rubrics.length && currentIndex >= task.rubrics.length);
  const nextUrl = task ? findNextUrl(task.urls, url) : null;
  const sourceZipUrl = getSourceZipUrl(url);

  async function saveManualScore(nextScores: number[], nextReasons: string[], nextPageFailReason?: string) {
    setSaving(true);
    setNotice("保存中...");
    try {
      const response = await fetch(`/api/tasks/${taskId}/manual-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, scores: nextScores, reasons: nextReasons, pageFailReason: nextPageFailReason }),
      });
      if (!response.ok) throw new Error(await response.text());

      const data = (await response.json()) as { task: Task; results: ScoreResult[] };
      setTask(data.task);
      setResults(data.results);
      const nextPageUrl = findNextUrl(data.task.urls, url);
      if (nextPageUrl) {
        setNotice("已完成并保存，打开下一页...");
        window.setTimeout(() => {
          window.location.href = `/manual/${encodeURIComponent(taskId)}?url=${encodeURIComponent(nextPageUrl)}`;
        }, 350);
      } else {
        setNotice("恭喜，所有页面检查完成");
        setAllDoneFlash(true);
        window.setTimeout(() => setAllDoneFlash(false), 1800);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveManualDraft(nextScores: number[], nextReasons: string[], nextAnsweredCount: number) {
    const response = await fetch(`/api/tasks/${taskId}/manual-draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, scores: nextScores, reasons: nextReasons, answeredCount: nextAnsweredCount }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = (await response.json()) as { draft: ManualDraft };
    return data.draft;
  }

  async function commitAnswer(score: number, reason: string) {
    if (!task || currentIndex >= task.rubrics.length) return;

    const nextScores = scores.map((current, index) => (index === currentIndex ? score : current));
    const nextReasons = reasons.map((current, index) => (index === currentIndex ? reason : current));
    const nextAnsweredCount = Math.max(answeredCount, firstUnansweredIndex(nextReasons, task.rubrics.length));
    const nextIndex = firstUnansweredIndex(nextReasons, task.rubrics.length);

    try {
      setSaving(true);
      setLastChoice(score);
      setNotice("保存中...");

      if (nextIndex >= task.rubrics.length) {
        setScores(nextScores);
        setReasons(nextReasons);
        setAnsweredCount(nextAnsweredCount);
        setCurrentIndex(nextIndex);
        setPendingFailIndex(null);
        setPendingPageFail(false);
        setFailReason("");
        setPageFailReason("");
        await saveManualScore(nextScores, nextReasons);
        return;
      }

      const savedDraft = await saveManualDraft(nextScores, nextReasons, nextAnsweredCount);
      const savedReasons = ensureReasonLength(savedDraft.reasons, task.rubrics.length);
      const savedIndex = firstUnansweredIndex(savedReasons, task.rubrics.length);
      setScores(savedDraft.scores);
      setReasons(savedReasons);
      setAnsweredCount(savedDraft.answeredCount);
      setCurrentIndex(savedIndex);
      setPendingFailIndex(null);
      setPendingPageFail(false);
      setFailReason("");
      setPageFailReason("");
      setNotice(score ? "已记录并保存，继续下一条" : "已记录原因并保存，继续下一条");
      window.setTimeout(() => setLastChoice(null), 220);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function answerPass() {
    void commitAnswer(1, "人工标记符合");
  }

  function answerFail() {
    if (!task) return;
    setLastChoice(0);
    setPendingFailIndex(currentIndex);
    setFailReason(reasons[currentIndex] || "");
    setNotice("请填写不符合理由");
  }

  function submitFailReason() {
    const reason = failReason.trim();
    if (!reason) {
      setNotice("请填写不符合理由");
      return;
    }
    if (pendingFailIndex !== currentIndex) return;
    void commitAnswer(0, reason);
  }

  function answerAllFail() {
    if (!task) return;
    setLastChoice(0);
    setPendingFailIndex(null);
    setPendingPageFail(true);
    setPageFailReason("");
    setNotice("请输入页面全不符合理由");
  }

  function submitPageFailReason() {
    if (!task) return;
    const reason = pageFailReason.trim();
    if (!reason) {
      setNotice("请输入页面全不符合理由");
      return;
    }
    const nextScores = task.rubrics.map(() => 0);
    const nextReasons = task.rubrics.map(() => reason);
    setScores(nextScores);
    setReasons(nextReasons);
    setAnsweredCount(task.rubrics.length);
    setCurrentIndex(task.rubrics.length);
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setPageFailReason("");
    void saveManualScore(nextScores, nextReasons, reason);
  }

  function cancelFailReason() {
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setFailReason("");
    setPageFailReason("");
    setLastChoice(null);
    setNotice("");
  }

  function jumpToRubric(index: number) {
    if (!task || index < 0 || index >= task.rubrics.length) return;
    setCurrentIndex(index);
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setFailReason("");
    setPageFailReason("");
    setLastChoice(null);
    setNotice(`已回到第 ${index + 1} 条`);
  }

  async function restartCheck() {
    if (!task) return;
    const nextScores = task.rubrics.map(() => 0);
    const nextReasons = task.rubrics.map(() => "");
    try {
      setSaving(true);
      await saveManualDraft(nextScores, nextReasons, 0);
      setScores(nextScores);
      setReasons(nextReasons);
      setAnsweredCount(0);
      setCurrentIndex(0);
      setPendingFailIndex(null);
      setPendingPageFail(false);
      setFailReason("");
      setPageFailReason("");
      setNotice("已重置并保存服务端进度");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function suppressSpaceActivation(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
    }
  }

  if (!url) {
    return <main className="manual-page-error">缺少 URL。</main>;
  }

  return (
    <main className="manual-check-page">
      <aside className={`manual-check-bar ${showFailReason ? "with-fail-reason" : ""} ${allDoneFlash ? "all-done-flash" : ""}`}>
        <div className="manual-check-meta">
          <div className="manual-meta-title">
            <strong>手工检查</strong>
            {sourceZipUrl ? (
              <a className="manual-source-link" href={sourceZipUrl} download target="_blank" rel="noreferrer">
                下载源码
              </a>
            ) : null}
          </div>
          <span title={taskId}>{taskId}</span>
          <em>{scoreSummary}</em>
          {task?.rubrics.length ? (
            <div className="manual-score-dots" aria-label="当前页面评分进度">
              {task.rubrics.map((rubric, index) => {
                const done = Boolean(reasons[index]?.trim());
                const score = scores[index] ? 1 : 0;
                return (
                  <button
                    key={rubric.id}
                    className={[
                      "manual-score-dot",
                      done ? (score ? "pass" : "fail") : "todo",
                      currentIndex === index ? "active" : "",
                      qualityRubricIndexes.includes(index) ? "quality-target-dot" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => jumpToRubric(index)}
                    title={`第 ${index + 1} 条：${done ? score : "未检查"}`}
                    type="button"
                  >
                    {done ? score : ""}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className={`manual-rubrics ${showFailReason ? "with-fail-reason" : ""}`}>
          {currentRubric ? (
            <div className={`manual-rubric-focus ${pendingFailIndex === currentIndex || pendingPageFail ? "with-reason" : ""}`}>
              <p>
                {pendingPageFail ? (
                  "当前页面全部不符合"
                ) : (
                  <>
                    <strong>{currentIndex + 1}.</strong> {currentRubric.description}
                  </>
                )}
              </p>
              {pendingPageFail ? (
                <div className="manual-fail-reason">
                  <input
                    autoFocus
                    value={pageFailReason}
                    onChange={(event) => setPageFailReason(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitPageFailReason();
                    }}
                    placeholder="页面全部不符合理由"
                  />
                  <button className="manual-rubric-toggle fail-choice" onClick={submitPageFailReason} disabled={saving} type="button">
                    确认
                  </button>
                  <button className="manual-rubric-toggle" onClick={cancelFailReason} disabled={saving} type="button">
                    取消
                  </button>
                </div>
              ) : pendingFailIndex === currentIndex ? (
                <div className="manual-fail-reason">
                  <div className="manual-fail-reason-field">
                    <input
                      autoFocus
                      value={failReason}
                      onChange={(event) => setFailReason(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitFailReason();
                      }}
                      placeholder="不符合理由"
                    />
                    {failReasonSuggestions.length ? (
                      <div className="manual-fail-suggestions" role="listbox" aria-label="历史理由">
                        {failReasonSuggestions.map((reason) => (
                          <button
                            key={reason}
                            className="manual-fail-suggestion"
                            onClick={() => setFailReason(reason)}
                            type="button"
                          >
                            {reason}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button className="manual-rubric-toggle fail-choice" onClick={submitFailReason} disabled={saving} type="button">
                    确认
                  </button>
                  <button className="manual-rubric-toggle" onClick={cancelFailReason} disabled={saving} type="button">
                    取消
                  </button>
                </div>
              ) : (
                <div className="manual-answer-buttons">
                  <button
                    className={`manual-rubric-toggle fail-choice ${lastChoice === 0 ? "just-picked" : ""}`}
                    onClick={answerFail}
                    onKeyDown={suppressSpaceActivation}
                    disabled={saving}
                    type="button"
                  >
                    不符合
                  </button>
                  <button
                    className={`manual-rubric-toggle pass-choice ${lastChoice === 1 ? "just-picked" : ""}`}
                    onClick={answerPass}
                    onKeyDown={suppressSpaceActivation}
                    disabled={saving}
                    type="button"
                  >
                    符合
                  </button>
                  <button
                    className="manual-rubric-toggle page-fail-choice"
                    onClick={answerAllFail}
                    onKeyDown={suppressSpaceActivation}
                    disabled={saving}
                    type="button"
                  >
                    全不符合
                  </button>
                </div>
              )}
            </div>
          ) : isComplete ? (
            <div className="manual-rubric-focus complete">
              <p>当前页面已检查完成。</p>
              <div className="manual-answer-buttons">
                <button className="manual-rubric-toggle" onClick={() => void restartCheck()} disabled={saving} type="button">
                  重新检查
                </button>
                {nextUrl ? (
                  <button
                    className="manual-rubric-toggle"
                    onClick={() => {
                      window.location.href = `/manual/${encodeURIComponent(taskId)}?url=${encodeURIComponent(nextUrl)}`;
                    }}
                    disabled={saving}
                    type="button"
                  >
                    下一个页面
                  </button>
                ) : null}
              </div>
            </div>
          ) : task ? (
            <span className="manual-muted">没有 rubrics。</span>
          ) : (
            <span className="manual-muted">加载 rubrics...</span>
          )}
        </div>
        <div className="manual-check-actions">
          <span>{notice}</span>
          <span>{results.length ? `已完成页面检查：${results.length}/${task?.urls.length ?? 0}` : ""}</span>
        </div>
        {allDoneFlash ? <div className="manual-complete-toast">恭喜，所有页面检查完成</div> : null}
      </aside>

      <iframe
        allow={MANUAL_TARGET_FRAME_ALLOW}
        allowFullScreen
        className="manual-target-frame"
        src={url}
        title="manual target page"
      />
    </main>
  );
}

function ensureReasonLength(value: string[] | undefined, count: number) {
  return Array.from({ length: count }, (_item, index) => value?.[index] ?? "");
}

function firstUnansweredIndex(reasons: string[], count: number) {
  const index = reasons.findIndex((reason, reasonIndex) => reasonIndex < count && !reason.trim());
  return index >= 0 ? index : count;
}

function findNextUrl(urls: string[], currentUrl: string) {
  const currentIndex = urls.findIndex((item) => item === currentUrl);
  if (currentIndex < 0) return null;
  return urls[currentIndex + 1] ?? null;
}

function getSourceZipUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/index\.html$/i, "code_files.zip");
    return parsed.pathname.endsWith("code_files.zip") ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function parseQualityRubricIndexes(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((index) => Number.isInteger(index) && index >= 0),
    ),
  );
}

function qualityLocatorStorageKey(taskId: string) {
  return `ai-rubrics-quality-locator:${taskId}`;
}
