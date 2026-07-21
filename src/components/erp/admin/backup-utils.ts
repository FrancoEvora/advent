export async function blobToBase64(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function gzipJson(value: unknown) {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === "undefined") return new Blob([raw], { type: "application/json" });
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

export async function checksum(blob: Blob) {
  const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function checksumBytes(bytes: Uint8Array) {
  const copy = Uint8Array.from(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2, "0")).join("");
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ArchiveEntry = { path: string; data: Uint8Array; modifiedAt?: Date };

const encoder = new TextEncoder();

function cleanPath(value: string) {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .join("/")
    .replace(/[\u0000-\u001f\u007f]/g, "_");
}

function writeText(target: Uint8Array, offset: number, length: number, value: string) {
  const bytes = encoder.encode(value);
  target.set(bytes.slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeText(target, offset, length, `${text}\0`);
}

function splitTarPath(input: string) {
  const safe = cleanPath(input) || "arquivo";
  if (encoder.encode(safe).length <= 100) return { name: safe, prefix: "" };
  const parts = safe.split("/");
  const name = parts.pop() || "arquivo";
  let prefix = parts.join("/");
  if (encoder.encode(name).length <= 100 && encoder.encode(prefix).length <= 155) return { name, prefix };
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex > 0 ? name.slice(extensionIndex).slice(0, 16) : "";
  const stem = (extensionIndex > 0 ? name.slice(0, extensionIndex) : name).slice(0, 72);
  const suffix = Math.abs([...safe].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)).toString(36);
  const compactName = `${stem}-${suffix}${extension}`.slice(0, 100);
  while (encoder.encode(prefix).length > 155 && prefix.includes("/")) prefix = prefix.slice(prefix.indexOf("/") + 1);
  return { name: compactName, prefix: prefix.slice(-155) };
}

function createTarHeader(entry: ArchiveEntry) {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarPath(entry.path);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.byteLength);
  writeOctal(header, 136, 12, Math.floor((entry.modifiedAt || new Date()).getTime() / 1000));
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "evora");
  writeText(header, 297, 32, "evora");
  writeText(header, 345, 155, prefix);
  const total = header.reduce((sum, byte) => sum + byte, 0);
  const checksumValue = total.toString(8).padStart(6, "0").slice(-6);
  writeText(header, 148, 6, checksumValue);
  header[154] = 0;
  header[155] = 32;
  return header;
}

export function createTar(entries: ArchiveEntry[]) {
  const size = entries.reduce((total, entry) => total + 512 + Math.ceil(entry.data.byteLength / 512) * 512, 1024);
  const tar = new Uint8Array(size);
  let offset = 0;
  for (const entry of entries) {
    tar.set(createTarHeader(entry), offset);
    offset += 512;
    tar.set(entry.data, offset);
    offset += Math.ceil(entry.data.byteLength / 512) * 512;
  }
  return tar;
}

export async function createTarGzip(entries: ArchiveEntry[]) {
  const tar = createTar(entries);
  if (typeof CompressionStream === "undefined") {
    return { blob: new Blob([tar], { type: "application/octet-stream" }), extension: "tar" };
  }
  const stream = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return { blob: await new Response(stream).blob(), extension: "tar.gz" };
}

export function jsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value, null, 2));
}

export function textBytes(value: string) {
  return encoder.encode(value);
}
