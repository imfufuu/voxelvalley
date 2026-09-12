/** Fully procedural ambience: no assets, generated with the WebAudio API. */
export class SoundKit {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;
  enabled = true;

  resume() {
    if (!this.ctx) this.init();
    this.ctx?.resume();
  }

  private init() {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    this.ctx = ctx;

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);

    // wind: filtered looping noise with a slow, breathing cutoff
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = 420;
    filt.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(filt).connect(g).connect(this.master);
    src.start();
    this.windGain = g;
    this.windFilter = filt;
  }

  /** altitude 0..1, exposure 0..1 */
  setWind(strength: number, altitude: number) {
    if (!this.ctx || !this.windGain || !this.windFilter || !this.enabled) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.018 + strength * 0.05 + altitude * 0.07, t, 0.6);
    this.windFilter.frequency.setTargetAtTime(320 + strength * 380 + altitude * 500, t, 0.8);
  }

  private burst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || !this.master || !this.enabled) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq * (0.85 + Math.random() * 0.3);
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  step(surface: "grass" | "sand" | "stone" | "snow" | "water", intensity: number) {
    const v = 0.12 * intensity;
    switch (surface) {
      case "grass":
        this.burst(1500, 1.1, 0.14, v, "bandpass");
        break;
      case "sand":
        this.burst(900, 0.8, 0.18, v * 0.9, "lowpass");
        break;
      case "stone":
        this.burst(2600, 2.2, 0.1, v * 1.1, "bandpass");
        break;
      case "snow":
        this.burst(700, 1.6, 0.16, v, "bandpass");
        break;
      case "water":
        this.burst(520, 0.6, 0.32, v * 1.4, "lowpass");
        break;
    }
  }

  splash() {
    this.burst(380, 0.5, 0.55, 0.22, "lowpass");
    this.burst(1800, 1.2, 0.3, 0.1, "bandpass");
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
