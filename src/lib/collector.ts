import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { extractSelectorRequirements, trimForPrompt } from "./requirement-parser";
import type { ElementEvidence, InteractionProbe, PageEvidence } from "./types";

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
    const interactions = await runInteractionProbes(page, input.prompt);

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

async function runInteractionProbes(page: Page, prompt: string): Promise<InteractionProbe[]> {
  const probes: InteractionProbe[] = [];
  const hasDocumentEditorHints =
    /doc-list|rich-editor|comment-input|create-doc|文档|协作|编辑器/i.test(prompt) ||
    (await page.locator("#doc-list-items, #doc-title, #rich-editor, #comment-input").count().catch(() => 0)) > 0;

  if (hasDocumentEditorHints) {
    probes.push(await probeDocumentSwitch(page));
    probes.push(await probeCreateDocument(page));
    probes.push(await probeCommentEnter(page));
    probes.push(await probeEmptyTitleSave(page));
  }

  probes.push(await probePointerReactivity(page));
  probes.push(await probeButtonReactivity(page));
  return probes;
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
