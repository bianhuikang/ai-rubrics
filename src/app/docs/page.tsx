import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "使用文档 | AI Rubrics Judge",
};

async function loadReadme() {
  const filePath = path.join(process.cwd(), "README.md");
  return fs.readFile(filePath, "utf8");
}

export default async function DocsPage() {
  const readme = await loadReadme();

  return (
    <main className="docs-shell">
      <header className="docs-header">
        <div>
          <p className="docs-eyebrow">使用文档</p>
          <h1>AI Rubrics Judge</h1>
        </div>
        <a className="button-link small-button" href="/">
          返回主界面
        </a>
      </header>
      <section className="docs-card">
        <article className="docs-preview">{renderMarkdown(readme)}</article>
      </section>
    </main>
  );
}

function renderMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre key={`code-${nodes.length}`} className="docs-codeblock">
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const Tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      nodes.push(
        <Tag key={`heading-${nodes.length}`} className={`docs-heading docs-heading-${level}`}>
          {parseInline(headingMatch[2])}
        </Tag>,
      );
      index += 1;
      continue;
    }

    const listMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/) || trimmed.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      const ordered = Boolean(trimmed.match(/^(\d+)[.)]\s+/));
      const items: ReactNode[] = [];

      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current) break;
        const currentMatch = ordered
          ? current.match(/^(\d+)[.)]\s+(.*)$/)
          : current.match(/^[-*]\s+(.*)$/);
        if (!currentMatch) break;
        items.push(<li key={`item-${nodes.length}-${items.length}`}>{parseInline(currentMatch[ordered ? 2 : 1])}</li>);
        index += 1;
      }

      nodes.push(
        ordered ? (
          <ol key={`list-${nodes.length}`} className="docs-list">
            {items}
          </ol>
        ) : (
          <ul key={`list-${nodes.length}`} className="docs-list">
            {items}
          </ul>
        ),
      );
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || next.startsWith("#") || next.startsWith("```") || /^(\d+)[.)]\s+/.test(next) || /^[-*]\s+/.test(next)) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }

    nodes.push(
      <p key={`p-${nodes.length}`} className="docs-paragraph">
        {parseInline(paragraphLines.join(" "))}
      </p>,
    );
  }

  return nodes;
}

function parseInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(value.slice(lastIndex, start));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`strong-${nodes.length}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`code-${nodes.length}`} className="docs-inline-code">{token.slice(1, -1)}</code>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a key={`link-${nodes.length}`} href={linkMatch[2]} target="_blank" rel="noreferrer" className="docs-link">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}
