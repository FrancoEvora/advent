import { speechParts } from "../../../supabase/functions/_shared/arisa-speech-text";
export type VoicePhase = "idle" | "loading" | "speaking" | "paused" | "error";
export type VoiceState = { enabled: boolean; phase: VoicePhase; messageId: string | null; end: number; part: number; total: number; error: string };
export interface VoiceAudio<Buffer> {
  unlock(): Promise<void>; pause(): Promise<void>; resume(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<Buffer>;
  play(buffer: Buffer): { ended: Promise<void>; stop(): void };
  close(): void;
}
export const initialVoiceState = (): VoiceState => ({ enabled: false, phase: "idle", messageId: null, end: 0, part: 0, total: 0, error: "" });
/** No chat mutations exist in this class: replay only fetches read-only audio. */
export class VoiceQueue<Buffer> {
  state = initialVoiceState();
  private revision = 0;
  private controller: AbortController | null = null;
  private playing: { ended: Promise<void>; stop(): void } | null = null;
  private waiting: (() => void) | null = null;
  private paused = false;
  private beforePause: VoicePhase = "loading";
  constructor(private audio: VoiceAudio<Buffer>, private fetchPart: (id: string, index: number, signal: AbortSignal) => Promise<ArrayBuffer>, private changed: (state: VoiceState) => void) {}
  private update(next: Partial<VoiceState>) { this.state = { ...this.state, ...next }; this.changed(this.state); }
  async enable() {
    // Invoked directly from a gesture, before any network await, for iOS.
    const revision = this.revision;
    try { await this.audio.unlock(); if (revision === this.revision) this.update({ enabled: true, error: "" }); }
    catch { if (revision === this.revision) this.update({ enabled: false, phase: "error", error: "Toque novamente no modo fala para liberar o áudio neste aparelho." }); }
  }
  stop(disable = false) {
    this.revision++; this.controller?.abort(); this.controller = null;
    this.playing?.stop(); this.playing = null; this.paused = false;
    this.waiting?.(); this.waiting = null;
    this.update({ phase: "idle", messageId: null, end: 0, part: 0, total: 0, error: "", ...(disable ? { enabled: false } : {}) });
  }
  async pause() {
    if (!["speaking", "loading"].includes(this.state.phase)) return;
    this.beforePause = this.state.phase; this.paused = true;
    this.update({ phase: "paused" }); await this.audio.pause().catch(() => {});
  }
  async resume() {
    if (!this.paused) return;
    try { await this.audio.resume(); this.paused = false; this.update({ phase: this.beforePause }); this.waiting?.(); this.waiting = null; }
    catch { this.update({ error: "O áudio está pausado pelo aparelho. Toque em continuar novamente." }); }
  }
  private async ready(revision: number) {
    if (this.paused && revision === this.revision) await new Promise<void>(resolve => { this.waiting = resolve; });
    return revision === this.revision;
  }
  async read(messageId: string, content: string) {
    this.stop(); const revision = this.revision;
    const controller = new AbortController(); this.controller = controller;
    let parts;
    try { parts = speechParts(content); } catch { this.update({ phase: "error", error: "Esta resposta é muito longa para leitura automática. O texto completo está disponível." }); return; }
    if (!parts.length) return;
    this.update({ phase: "loading", messageId, total: parts.length });
    // Pre-fetch at most ONE next phrase. Errors are observed immediately to avoid unhandled rejections.
    const load = (index: number) => this.fetchPart(messageId, index, controller.signal)
      .then(bytes => this.audio.decode(bytes)).then(value => ({ value }), error => ({ error }));
    let next = load(0);
    try {
      for (let index = 0; index < parts.length; index++) {
        const loaded = await next;
        if (revision !== this.revision) return;
        if ("error" in loaded) throw loaded.error;
        if (!await this.ready(revision)) return;
        this.playing = this.audio.play(loaded.value);
        this.update({ phase: "speaking", part: index + 1, end: parts[index].end });
        if (index + 1 < parts.length) next = load(index + 1);
        await this.playing.ended;
        if (revision !== this.revision) return;
        this.playing = null;
        if (!this.paused && index + 1 < parts.length) this.update({ phase: "loading" });
      }
      if (revision === this.revision) this.update({ phase: "idle", messageId: null, end: 0, part: 0, total: 0 });
    } catch (error) {
      if (revision !== this.revision) return;
      controller.abort(); this.playing?.stop(); this.playing = null;
      this.update({ phase: "error", messageId: null, end: 0, error: error instanceof Error ? error.message : "Não foi possível reproduzir a voz. A resposta escrita está preservada." });
    }
  }
  destroy() { this.stop(true); this.audio.close(); }
}

/** Browser adapter is created lazily; importing this module never touches window (SSR safe). */
export function browserVoiceAudio(): VoiceAudio<AudioBuffer> {
  let context: AudioContext | null = null;
  const get = () => {
    if (!context || context.state === "closed") {
      const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error("Este navegador não oferece reprodução por voz. O texto continua disponível.");
      context = new Constructor();
    }
    return context;
  };
  const wake = async () => {
    const current = get();
    if (current.state !== "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([current.resume(), new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Áudio bloqueado pelo aparelho. Toque em ouvir novamente.")), 2500); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    if (current.state !== "running") throw new Error("Áudio pausado pelo aparelho. Toque em continuar.");
  };
  return {
    async unlock() { const current = get(); const waking = wake(); const silent = current.createBufferSource(); silent.buffer = current.createBuffer(1, 1, 22050); silent.connect(current.destination); silent.onended = () => silent.disconnect(); silent.start(); await waking; },
    async pause() { if (context?.state === "running") await context.suspend(); },
    resume: wake,
    async decode(bytes) { return get().decodeAudioData(bytes); },
    play(buffer) {
      const current = get();
      if (current.state !== "running") throw new Error("O aparelho pausou o áudio. Toque em ouvir novamente para continuar.");
      const source = current.createBufferSource(); source.buffer = buffer; source.connect(current.destination);
      let finish!: () => void; const ended = new Promise<void>(resolve => { finish = resolve; });
      source.onended = () => { source.disconnect(); finish(); }; source.start();
      return { ended, stop() { try { source.stop(); } catch { /* already ended */ } source.disconnect(); finish(); } };
    },
    close() { if (context && context.state !== "closed") void context.close().catch(() => {}); context = null; },
  };
}
