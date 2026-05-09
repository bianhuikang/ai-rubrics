import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Rubrics Judge",
  description: "Generate rubrics and score web artifacts with Playwright and LLMs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
