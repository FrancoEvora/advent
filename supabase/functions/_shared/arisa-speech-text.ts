/** Pure, deterministic segmentation shared by the browser and the read-only speech endpoint. */
export const SPEECH_VERSION = "arisa-coral-ptbr-v1";
export const MAX_SPEECH_CHARACTERS = 32000;
export type SpeechPart = { index: number; text: string; end: number };
export function spokenText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\\?\((?:https?:\/\/|mailto:)[^\n)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s<>]+/g, " link disponível na mensagem ")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/g, "$1")
    .replace(/```[^\n]*\n?/g, " ").replace(/[*_`~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ").trim();
}
export function speechParts(content: string): SpeechPart[] {
  if (!content.trim()) return [];
  if (content.length > MAX_SPEECH_CHARACTERS) throw new Error("SPEECH_TOO_LONG");
  const result: SpeechPart[] = [];
  let start = 0;
  while (start < content.length) {
    const max = result.length ? 650 : 300;
    const stop = Math.min(start + max, content.length);
    let end = stop;
    if (stop < content.length) {
      const sample = content.slice(start, stop);
      // Never split currency decimals, emails, or URLs at internal punctuation.
      const boundaries = [...sample.matchAll(/[.!?;](?:[”’"')\]]*)\s+|\n\s*\n/g)];
      const last = boundaries.filter(x => (x.index || 0) >= 70).pop();
      if (last && last.index !== undefined) end = start + last.index + last[0].length;
      else {
        const space = sample.lastIndexOf(" ");
        if (space > 70) end = start + space + 1;
      }
    }
    // Do not split UTF-16 surrogate pairs.
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    const text = spokenText(content.slice(start, end));
    if (text) result.push({ index: result.length, text, end });
    else if (result.length) result[result.length - 1].end = end;
    start = end;
  }
  if (result.length) result[result.length - 1].end = content.length;
  return result;
}
