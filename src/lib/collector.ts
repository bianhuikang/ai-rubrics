import fs from "node:fs";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { extractSelectorRequirements, trimForPrompt } from "./requirement-parser";
import type { ElementEvidence, EvidencePlanResult, EvidencePlanStep, InteractionProbe, PageEvidence, Rubric, RubricEvidence } from "./types";

const IMPORTANT_SELECTORS = [
  "header",
  "nav",
  "main",
  "footer",
  "canvas",
  "svg",
  "#navbar",
  "#doc-list",
  "#editor-area",
  "#collab-panel",
  "#doc-title",
  "#rich-editor",
  "#save-btn",
  "#create-doc-btn",
  "#comment-input",
];

export async function collectPageEvidence(input: {
  url: string;
  prompt: string;
  taskId: string;
  index: number;
  rubrics?: Rubric[];
  evidencePlan?: EvidencePlanStep[];
}): Promise<PageEvidence> {
  const browser = await chromium.launch({ headless: true });
  const requirements = extractSelectorRequirements(input.prompt);
  const errors: string[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });

    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const screenshotPath = await saveScreenshot(page, input.taskId, input.index);
    const finalUrl = page.url();
    const html = await page.content();
    const requiredElements = await collectRequiredElements(page, requirements.ids, requirements.classes);
    const pageFacts = await collectPageFacts(page);
    const motion = await collectMotionEvidence(page);
    const responsive = await collectResponsiveEvidence(page);
    const interactions = await runInteractionProbes(page, input.prompt, input.rubrics ?? []);
    const planResults = await executeEvidencePlan(page, input.evidencePlan ?? []);
    const rubricEvidence = collectRubricEvidence(input.rubrics ?? [], pageFacts, interactions, planResults);

    return {
      url: input.url,
      finalUrl,
      title: pageFacts.title,
      htmlSample: trimForPrompt(html, 24000),
      visibleText: trimForPrompt(pageFacts.visibleText, 16000),
      screenshotPath,
      requirements,
      requiredElements,
      importantElements: pageFacts.importantElements,
      controls: pageFacts.controls,
      layout: pageFacts.layout,
      visual: pageFacts.visual,
      technology: pageFacts.technology,
      responsive,
      motion,
      interactions,
      rubricEvidence,
      errors,
    };
  } finally {
    await browser.close();
  }
}

async function collectPageFacts(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };

    const classNameOf = (element: Element) => {
      const value = (element as Element & { className?: unknown }).className;
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && "baseVal" in value) {
        return String((value as { baseVal?: string }).baseVal || "");
      }
      return value == null ? "" : String(value);
    };

    const textOf = (element: Element, maxLength = 160) =>
      (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, maxLength);

    const elementSummary = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        id: (element as HTMLElement).id || "",
        className: classNameOf(element),
        text: textOf(element),
        role: element.getAttribute("role"),
        visible: visible(element),
        box: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
      };
    };

    const canvasSignature = (canvas: HTMLCanvasElement) => {
      try {
        const probe = document.createElement("canvas");
        probe.width = 32;
        probe.height = 32;
        const context = probe.getContext("2d", { willReadFrequently: true });
        if (!context) return { nonBlank: null, hash: "", error: "2d probe unavailable" };
        context.drawImage(canvas, 0, 0, 32, 32);
        const data = context.getImageData(0, 0, 32, 32).data;
        let hash = 0;
        let nonBlank = false;
        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3] || 0;
          const color = (data[index] || 0) + (data[index + 1] || 0) + (data[index + 2] || 0);
          if (alpha > 0 && color > 0) nonBlank = true;
          hash = (hash + data[index] * 3 + data[index + 1] * 5 + data[index + 2] * 7 + alpha * 11) % 1000000007;
        }
        return { nonBlank, hash: String(hash) };
      } catch (error) {
        return { nonBlank: null, hash: "", error: error instanceof Error ? error.message : String(error) };
      }
    };

    const selectorLayout = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        selector,
        tag: element.tagName.toLowerCase(),
        display: style.display,
        position: style.position,
        flex: style.flex,
        width: Math.round(box.width),
        height: Math.round(box.height),
        x: Math.round(box.x),
        y: Math.round(box.y),
        visible: visible(element),
      };
    };

    const controls = Array.from(
      document.querySelectorAll("button, input, textarea, select, a[href], [role='button'], [contenteditable='true']"),
    )
      .slice(0, 160)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: (element as HTMLElement).id || "",
        className: classNameOf(element),
        text: textOf(element),
        href: element.getAttribute("href"),
        type: element.getAttribute("type"),
        placeholder: element.getAttribute("placeholder"),
        role: element.getAttribute("role"),
        visible: visible(element),
      }));

    const importantElements = Array.from(
      document.querySelectorAll(
        "[id], header, nav, main, footer, section, button, input, textarea, select, a[href], canvas, svg, img, [role], [contenteditable='true']",
      ),
    )
      .slice(0, 220)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: (element as HTMLElement).id || "",
        className: classNameOf(element),
        text: textOf(element),
        role: element.getAttribute("role"),
      }));

    const canvases = Array.from(document.querySelectorAll("canvas"))
      .slice(0, 30)
      .map((canvas) => ({
        ...elementSummary(canvas),
        width: canvas.width,
        height: canvas.height,
        signature: canvasSignature(canvas),
      }));

    const svgs = Array.from(document.querySelectorAll("svg"))
      .slice(0, 30)
      .map((svg) => ({
        ...elementSummary(svg),
        childCount: svg.querySelectorAll("*").length,
        shapeCount: svg.querySelectorAll("path, circle, rect, line, polyline, polygon, text, g").length,
        viewBox: svg.getAttribute("viewBox"),
      }));

    const images = Array.from(document.querySelectorAll("img, picture, video"))
      .slice(0, 80)
      .map((element) => ({
        ...elementSummary(element),
        src: (element as HTMLImageElement | HTMLVideoElement).currentSrc || (element as HTMLImageElement).src || "",
        alt: element.getAttribute("alt"),
      }));

    const scriptSources = Array.from(document.scripts)
      .slice(0, 120)
      .map((script) => script.src || (script.textContent || "").slice(0, 240));
    const win = window as Window & {
      React?: unknown;
      Vue?: unknown;
      d3?: unknown;
      dat?: unknown;
      datGui?: unknown;
      gsap?: unknown;
      THREE?: unknown;
      XLSX?: unknown;
    };

    return {
      title: document.title,
      visibleText: (document.body?.innerText || "").replace(/\s+/g, " ").trim(),
      controls,
      importantElements,
      layout: {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: {
          bodyScrollWidth: document.body?.scrollWidth || 0,
          bodyScrollHeight: document.body?.scrollHeight || 0,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentScrollHeight: document.documentElement.scrollHeight,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          verticalOverflow: document.documentElement.scrollHeight > window.innerHeight + 2,
          bodyOverflow: document.body ? window.getComputedStyle(document.body).overflow : "",
          htmlOverflow: window.getComputedStyle(document.documentElement).overflow,
        },
        body: selectorLayout("body"),
        header: selectorLayout("header"),
        nav: selectorLayout("nav"),
        main: selectorLayout("main"),
        footer: selectorLayout("footer"),
        navbar: selectorLayout("#navbar"),
        docList: selectorLayout("#doc-list"),
        editorArea: selectorLayout("#editor-area"),
        collabPanel: selectorLayout("#collab-panel"),
      },
      visual: {
        canvasCount: canvases.length,
        svgCount: svgs.length,
        imageLikeCount: images.length,
        canvases,
        svgs,
        images,
      },
      technology: {
        scriptSources: scriptSources.slice(0, 40),
        detected: {
          react: Boolean(win.React || document.querySelector("[data-reactroot], [data-nextjs-root], #__next")),
          vue: Boolean(win.Vue),
          d3: Boolean(win.d3 || scriptSources.some((source) => /d3/i.test(source))),
          datGui: Boolean(win.dat || win.datGui || document.querySelector(".dg.ac")),
          gsap: Boolean(win.gsap || scriptSources.some((source) => /gsap|TweenMax|TweenLite/i.test(source))),
          three: Boolean(win.THREE || scriptSources.some((source) => /three/i.test(source))),
          sheetjs: Boolean(win.XLSX || scriptSources.some((source) => /sheetjs|xlsx/i.test(source))),
          canvas: canvases.length > 0,
          svg: svgs.length > 0,
        },
      },
    };
  });
}

