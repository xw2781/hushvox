/** Min/max peaks per column for the (optionally blended) mono mix of a buffer. */
export function computePeaks(dry: AudioBuffer, wet: AudioBuffer | null, strength: number, columns: number): Float32Array {
  const len = dry.length;
  const out = new Float32Array(columns * 2);
  const chD = Array.from({ length: dry.numberOfChannels }, (_, c) => dry.getChannelData(c));
  const chW = wet ? Array.from({ length: wet.numberOfChannels }, (_, c) => wet.getChannelData(c)) : null;
  const nch = chD.length;
  const per = len / columns;
  for (let x = 0; x < columns; x++) {
    const a = Math.floor(x * per), b = Math.max(a + 1, Math.floor((x + 1) * per));
    // subsample very long columns to keep this cheap
    const step = Math.max(1, Math.floor((b - a) / 256));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i < len; i += step) {
      let v = 0;
      for (let c = 0; c < nch; c++) {
        v += chW ? chD[c][i] * (1 - strength) + chW[c][i] * strength : chD[c][i];
      }
      v /= nch;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out[x * 2] = mn;
    out[x * 2 + 1] = mx;
  }
  return out;
}

export function drawPeaks(canvas: HTMLCanvasElement, peaks: Float32Array, color: string, scale: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  g.fillStyle = color;
  const cols = peaks.length / 2;
  const mid = h / 2;
  const amp = (h / 2) * 0.94 * scale;
  for (let x = 0; x < w; x++) {
    const i = Math.min(cols - 1, Math.floor((x / w) * cols));
    const mn = peaks[i * 2], mx = peaks[i * 2 + 1];
    const y1 = mid - mx * amp, y2 = mid - mn * amp;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}
