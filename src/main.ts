import './style.css';
import { decodeFile, DecodeError } from './audio/decode';
import { denoise, CancelledError, type Job, type Progress } from './audio/denoise';
import { ABPlayer, type Source } from './audio/player';
import { computePeaks, drawPeaks } from './audio/peaks';
import { makeMixer, encodeWav } from './audio/wav';
import { SAMPLE_RATE } from './audio/protocol';
import { baseName, download, fmtEta, fmtTime } from './util';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const states = { idle: $('state-idle'), busy: $('state-busy'), result: $('state-result'), error: $('state-error') };
type StateName = keyof typeof states;
function show(name: StateName) {
  for (const [k, el] of Object.entries(states)) el.hidden = k !== name;
}

const el = {
  drop: $('drop'), file: $<HTMLInputElement>('file'),
  attenIdle: $<HTMLSelectElement>('atten-idle'), attenResult: $<HTMLSelectElement>('atten-result'),
  busyFile: $('busy-file'), busyTitle: $('busy-title'), bar: $('bar'), barFill: $('bar-fill'), busyDetail: $('busy-detail'), cancel: $('cancel'),
  resultName: $('result-name'), resultMeta: $('result-meta'), another: $('another'),
  waveWrap: $('wave-wrap'), waveA: $<HTMLCanvasElement>('wave-a'), waveB: $<HTMLCanvasElement>('wave-b'),
  playhead: $('playhead'), seek: $<HTMLInputElement>('seek'),
  play: $('play'), iconPlay: $('icon-play'), iconPause: $('icon-pause'), timeNow: $('time-now'), timeTotal: $('time-total'),
  abA: $<HTMLInputElement>('ab-a'), abB: $<HTMLInputElement>('ab-b'),
  strength: $<HTMLInputElement>('strength'), strengthOut: $('strength-out'),
  dlWav: $<HTMLButtonElement>('dl-wav'), dlMp3: $<HTMLButtonElement>('dl-mp3'), exportStatus: $('export-status'),
  errorMsg: $('error-msg'), errorBack: $('error-back'),
};

interface Session { name: string; dry: AudioBuffer; wet: AudioBuffer; peaksA: Float32Array; }
let session: Session | null = null;
let player: ABPlayer | null = null;
let job: Job | null = null;
let runId = 0;
let atten = 100;

// ---- progress UI ----------------------------------------------------------
function setBar(frac: number | null) {
  el.bar.classList.toggle('indeterminate', frac === null);
  if (frac !== null) {
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    el.barFill.style.width = `${pct}%`;
    el.bar.setAttribute('aria-valuenow', String(pct));
  } else el.bar.removeAttribute('aria-valuenow');
}
function onProgress(p: Progress) {
  if (p.phase === 'model') {
    if (p.cached) {
      el.busyTitle.textContent = 'Loading model…';
      el.busyDetail.textContent = 'From your browser’s cache';
      setBar(null);
    } else {
      el.busyTitle.textContent = 'Loading model (12 MB, cached after first time)';
      el.busyDetail.textContent = `${p.loadedMB!.toFixed(0)} of ${p.totalMB!.toFixed(0)} MB (uncompressed size)`;
      setBar(p.fraction);
    }
  } else {
    el.busyTitle.textContent = 'Removing noise…';
    setBar(p.fraction);
    el.busyDetail.textContent = p.speed
      ? `${Math.round(p.fraction * 100)}% · ${p.speed.toFixed(1)}× realtime · about ${fmtEta(p.etaSec ?? NaN)} left`
      : 'Starting…';
  }
}

// ---- main flow --------------------------------------------------------------
async function handleFile(file: File) {
  const my = ++runId;
  teardown();
  el.busyFile.textContent = file.name;
  el.busyTitle.textContent = 'Reading audio…';
  el.busyDetail.textContent = 'Decoding and converting to 48 kHz';
  setBar(null);
  show('busy');
  try {
    const dry = await decodeFile(file);
    if (my !== runId) return;
    const name = baseName(file.name);
    session = { name, dry, wet: dry, peaksA: new Float32Array() };
    await run(my);
  } catch (e) {
    if (my !== runId || e instanceof CancelledError) return;
    fail(e);
  }
}

async function run(my: number) {
  const s = session!;
  setBar(null);
  el.busyTitle.textContent = 'Starting…';
  el.busyDetail.textContent = '';
  show('busy');
  player?.pause();
  job = denoise(s.dry, atten, onProgress);
  try {
    s.wet = await job.promise;
  } catch (e) {
    if (e instanceof CancelledError || my !== runId) return;
    throw e;
  } finally {
    job = null;
  }
  if (my !== runId) return;
  showResult(s);
}

function fail(e: unknown) {
  console.error(e);
  el.errorMsg.textContent = e instanceof DecodeError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
  show('error');
}

function teardown() {
  job?.cancel();
  job = null;
  player?.dispose();
  player = null;
  session = null;
}

// ---- result / player -----------------------------------------------------------
let peaksColumns = 0;
function redrawWaves(strengthPeaks?: Float32Array) {
  if (!session) return;
  const css = getComputedStyle(document.documentElement);
  drawPeaks(el.waveA, session.peaksA, css.getPropertyValue('--wave-a'), 1);
  drawPeaks(el.waveB, strengthPeaks ?? peaksB, css.getPropertyValue('--wave-b'), 1);
}
let peaksB: Float32Array = new Float32Array();
function computeWaves() {
  if (!session) return;
  peaksColumns = Math.max(300, Math.min(1600, Math.round(el.waveWrap.clientWidth * (window.devicePixelRatio || 1))));
  session.peaksA = computePeaks(session.dry, null, 0, peaksColumns);
  peaksB = computePeaks(session.dry, session.wet, strength(), peaksColumns);
}
let peaksTimer = 0;
function schedulePeaks() {
  clearTimeout(peaksTimer);
  peaksTimer = window.setTimeout(() => {
    if (!session) return;
    peaksB = computePeaks(session.dry, session.wet, strength(), peaksColumns);
    redrawWaves();
  }, 120);
}
const strength = () => Number(el.strength.value) / 100;