async function collectMotionEvidence(page: Page) {
  const before = await readRuntimeSignature(page);
  await page.waitForTimeout(900);
  const after = await readRuntimeSignature(page);
  const animations = await page.evaluate(() =>
    document
      .getAnimations()
      .slice(0, 30)
      .map((animation) => {
        const effect = animation.effect;
        const target = effect && "target" in effect ? (effect.target as Element | null) : null;
        return {
          playState: animation.playState,
          currentTime: typeof animation.currentTime === "number" ? Math.round(animation.currentTime) : animation.currentTime,
          target: target
            ? {
                tag: target.tagName.toLowerCase(),
                id: (target as HTMLElement).id || "",
                className: (target as HTMLElement).className?.toString() || "",
              }
            : null,
        };
      }),
  );

  return {
    animationCount: animations.length,
    animations,
    canvasChanged: before.canvasHash !== after.canvasHash,
    styleChanged: before.styleHash !== after.styleHash,
    before,
    after,
  };
}

async function collectResponsiveEvidence(page: Page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const mobile = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const topElements = Array.from(document.querySelectorAll("header, nav, main, footer, canvas, svg, img, button, a[href]"))
      .slice(0, 80)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: (element as HTMLElement).id || "",
          text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          visible: visible(element),
          box: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
        };
      });

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      visibleTextLength: (document.body?.innerText || "").trim().length,
      visibleControlCount: Array.from(
        document.querySelectorAll("button, input, textarea, select, a[href], [role='button']"),
      ).filter(visible).length,
      topElements,
    };
  });
  if (original) await page.setViewportSize(original);
  return { mobile };
}

async function readRuntimeSignature(page: Page) {
  return page.evaluate(() => {
    const canvasHash = Array.from(document.querySelectorAll("canvas"))
      .slice(0, 12)
      .map((canvas) => {
        try {
          const probe = document.createElement("canvas");
          probe.width = 24;
          probe.height = 24;
          const context = probe.getContext("2d", { willReadFrequently: true });
          if (!context) return "";
          context.drawImage(canvas, 0, 0, 24, 24);
          const data = context.getImageData(0, 0, 24, 24).data;
          let hash = 0;
          for (let index = 0; index < data.length; index += 8) hash = (hash + data[index] * 3 + data[index + 3] * 11) % 1000003;
          return String(hash);
        } catch {
          return "";
        }
      })
      .join("|");
    const styleHash = Array.from(document.querySelectorAll("*"))
      .slice(0, 160)
      .map((element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return [
          element.tagName,
          (element as HTMLElement).id,
          style.transform,
          style.opacity,
          style.backgroundPosition,
          style.borderColor,
          Math.round(box.x),
          Math.round(box.y),
          Math.round(box.width),
          Math.round(box.height),
        ].join(":");
      })
      .join("|");
    return {
      url: location.href,
      textLength: (document.body?.innerText || "").length,
      elementCount: document.querySelectorAll("*").length,
      canvasHash,
      styleHash: String(hashString(styleHash)),
    };

    function hashString(value: string) {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
      return hash;
    }
  });
}

async function collectRequiredElements(page: Page, ids: string[], classes: string[]): Promise<ElementEvidence[]> {
  const selectors = [
    ...ids.map((id) => `#${cssEscape(id)}`),
    ...classes.map((className) => `.${cssEscape(className)}`),
    ...IMPORTANT_SELECTORS,
  ];
  const uniqueSelectors = Array.from(new Set(selectors));
  const result: ElementEvidence[] = [];

  for (const selector of uniqueSelectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) {
      result.push({ selector, exists: false, visible: false });
      continue;
    }
    const box = await locator.boundingBox().catch(() => null);
    const snapshot = await locator
      .evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
        className: (element as HTMLElement).className?.toString() || "",
      }))
      .catch(() => null);
    result.push({
      selector,
      exists: true,
      visible: Boolean(box && box.width > 0 && box.height > 0),
      tag: snapshot?.tag,
      text: snapshot?.text,
      className: snapshot?.className,
      box: box
        ? {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          }
        : undefined,
    });
  }

  return result;
}

