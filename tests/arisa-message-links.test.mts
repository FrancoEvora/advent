import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "../src/components/arisa/MessageText.ts";

const render = (content: string) => renderToStaticMarkup(createElement(MessageText, { content }));
const meet = "https://meet.google.com/pue-orhw-rjq";

test("the reported meeting message renders a real named anchor", () => {
  const html = render(`[Toque aqui para entrar na reunião pelo Google Meet](${meet})\n\nConfirmei o link na agenda.`);
  assert.match(html, /<a href="https:\/\/meet.google.com\/pue-orhw-rjq"/);
  assert.match(html, />Toque aqui para entrar na reunião pelo Google Meet<\/a>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(html.includes("\n\nConfirmei o link na agenda."));
  assert.ok(!html.includes("[Toque"));
});

test("plain links are clickable without surrounding punctuation", () => {
  const html = render(`Reunião (${meet}). Próximo: https://example.com/pauta?x=1&y=2!`);
  assert.ok(html.includes(`href="${meet}"`));
  assert.ok(html.includes("</a>). Próximo:"));
  assert.match(html, /href="https:\/\/example.com\/pauta\?x=1&amp;y=2"/);
  assert.ok(html.endsWith("</a>!</p>"));
});

test("balanced URL parentheses and adjacent Markdown links survive", () => {
  const html = render("[Pauta](https://example.com/a_(b))[Agenda](https://calendar.google.com/) e https://example.com/a_(b).");
  assert.equal((html.match(/<a /g) || []).length, 3);
  assert.equal((html.match(/href="https:\/\/example.com\/a_\(b\)"/g) || []).length, 2);
});

test("HTML and unsafe protocols stay inert text", () => {
  const html = render('<script>alert(1)</script> [Clique](javascript:alert(1)) [Arquivo](data:text/html,test)');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<a "));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(render("Sem link.\nSegunda linha."), "<p>Sem link.\nSegunda linha.</p>");
});