function showResult(s: Session) {
  if (!player) {
    player = new ABPlayer();
    player.onEnded = () => syncUi();
  }
  const dur = s.dry.length / SAMPLE_RATE;
  player.load(s.dry, s.wet);
  player.setStrength(strength());
  player.setSource(el.abA.checked ? 'original' : 'enhanced');
  el.resultName.textContent = s.name;
  el.resultMeta.textContent = `${fmtTime(dur)} · ${s.dry.numberOfChannels === 1 ? 'mono' : 'stereo'} · 48 kHz`;
  el.timeTotal.textContent = fmtTime(dur);
  el.attenResult.value = String(atten);
  el.exportStatus.textContent = '';
  show('result');
  computeWaves();
  redrawWaves();
  syncUi();
  el.play.focus({ preventScroll: true });
}

function syncUi() {
  const p = player;
  if (!p) return;
  el.iconPlay.hidden = p.playing;
  el.iconPause.hidden = !p.playing;
  el.play.setAttribute('aria-label', p.playing ? 'Pause' : 'Play');
  const pos = p.position, dur = p.duration || 1;
  el.timeNow.textContent = fmtTime(pos);
  const w = el.waveWrap.clientWidth - 20;
  el.playhead.style.transform = `translateX(${(pos / dur) * w}px)`;
  if (document.activeElement !== el.seek) el.seek.value = String(Math.round((pos / dur) * 1000));
}
function tick() {
  if (player?.playing) syncUi();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function setSource(s: Source) {
  (s === 'original' ? el.abA : el.abB).checked = true;
  player?.setSource(s);
}

el.abA.addEventListener('change', () => player?.setSource('original'));
el.abB.addEventListener('change', () => player?.setSource('enhanced'));
el.play.addEventListener('click', async () => { await player?.toggle(); syncUi(); });
el.seek.addEventListener('input', async () => {
  if (!player) return;
  await player.seek((Number(el.seek.value) / 1000) * player.duration);
  syncUi();
});
el.strength.addEventListener('input', () => {
  el.strengthOut.textContent = `${el.strength.value}%`;
  el.strength.setAttribute('aria-valuetext', `${el.strength.value} percent`);
  player?.setStrength(strength());
  schedulePeaks();
});

// ---- export -----------------------------------------------------------------------
async function exportAs(kind: 'wav' | 'mp3') {
  if (!session) return;
  const s = session;
  el.dlWav.disabled = el.dlMp3.disabled = true;
  const label = kind.toUpperCase();
  el.exportStatus.textContent = kind === 'mp3' ? 'Loading MP3 encoder…' : 'Preparing WAV…';
  try {
    const mix = makeMixer(s.dry, s.wet, strength());
    const prog = (f: number) => { el.exportStatus.textContent = `Encoding ${label}… ${Math.round(f * 100)}%`; };
    let blob: Blob;
    if (kind === 'wav') blob = await encodeWav(s.dry.numberOfChannels, s.dry.length, mix, prog);
    else {
      const { encodeMp3 } = await import('./audio/mp3');
      blob = await encodeMp3(s.dry.numberOfChannels, s.dry.length, mix, prog);
    }
    download(blob, `${s.name}-hushvox.${kind}`);
    el.exportStatus.textContent = `${label} ready (${(blob.size / 1048576).toFixed(1)} MB)`;
  } catch (e) {
    console.error(e);
    el.exportStatus.textContent = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    el.dlWav.disabled = el.dlMp3.disabled = false;
  }
}
el.dlWav.addEventListener('click', () => void exportAs('wav'));
el.dlMp3.addEventListener('click', () => void exportAs('mp3'));

// ---- misc controls ---------------------------------------------------------------
el.cancel.addEventListener('click', () => {
  runId++;
  teardown();
  show('idle');
});
function reset() { runId++; teardown(); el.file.value = ''; show('idle'); }
el.another.addEventListener('click', reset);
el.errorBack.addEventListener('click', reset);

el.attenIdle.addEventListener('change', () => { atten = Number(el.attenIdle.value); el.attenResult.value = el.attenIdle.value; });
el.attenResult.addEventListener('change', () => {
  atten = Number(el.attenResult.value);
  el.attenIdle.value = el.attenResult.value;
  if (!session) return;
  const my = ++runId;
  run(my).catch((e) => { if (my === runId) fail(e); });
});

el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  if (f) void handleFile(f);
});
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    if (!(e as DragEvent).dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!states.idle.hidden) el.drop.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || (e as DragEvent).relatedTarget === null) el.drop.classList.remove('over');
  });
}
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f && states.busy.hidden) void handleFile(f);
});

window.addEventListener('resize', () => {
  if (session && !states.result.hidden) { computeWaves(); redrawWaves(); syncUi(); }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => redrawWaves());

window.addEventListener('keydown', (e) => {
  if (!player || states.result.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement;
  const typing = t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === 'text');
  if (typing) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ' && !(t instanceof HTMLButtonElement) ) { e.preventDefault(); void player.toggle().then(syncUi); }
  else if (k === 'a') setSource('original');
  else if (k === 'b') setSource('enhanced');
  else if (k === 'x') setSource(player.source === 'enhanced' ? 'original' : 'enhanced');
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(t instanceof HTMLInputElement)) {
    e.preventDefault();
    void player.seek(player.position + (e.key === 'ArrowRight' ? 5 : -5)).then(syncUi);
  }
});