async function runInteractionProbes(page: Page, prompt: string, rubrics: Rubric[]): Promise<InteractionProbe[]> {
  const probes: InteractionProbe[] = [];
  const requirementText = `${prompt}\n${rubrics.map((rubric) => `${rubric.name} ${rubric.description}`).join("\n")}`;
  const hasDocumentEditorHints =
    /doc-list|rich-editor|comment-input|create-doc|文档|协作|编辑器/i.test(requirementText) ||
    (await page.locator("#doc-list-items, #doc-title, #rich-editor, #comment-input").count().catch(() => 0)) > 0;

  if (hasDocumentEditorHints) {
    probes.push(await probeDocumentSwitch(page));
    probes.push(await probeCreateDocument(page));
    probes.push(await probeCommentEnter(page));
    probes.push(await probeEmptyTitleSave(page));
  }

  if (/excel|xlsx|sheetjs|上传|粘贴|导入|文件/i.test(requirementText)) {
    probes.push(await probeImportReadiness(page));
  }
  if (/倒计时|计时|时长|timer|countdown|用时/i.test(requirementText)) {
    probes.push(await probeTimerProgress(page));
  }
  if (/单词|拼写|逐字母|输入错误|即时反馈|下一题|word|spell|typing/i.test(requirementText)) {
    probes.push(await probeTextEntryFeedback(page));
  }
  if (/拖拽|拖动|drag|drop/i.test(requirementText)) {
    probes.push(await probeDragReactivity(page));
  }
  if (/导航|汉堡|菜单|移动端|mobile|hamburger|menu|nav/i.test(requirementText)) {
    probes.push(await probeMobileMenu(page));
  }
  if (/暗黑|主题|明暗|localStorage|theme|dark/i.test(requirementText)) {
    probes.push(await probeThemePersistence(page));
  }
  if (/表单|提交|保存|联系|邮箱|留言|校验|成功|form|submit|save|contact|email|message/i.test(requirementText)) {
    probes.push(await probeFormSubmitFeedback(page));
  }
  if (/项目|作品|portfolio|demo|repo|仓库|卡片/i.test(requirementText)) {
    probes.push(await probeProjectCards(page));
  }
  if (/youtube|视频|播放器|iframe|video/i.test(requirementText)) {
    probes.push(await probeVideoSection(page));
  }

  probes.push(await probePointerReactivity(page));
  probes.push(await probeButtonReactivity(page));
  return probes;
}

function collectRubricEvidence(
  rubrics: Rubric[],
  pageFacts: Awaited<ReturnType<typeof collectPageFacts>>,
  interactions: InteractionProbe[],
  planResults: EvidencePlanResult[],
): RubricEvidence[] {
  if (!rubrics.length) return [];

  const visibleText = pageFacts.visibleText || "";
  const scriptSources = Array.isArray(pageFacts.technology?.scriptSources) ? pageFacts.technology.scriptSources : [];
  const detectedTechnology = pageFacts.technology?.detected || {};

  return rubrics.map((rubric) => {
    const text = `${rubric.name} ${rubric.description} ${rubric.evidenceHints.join(" ")}`;
    const keywords = extractRubricKeywords(text);
    const textMatches = collectTextMatches(visibleText, keywords);
    const controls = pageFacts.controls
      .filter((control) => itemMatchesKeywords(control, keywords))
      .slice(0, 12)
      .map((control) => ({
        tag: control.tag,
        id: control.id,
        className: control.className,
        text: control.text,
        type: control.type,
        placeholder: control.placeholder,
        visible: control.visible,
      }));
    const elements = pageFacts.importantElements.filter((element) => itemMatchesKeywords(element, keywords)).slice(0, 16);
    const technologyMatches = collectTechnologyMatches(keywords, scriptSources, detectedTechnology);
    const relatedInteractions = interactions.filter((probe) => itemMatchesKeywords(probe, keywords));
    const plannedChecks = planResults.filter((result) => result.rubricId === rubric.id);

    return {
      rubricId: rubric.id,
      rubric: rubric.description,
      keywords,
      textMatches,
      controls,
      elements,
      technologyMatches,
      relatedInteractions,
      plannedChecks,
    };
  });
}

