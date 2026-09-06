import { createElement, type ReactNode } from "react";

/** Render stored message text without interpreting HTML or unsafe URL schemes. */
export function MessageText({ content }: { content: string }) {
  const children: ReactNode[] = [];
  const links = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^()\s<>]*\))+)\)|https?:\/\/[^\s<>"']+/gi;
  let end = 0;
  for (const match of content.matchAll(links)) {
    const start = match.index;
    let href = match[2] || match[0];
    if (!match[2]) {
      href = href.replace(/[.,!?;:]+$/, "");
      for (const [open, close] of [["(", ")"], ["[", "]"]]) {
        while (href.endsWith(close) && href.split(close).length > href.split(open).length) href = href.slice(0, -1);
      }
    }
    try {
      const url = new URL(href);
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname) continue;
    } catch { continue; }
    children.push(content.slice(end, start));
    children.push(createElement("a", { key: start, href, target: "_blank", rel: "noopener noreferrer", className: "arisa-message-link" }, match[1] || href));
    end = start + (match[2] ? match[0].length : href.length);
  }
  children.push(content.slice(end));
  return createElement("p", null, ...children);
}
