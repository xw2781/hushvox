import { SAMPLE_RATE } from './protocol';

export type Source = 'original' | 'enhanced';

/**
 * Gapless A/B player. Both the dry and the wet buffer are always started together on the same
 * clock; switching source / strength only changes two gain values (with a short ramp), so the
 * playhead never jumps.
 */
export class ABPlayer {
  readonly ctx: AudioContext;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private dryBuf: AudioBuffer | null = null;
  private wetBuf: AudioBuffer | null = null;
  private srcs: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx time corresponding to `offset`
  private offset = 0;
  playing = false;
  source: Source = 'enhanced';
  strength = 1;
  onEnded: () => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.dryGain.connect(this.ctx.destination);
    this.wetGain.connect(this.ctx.destination);
    this.applyGains(true);
  }

  get duration() { return this.dryBuf ? this.dryBuf.length / SAMPLE_RATE : 0; }

  load(dry: AudioBuffer, wet: AudioBuffer | null) {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
    this.dryBuf = dry;
    this.wetBuf = wet;
  }

  setWet(wet: AudioBuffer) { this.wetBuf = wet; }

  get position(): number {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + (this.ctx.currentTime - this.startedAt));
  }

  private applyGains(immediate = false) {
    const wet = this.source === 'enhanced' ? this.strength : 0;
    const dry = this.source === 'enhanced' ? 1 - this.strength : 1;
    const t = this.ctx.currentTime;
    for (const [g, v] of [[this.dryGain, dry], [this.wetGain, wet]] as const) {
      g.gain.cancelScheduledValues(t);
      if (immediate) g.gain.value = v;
      else g.gain.setTargetAtTime(v, t, 0.008);
    }
  }

  setSource(s: Source) { this.source = s; this.applyGains(); }
  setStrength(v: number) { this.strength = v; this.applyGains(); }

  private stopSources() {
    for (const s of this.srcs) { s.onended = null; try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.srcs = [];
  }

  async play() {
    if (!this.dryBuf || this.playing) return;
    await this.ctx.resume();
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    const when = this.ctx.currentTime + 0.02;
    const make = (buf: AudioBuffer | null, dest: GainNode) => {
      if (!buf) return;
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(dest);
      s.start(when, this.offset);
      this.srcs.push(s);
    };
    make(this.dryBuf, this.dryGain);
    make(this.wetBuf, this.wetGain);
    this.startedAt = when;
    this.playing = true;
    const first = this.srcs[0];
    first.onended = () => {
      if (!this.playing) return;
      this.stopSources();
      this.playing = false;
      this.offset = 0;
      this.onEnded();
    };
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.playing = false;
    this.stopSources();
  }

  async toggle() { if (this.playing) this.pause(); else await this.play(); }

  async seek(sec: number) {
    const was = this.playing;
    if (was) { this.playing = false; this.stopSources(); }
    this.offset = Math.max(0, Math.min(this.duration, sec));
    if (was) await this.play();
  }

  dispose() {
    this.stopSources();
    void this.ctx.close();
  }
}