function extractRubricKeywords(text: string) {
  const lower = text.toLowerCase();
  const dictionary = [
    "Excel",
    "SheetJS",
    "xlsx",
    "上传",
    "粘贴",
    "导入",
    "文件",
    "单词",
    "练习",
    "时长",
    "倒计时",
    "计时",
    "中文",
    "释义",
    "逐字母",
    "拼写",
    "正确",
    "错误",
    "反馈",
    "自动跳转",
    "下一题",
    "结束",
    "统计",
    "正确率",
    "总用时",
    "响应式",
    "平板",
    "移动端",
    "导航",
    "菜单",
    "表单",
    "校验",
    "提交",
    "成功",
    "项目",
    "作品",
    "技能",
    "工具",
    "联系",
    "主题",
    "暗黑",
    "拖拽",
    "拖动",
    "Canvas",
    "SVG",
    "动画",
    "控制",
    "参数",
    "图表",
    "数据",
  ];
  const quoted = Array.from(text.matchAll(/[“"']([^“”"']{2,40})[”"']/g)).map((match) => match[1]);
  const latin = Array.from(text.matchAll(/[A-Za-z][A-Za-z0-9.+#/-]{1,}/g)).map((match) => match[0]);
  const matchedDictionary = dictionary.filter((keyword) => lower.includes(keyword.toLowerCase()));

  return Array.from(new Set([...matchedDictionary, ...quoted, ...latin]))
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function collectTextMatches(visibleText: string, keywords: string[]) {
  const matches: string[] = [];
  const normalized = visibleText.replace(/\s+/g, " ").trim();
  for (const keyword of keywords) {
    const index = normalized.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) continue;
    const start = Math.max(0, index - 60);
    const end = Math.min(normalized.length, index + keyword.length + 80);
    matches.push(normalized.slice(start, end));
    if (matches.length >= 10) break;
  }
  return Array.from(new Set(matches));
}

function itemMatchesKeywords(item: unknown, keywords: string[]) {
  const haystack = JSON.stringify(item).toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function collectTechnologyMatches(keywords: string[], scriptSources: string[], detected: Record<string, unknown>) {
  const matches: string[] = [];
  const sources = scriptSources.join("\n").toLowerCase();
  for (const keyword of keywords) {
    const lower = keyword.toLowerCase();
    if (sources.includes(lower)) matches.push(`script:${keyword}`);
    if (lower.includes("sheet") && sources.includes("xlsx")) matches.push("script:xlsx");
    if (lower.includes("canvas") && Boolean(detected.canvas)) matches.push("detected:canvas");
    if (lower.includes("svg") && Boolean(detected.svg)) matches.push("detected:svg");
    for (const [name, present] of Object.entries(detected)) {
      if (present && lower.includes(name.toLowerCase())) matches.push(`detected:${name}`);
    }
  }
  return Array.from(new Set(matches)).slice(0, 12);
}

async function executeEvidencePlan(page: Page, plan: EvidencePlanStep[]): Promise<EvidencePlanResult[]> {
  const steps = plan.slice(0, 32);
  const results: EvidencePlanResult[] = [];
  for (const step of steps) {
    try {
      results.push(await executeEvidenceStep(page, step));
    } catch (error) {
      results.push({
        ...step,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function executeEvidenceStep(page: Page, step: EvidencePlanStep): Promise<EvidencePlanResult> {
  const hints = normalizeHints(step.targetHints);
  switch (step.action) {
    case "scanText": {
      const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      const matched = findMatchedHints(text, hints);
      return finishStep(step, matched.length > 0, `Matched text hints: ${matched.join(", ") || "none"}.`);
    }
    case "checkLinks": {
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 200)
          .map((anchor) => ({
            text: (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            href: (anchor as HTMLAnchorElement).href,
          })),
      );
      const matched = links.filter((link) => matchesHints(`${link.text} ${link.href}`, hints));
      return finishStep(step, matched.length > 0, `Matched ${matched.length}/${links.length} links: ${summarizeItems(matched)}.`);
    }
    case "checkControls": {
      const controls = await readControls(page);
      const matched = controls.filter((control) => matchesHints(JSON.stringify(control), hints));
      return finishStep(step, matched.length > 0, `Matched ${matched.length}/${controls.length} controls: ${summarizeItems(matched)}.`);
    }
    case "checkIframe": {
      const embeds = await page.evaluate(() =>
        Array.from(document.querySelectorAll("iframe, video, embed, object, source"))
          .slice(0, 80)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            src: (element as HTMLIFrameElement | HTMLVideoElement | HTMLSourceElement).src || element.getAttribute("data-src") || "",
            title: element.getAttribute("title") || "",
          })),
      );
      const matched = embeds.filter((embed) => matchesHints(`${embed.tag} ${embed.src} ${embed.title}`, hints));
      return finishStep(step, matched.length > 0, `Matched ${matched.length}/${embeds.length} embeds: ${summarizeItems(matched)}.`);
    }
    case "readLocalStorage": {
      const entries = await page.evaluate(() =>
        Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
          const key = localStorage.key(index) || "";
          return [key, localStorage.getItem(key) || ""];
        })),
      );
      const serialized = JSON.stringify(entries);
      const matched = hints.length ? findMatchedHints(serialized, hints) : Object.keys(entries);
      return finishStep(step, matched.length > 0, `localStorage keys=${Object.keys(entries).join(", ") || "none"}; matched=${matched.join(", ") || "none"}.`);
    }
    case "click": {
      const target = await findTarget(page, hints, "button, a[href], [role='button'], input[type='button'], input[type='submit'], label");
      if (!target) return finishStep(step, false, `No clickable target found for hints: ${hints.join(", ")}.`);
      const before = await readRuntimeSignature(page);
      const repeat = Math.max(1, Math.min(20, step.repeat || 1));
      for (let index = 0; index < repeat; index += 1) {
        await target.click({ timeout: 1600 }).catch(async () => target.dispatchEvent("click", { timeout: 1600 }));
        await page.waitForTimeout(120);
      }
      const after = await readRuntimeSignature(page);
      return finishStep(step, signatureChanged(before, after), `Clicked target ${repeat} time(s); state changed=${signatureChanged(before, after)}.`);
    }
    case "hover": {
      const target = await findTarget(page, hints, "a[href], button, [role='button'], article, section, .card, [class*='card'], [class*='project']");
      if (!target) return finishStep(step, false, `No hover target found for hints: ${hints.join(", ")}.`);
      const before = await readRuntimeSignature(page);
      await target.hover({ timeout: 1600 });
      await page.waitForTimeout(350);
      const after = await readRuntimeSignature(page);
      return finishStep(step, signatureChanged(before, after), `Hovered target; state changed=${signatureChanged(before, after)}.`);
    }
    case "fill": {
      const target = await findTarget(page, hints, "input:not([type='hidden']):not([type='file']), textarea, [contenteditable='true']");
      if (!target) return finishStep(step, false, `No fillable target found for hints: ${hints.join(", ")}.`);
      const before = await readRuntimeSignature(page);
      await target.fill(step.value || "test@example.com", { timeout: 1600 }).catch(async () => target.pressSequentially(step.value || "test@example.com"));
      await page.waitForTimeout(250);
      const after = await readRuntimeSignature(page);
      return finishStep(step, true, `Filled target; state changed=${signatureChanged(before, after)}.`);
    }
    case "press": {
      const key = step.key || step.value || "Enter";
      const target = await findTarget(page, hints, "input:not([type='hidden']):not([type='file']), textarea, [contenteditable='true']");
      const before = await readRuntimeSignature(page);
      if (target) await target.press(key, { timeout: 1600 });
      else await page.keyboard.press(key);
      await page.waitForTimeout(300);
      const after = await readRuntimeSignature(page);
      return finishStep(step, signatureChanged(before, after), `Pressed ${key}; state changed=${signatureChanged(before, after)}.`);
    }
    case "drag": {
      const target = await findTarget(
        page,
        hints,
        "[draggable='true'], [role='slider'], input[type='range'], canvas, svg, [class*='drag'], [class*='drop'], [class*='card'], li, article",
      );
      if (!target) return finishStep(step, false, `No draggable target found for hints: ${hints.join(", ")}.`);
      const box = await target.boundingBox().catch(() => null);
      if (!box) return finishStep(step, false, "Drag target had no visible bounding box.");
      const before = await readRuntimeSignature(page);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + Math.min(160, Math.max(80, box.width)), startY + Math.min(90, Math.max(50, box.height)), { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const after = await readRuntimeSignature(page);
      return finishStep(step, signatureChanged(before, after), `Dragged target; state changed=${signatureChanged(before, after)}.`);
    }
    case "reload": {
      const beforeTheme = await readThemeState(page);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(700);
      const afterTheme = await readThemeState(page);
      const stable = JSON.stringify(beforeTheme.localStorage) === JSON.stringify(afterTheme.localStorage);
      return finishStep(step, stable, `Reload completed; localStorage stable=${stable}; theme before=${beforeTheme.themeSignal}; after=${afterTheme.themeSignal}.`);
    }
    case "setViewport": {
      const value = (step.value || "").toLowerCase();
      const size = value.includes("tablet") || value.includes("pad") ? { width: 768, height: 1024 } : { width: 390, height: 844 };
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        visibleControls: Array.from(document.querySelectorAll("button, a[href], input, textarea, select, [role='button']")).filter((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
        }).length,
      }));
      return finishStep(step, !info.horizontalOverflow && info.visibleControls > 0, `Viewport ${info.width}x${info.height}; horizontalOverflow=${info.horizontalOverflow}; visibleControls=${info.visibleControls}.`);
    }
    case "compareState": {
      const before = await readRuntimeSignature(page);
      await page.waitForTimeout(900);
      const after = await readRuntimeSignature(page);
      return finishStep(step, signatureChanged(before, after), `Waited and compared runtime state; changed=${signatureChanged(before, after)}.`);
    }
    default:
      return finishStep(step, false, `Unsupported action: ${String(step.action)}.`);
  }
}

function finishStep(step: EvidencePlanStep, passed: boolean, detail: string): EvidencePlanResult {
  return { ...step, passed, detail };
}

function normalizeHints(hints: string[]) {
  return hints.map((hint) => hint.trim()).filter(Boolean).slice(0, 8);
}

function matchesHints(value: string, hints: string[]) {
  const normalized = value.toLowerCase();
  return hints.length === 0 || hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

function findMatchedHints(value: string, hints: string[]) {
  const normalized = value.toLowerCase();
  return hints.filter((hint) => normalized.includes(hint.toLowerCase()));
}

function summarizeItems(items: unknown[]) {
  return JSON.stringify(items.slice(0, 5)).slice(0, 800);
}

function signatureChanged(before: Awaited<ReturnType<typeof readRuntimeSignature>>, after: Awaited<ReturnType<typeof readRuntimeSignature>>) {
  return (
    before.url !== after.url ||
    before.textLength !== after.textLength ||
    before.elementCount !== after.elementCount ||
    before.canvasHash !== after.canvasHash ||
    before.styleHash !== after.styleHash
  );
}

async function readControls(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("button, input, textarea, select, a[href], [role='button'], [contenteditable='true']"))
      .slice(0, 200)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: (element as HTMLElement).id || "",
        className: (element as HTMLElement).className?.toString() || "",
        text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
        href: element.getAttribute("href"),
        type: element.getAttribute("type"),
        placeholder: element.getAttribute("placeholder"),
        ariaLabel: element.getAttribute("aria-label"),
      })),
  );
}

async function readVisibleNavigation(page: Page) {
  return page.evaluate(() => {
    const isVisible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const visibleNavLinks = Array.from(document.querySelectorAll("nav a[href], header a[href], [id*='menu'] a[href], [class*='menu'] a[href]")).filter(isVisible).length;
    const menuSignal = Array.from(document.querySelectorAll("[id*='menu'], [class*='menu'], nav, header"))
      .slice(0, 30)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return [
          element.tagName,
          (element as HTMLElement).id,
          (element as HTMLElement).className?.toString() || "",
          isVisible(element),
          Math.round(box.width),
          Math.round(box.height),
        ].join(":");
      })
      .join("|");
    return { visibleNavLinks, menuSignal };
  });
}

async function findTarget(page: Page, hints: string[], selector: string): Promise<Locator | null> {
  const candidates = page.locator(selector);
  const count = Math.min(await candidates.count().catch(() => 0), 120);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const descriptor = await candidate
      .evaluate((element) =>
        [
          element.tagName,
          (element as HTMLElement).id,
          (element as HTMLElement).className?.toString() || "",
          element.textContent || "",
          element.getAttribute("aria-label") || "",
          element.getAttribute("placeholder") || "",
          element.getAttribute("href") || "",
          element.getAttribute("title") || "",
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .catch(() => "");
    if (matchesHints(descriptor, hints)) return candidate;
  }
  if (!hints.length && count > 0) return candidates.first();
  return null;
}

async function readThemeState(page: Page) {
  return page.evaluate(() => {
    const localStorageEntries = Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index) || "";
      return [key, localStorage.getItem(key) || ""];
    }));
    const bodyStyle = getComputedStyle(document.body);
    return {
      themeSignal: [
        document.documentElement.className,
        document.body.className,
        document.documentElement.getAttribute("data-theme") || "",
        document.body.getAttribute("data-theme") || "",
        bodyStyle.backgroundColor,
        bodyStyle.color,
      ].join("|"),
      localStorage: localStorageEntries,
    };
  });
}

async function probeImportReadiness(page: Page): Promise<InteractionProbe> {
  try {
    const facts = await page.evaluate(() => {
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      const controls = Array.from(document.querySelectorAll("input, textarea, button, [role='button']"))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || "",
          text: (element.textContent || element.getAttribute("placeholder") || element.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80),
          visible: visible(element),
        }))
        .filter((control) => /file|excel|xlsx|上传|粘贴|导入|解析|import|paste|upload/i.test(`${control.type} ${control.text}`));
      const scripts = Array.from(document.scripts).map((script) => script.src || (script.textContent || "").slice(0, 300));
      return {
        relevantControls: controls.slice(0, 12),
        hasFileInput: controls.some((control) => control.tag === "input" && control.type === "file"),
        hasPasteArea: controls.some((control) => control.tag === "textarea" || /粘贴|paste/i.test(control.text)),
        hasSheetJs: scripts.some((source) => /sheetjs|xlsx/i.test(source)) || Boolean((window as Window & { XLSX?: unknown }).XLSX),
      };
    });
    const passed = facts.relevantControls.length > 0 || facts.hasSheetJs;
    return {
      name: "rubric-import-readiness",
      passed,
      detail: `Import-related controls=${facts.relevantControls.length}, fileInput=${facts.hasFileInput}, pasteArea=${facts.hasPasteArea}, SheetJS/XLSX=${facts.hasSheetJs}.`,
    };
  } catch (error) {
    return { name: "rubric-import-readiness", passed: false, detail: String(error) };
  }
}

async function probeTimerProgress(page: Page): Promise<InteractionProbe> {
  try {
    const read = async () =>
      page.evaluate(() =>
        (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .match(/(\d{1,2}:\d{2}(:\d{2})?|\d+\s*(秒|分钟|min|sec|s))/gi)
          ?.slice(0, 12) || [],
      );
    const before = await read();
    await page.waitForTimeout(1200);
    const after = await read();
    const passed = before.length > 0 && JSON.stringify(before) !== JSON.stringify(after);
    return {
      name: "rubric-timer-progress",
      passed,
      detail: passed
        ? `Timer-like text changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}.`
        : `Timer-like text before=${JSON.stringify(before)}, after=${JSON.stringify(after)}.`,
    };
  } catch (error) {
    return { name: "rubric-timer-progress", passed: false, detail: String(error) };
  }
}

async function probeTextEntryFeedback(page: Page): Promise<InteractionProbe> {
  try {
    const input = page.locator("input:not([type='hidden']):not([type='file']), textarea, [contenteditable='true']").first();
    if (!(await input.count())) {
      return { name: "rubric-text-entry-feedback", passed: false, detail: "No text input was found for practice/input probing." };
    }
    if (!(await input.isVisible().catch(() => false))) {
      return { name: "rubric-text-entry-feedback", passed: false, detail: "The first text input was not visible." };
    }
    const before = await readRuntimeSignature(page);
    await input.click({ timeout: 1500 }).catch(() => undefined);
    await input.fill("zzzzwrong", { timeout: 1500 }).catch(async () => {
      await input.pressSequentially("zzzzwrong", { timeout: 40 }).catch(() => undefined);
    });
    await page.waitForTimeout(350);
    const afterTyping = await readRuntimeSignature(page);
    await input.press("Enter").catch(() => undefined);
    await page.waitForTimeout(450);
    const afterEnter = await readRuntimeSignature(page);
    const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    const hasFeedbackText = /错误|不正确|重试|提示|反馈|wrong|incorrect|try again|error/i.test(bodyText);
    const changed =
      before.textLength !== afterTyping.textLength ||
      before.elementCount !== afterTyping.elementCount ||
      before.styleHash !== afterTyping.styleHash ||
      afterTyping.textLength !== afterEnter.textLength ||
      afterTyping.elementCount !== afterEnter.elementCount ||
      afterTyping.styleHash !== afterEnter.styleHash;
    return {
      name: "rubric-text-entry-feedback",
      passed: changed || hasFeedbackText,
      detail: `Typing into a text input ${changed ? "changed page state" : "did not change sampled state"}; feedback text detected=${hasFeedbackText}.`,
    };
  } catch (error) {
    return { name: "rubric-text-entry-feedback", passed: false, detail: String(error) };
  }
}

async function probeDragReactivity(page: Page): Promise<InteractionProbe> {
  try {
    const candidate = page.locator("[draggable='true'], canvas, svg, [role='slider'], input[type='range']").first();
    if (!(await candidate.count())) {
      return { name: "rubric-drag-reactivity", passed: false, detail: "No draggable/canvas/svg/slider candidate was found." };
    }
    const box = await candidate.boundingBox().catch(() => null);
    if (!box) return { name: "rubric-drag-reactivity", passed: false, detail: "Drag candidate had no visible bounding box." };
    const before = await readRuntimeSignature(page);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + Math.min(120, box.width || 120), startY + Math.min(60, box.height || 60), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const after = await readRuntimeSignature(page);
    const passed =
      before.textLength !== after.textLength ||
      before.elementCount !== after.elementCount ||
      before.canvasHash !== after.canvasHash ||
      before.styleHash !== after.styleHash;
    return {
      name: "rubric-drag-reactivity",
      passed,
      detail: passed ? "Drag gesture changed sampled page state." : "Drag gesture did not change sampled page state.",
    };
  } catch (error) {
    return { name: "rubric-drag-reactivity", passed: false, detail: String(error) };
  }
}

async function probeMobileMenu(page: Page): Promise<InteractionProbe> {
  try {
    const original = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    const button = await findTarget(page, ["menu", "hamburger", "nav", "菜单"], "button, [role='button'], .hamburger, [class*='menu'], [id*='menu']");
    if (!button) {
      if (original) await page.setViewportSize(original);
      return { name: "mobile-menu-toggle", passed: false, detail: "No visible mobile menu button was found at mobile viewport." };
    }
    const before = await readVisibleNavigation(page);
    await button.click({ timeout: 1600 }).catch(async () => button.dispatchEvent("click", { timeout: 1600 }));
    await page.waitForTimeout(350);
    const after = await readVisibleNavigation(page);
    if (original) await page.setViewportSize(original);
    const passed = after.visibleNavLinks > before.visibleNavLinks || before.menuSignal !== after.menuSignal;
    return {
      name: "mobile-menu-toggle",
      passed,
      detail: `Mobile nav links ${before.visibleNavLinks}->${after.visibleNavLinks}; menu signal changed=${before.menuSignal !== after.menuSignal}.`,
    };
  } catch (error) {
    return { name: "mobile-menu-toggle", passed: false, detail: String(error) };
  }
}

async function probeThemePersistence(page: Page): Promise<InteractionProbe> {
  try {
    const button = await findTarget(page, ["theme", "dark", "mode", "toggle", "light", "bolt", "闪电", "主题", "暗黑"], "button, [role='button'], input[type='button'], a[href]");
    if (!button) return { name: "theme-persistence", passed: false, detail: "No theme-like toggle button was found." };
    const before = await readThemeState(page);
    await button.click({ timeout: 1600 }).catch(async () => button.dispatchEvent("click", { timeout: 1600 }));
    await page.waitForTimeout(350);
    const afterClick = await readThemeState(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(600);
    const afterReload = await readThemeState(page);
    const changed = before.themeSignal !== afterClick.themeSignal;
    const persisted =
      Object.keys(afterClick.localStorage).length > 0 &&
      JSON.stringify(afterClick.localStorage) === JSON.stringify(afterReload.localStorage) &&
      afterClick.themeSignal === afterReload.themeSignal;
    return {
      name: "theme-persistence",
      passed: changed && persisted,
      detail: `Theme changed=${changed}; localStorage keys=${Object.keys(afterClick.localStorage).join(", ") || "none"}; persisted after reload=${persisted}.`,
    };
  } catch (error) {
    return { name: "theme-persistence", passed: false, detail: String(error) };
  }
}

async function probeFormSubmitFeedback(page: Page): Promise<InteractionProbe> {
  try {
    const inputs = page.locator("input:not([type='hidden']):not([type='file']), textarea");
    const count = await inputs.count().catch(() => 0);
    const submit = await findTarget(page, ["submit", "send", "save", "enviar", "提交", "保存", "发送"], "button, input[type='submit'], [role='button']");
    if (!count || !submit) return { name: "form-submit-feedback", passed: false, detail: `inputs=${count}, submitFound=${Boolean(submit)}.` };
    const before = await readRuntimeSignature(page);
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      const type = (await input.getAttribute("type").catch(() => "")) || "";
      const value = type === "email" ? "test@example.com" : index === 0 ? "Test User" : "Automated test message";
      await input.fill(value, { timeout: 1200 }).catch(() => undefined);
    }
    await submit.click({ timeout: 1600 }).catch(async () => submit.dispatchEvent("click", { timeout: 1600 }));
    await page.waitForTimeout(1200);
    const after = await readRuntimeSignature(page);
    const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    const hasFeedback = /success|sent|saved|thank|error|required|invalid|enviado|gracias|éxito|成功|已保存|提交|错误|必填|无效/i.test(bodyText);
    return {
      name: "form-submit-feedback",
      passed: signatureChanged(before, after) || hasFeedback,
      detail: `Filled ${count} form fields and submitted; state changed=${signatureChanged(before, after)}; feedback text=${hasFeedback}.`,
    };
  } catch (error) {
    return { name: "form-submit-feedback", passed: false, detail: String(error) };
  }
}

async function probeProjectCards(page: Page): Promise<InteractionProbe> {
  try {
    const facts = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("article, [class*='project'], [class*='portfolio'], [class*='card']"))
        .map((element) => ({
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          imageCount: element.querySelectorAll("img, picture").length,
          demoCount: Array.from(element.querySelectorAll("a, button")).filter((item) => /demo|repo|github|view|演示|仓库/i.test(item.textContent || "")).length,
        }))
        .filter((card) => card.text.length > 20);
      const bodyText = document.body.innerText || "";
      return {
        cardCount: cards.length,
        cardsWithImages: cards.filter((card) => card.imageCount > 0).length,
        cardsWithDemoRepo: cards.filter((card) => card.demoCount >= 1).length,
        demoTextCount: (bodyText.match(/View Demo|Demo|演示/gi) || []).length,
        repoTextCount: (bodyText.match(/View Repo|Repo|GitHub|仓库/gi) || []).length,
      };
    });
    const passed = facts.cardCount >= 2 && facts.cardsWithImages >= 1 && (facts.cardsWithDemoRepo >= 1 || (facts.demoTextCount > 0 && facts.repoTextCount > 0));
    return {
      name: "project-cards",
      passed,
      detail: `cards=${facts.cardCount}, withImages=${facts.cardsWithImages}, withDemoRepo=${facts.cardsWithDemoRepo}, demoText=${facts.demoTextCount}, repoText=${facts.repoTextCount}.`,
    };
  } catch (error) {
    return { name: "project-cards", passed: false, detail: String(error) };
  }
}

async function probeVideoSection(page: Page): Promise<InteractionProbe> {
  try {
    const facts = await page.evaluate(() => {
      const media = Array.from(document.querySelectorAll("iframe, video, embed, object, source")).map((element) => ({
        tag: element.tagName.toLowerCase(),
        src: (element as HTMLIFrameElement | HTMLVideoElement | HTMLSourceElement).src || element.getAttribute("data-src") || "",
        title: element.getAttribute("title") || "",
      }));
      const links = Array.from(document.querySelectorAll("a[href]")).filter((anchor) =>
        /youtube|youtu\.be|video|subscribe/i.test(`${(anchor as HTMLAnchorElement).href} ${anchor.textContent || ""}`),
      );
      const text = document.body.innerText || "";
      return {
        mediaCount: media.length,
        youtubeEmbedCount: media.filter((item) => /youtube|youtu\.be/i.test(`${item.src} ${item.title}`)).length,
        videoLinkCount: links.length,
        videoCardText: /youtube|latest videos|video|subscribe/i.test(text),
      };
    });
    return {
      name: "video-section",
      passed: facts.youtubeEmbedCount > 0 || facts.mediaCount > 0 || (facts.videoCardText && facts.videoLinkCount > 0),
      detail: `media=${facts.mediaCount}, youtubeEmbeds=${facts.youtubeEmbedCount}, videoLinks=${facts.videoLinkCount}, videoText=${facts.videoCardText}.`,
    };
  } catch (error) {
    return { name: "video-section", passed: false, detail: String(error) };
  }
}

async function probePointerReactivity(page: Page): Promise<InteractionProbe> {
  try {
    const before = await readRuntimeSignature(page);
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    await page.mouse.move(40, 40);
    await page.mouse.move(Math.round(viewport.width * 0.35), Math.round(viewport.height * 0.45), { steps: 8 });
    await page.waitForTimeout(350);
    const after = await readRuntimeSignature(page);
    const passed = before.canvasHash !== after.canvasHash || before.styleHash !== after.styleHash;
    return {
      name: "pointer-reactivity",
      passed,
      detail: passed ? "Mouse movement changed canvas pixels or element styles." : "Mouse movement did not change sampled canvas/style state.",
    };
  } catch (error) {
    return { name: "pointer-reactivity", passed: false, detail: String(error) };
  }
}

async function probeButtonReactivity(page: Page): Promise<InteractionProbe> {
  try {
    const buttons = page.locator("button:not([type='submit']), input[type='button'], [role='button']");
    const count = await buttons.count().catch(() => 0);
    if (!count) return { name: "button-reactivity", passed: false, detail: "No safe button-like controls were found." };

    const attempts = Math.min(count, 5);
    let changed = 0;
    const details: string[] = [];
    for (let index = 0; index < attempts; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      const before = await readRuntimeSignature(page);
      const label = ((await button.innerText().catch(() => "")) || (await button.getAttribute("aria-label").catch(() => "")) || `#${index + 1}`)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      await button.click({ timeout: 1500 }).catch((error) => {
        details.push(`${label}: click failed (${error instanceof Error ? error.message : String(error)})`);
      });
      await page.waitForTimeout(300);
      const after = await readRuntimeSignature(page);
      const didChange =
        before.url !== after.url ||
        before.textLength !== after.textLength ||
        before.elementCount !== after.elementCount ||
        before.canvasHash !== after.canvasHash ||
        before.styleHash !== after.styleHash;
      if (didChange) changed += 1;
      details.push(`${label}: ${didChange ? "changed page state" : "no sampled state change"}`);
      if (before.url !== after.url) break;
    }
    return {
      name: "button-reactivity",
      passed: changed > 0,
      detail: `${changed}/${attempts} sampled button-like controls changed page state. ${details.slice(0, 5).join("; ")}`,
    };
  } catch (error) {
    return { name: "button-reactivity", passed: false, detail: String(error) };
  }
}

async function probeDocumentSwitch(page: Page): Promise<InteractionProbe> {
  try {
    const listItems = page.locator("#doc-list-items > *");
    if ((await listItems.count()) < 2) {
      return { name: "document-switch", passed: false, detail: "Less than two document items were found." };
    }
    const before = await readTitleAndEditor(page);
    await listItems.nth(1).click({ timeout: 2000 });
    await page.waitForTimeout(300);
    const after = await readTitleAndEditor(page);
    const passed = before.title !== after.title || before.editor !== after.editor;
    return {
      name: "document-switch",
      passed,
      detail: passed ? "Clicking the second document changed the title or editor content." : "Clicking did not change title/editor content.",
    };
  } catch (error) {
    return { name: "document-switch", passed: false, detail: String(error) };
  }
}

async function probeCreateDocument(page: Page): Promise<InteractionProbe> {
  try {
    if (!(await page.locator("#create-doc-btn").count())) {
      return { name: "create-document", passed: false, detail: "#create-doc-btn was not found." };
    }
    const before = await page.locator("#doc-list-items > *").count().catch(() => 0);
    await page.locator("#create-doc-btn").first().click({ timeout: 2000 });
    await page.waitForTimeout(400);
    const after = await page.locator("#doc-list-items > *").count().catch(() => 0);
    return {
      name: "create-document",
      passed: after > before,
      detail: `Document item count changed from ${before} to ${after}.`,
    };
  } catch (error) {
    return { name: "create-document", passed: false, detail: String(error) };
  }
}

async function probeCommentEnter(page: Page): Promise<InteractionProbe> {
  try {
    const input = page.locator("#comment-input").first();
    if (!(await input.count())) {
      return { name: "comment-enter", passed: false, detail: "#comment-input was not found." };
    }
    const marker = `automated-comment-${Date.now()}`;
    await input.fill(marker, { timeout: 2000 });
    await input.press("Enter");
    await page.waitForTimeout(400);
    const bodyText = await page.locator("body").innerText({ timeout: 2000 });
    const value = await input.inputValue().catch(() => "");
    return {
      name: "comment-enter",
      passed: bodyText.includes(marker) && value.trim() === "",
      detail: bodyText.includes(marker)
        ? `Comment text appeared in page; input value after Enter is "${value}".`
        : "Comment text did not appear after pressing Enter.",
    };
  } catch (error) {
    return { name: "comment-enter", passed: false, detail: String(error) };
  }
}

async function probeEmptyTitleSave(page: Page): Promise<InteractionProbe> {
  try {
    const title = page.locator("#doc-title").first();
    const save = page.locator("#save-btn").first();
    if (!(await title.count()) || !(await save.count())) {
      return { name: "empty-title-save", passed: false, detail: "#doc-title or #save-btn was not found." };
    }

    const oldValue = await title.inputValue().catch(() => "");
    await title.fill("");
    await save.click({ timeout: 2000 });
    await page.waitForTimeout(500);
    const bodyText = await page.locator("body").innerText({ timeout: 2000 });
    if (oldValue) await title.fill(oldValue).catch(() => undefined);
    const passed = /标题|不能为空|空|错误|error|required|失败/i.test(bodyText);
    return {
      name: "empty-title-save",
      passed,
      detail: passed ? "Page showed an empty-title validation signal." : "No empty-title validation signal was detected.",
    };
  } catch (error) {
    return { name: "empty-title-save", passed: false, detail: String(error) };
  }
}

async function readTitleAndEditor(page: Page) {
  const title = await page.locator("#doc-title").first().inputValue().catch(async () => {
    return page.locator("#doc-title").first().innerText().catch(() => "");
  });
  const editor = await page.locator("#rich-editor").first().innerText().catch(async () => {
    return page.locator("#rich-editor").first().inputValue().catch(() => "");
  });
  return { title, editor };
}

async function saveScreenshot(page: Page, taskId: string, index: number) {
  const screenshotDir = path.join(process.cwd(), "public", "screenshots", taskId);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const filename = `${String(index + 1).padStart(2, "0")}.png`;
  const absolutePath = path.join(screenshotDir, filename);
  await page.screenshot({ path: absolutePath, fullPage: true });
  return `/screenshots/${taskId}/${filename}`;
}

function cssEscape(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}
