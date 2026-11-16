import './style.css';
import { decodeFile } from './audio/decode';
import { AppError } from './audio/errors';
import { t, getLang, setLang, chooseLang, resolveLang, parseLang, onLangChange } from './i18n';
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

// ---- translated dynamic text ------------------------------------------------------------
// Anything shown on screen that depends on state is kept as a function and re-rendered when the language changes.
type Msg = () => string;
let busyMsg: { title: Msg; detail: Msg } = { title: () => t('busy.starting'), detail: () => '' };
let phase = '';
function renderBusy() {
  el.busyTitle.textContent = busyMsg.title();
  el.busyTitle.dataset.phase = phase;
  el.busyDetail.textContent = busyMsg.detail();
}
function setBusy(title: Msg, detail: Msg, ph = '') {
  busyMsg = { title, detail };
  phase = ph;
  renderBusy();
}
let exportMsg: Msg | null = null;
function setExport(m: Msg | null) {
  exportMsg = m;
  el.exportStatus.textContent = m ? m() : '';
}
let lastError: unknown = null;
const errText = (e: unknown) => e instanceof AppError ? t(e.key, e.params) : t('err.generic', { msg: e instanceof Error ? e.message : String(e) });
function renderError() { if (lastError !== null) el.errorMsg.textContent = errText(lastError); }

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
      setBusy(() => t('busy.modelCached'), () => t('busy.modelCachedDetail'));
      setBar(null);
    } else {
      const loaded = p.loadedMB!.toFixed(0), total = p.totalMB!.toFixed(0);
      setBusy(() => t('busy.model'), () => t('busy.modelDetail', { loaded, total }));
      setBar(p.fraction);
    }
  } else {
    setBar(p.fraction);
    const speed = p.speed;
    setBusy(
      () => t('busy.removing'),
      () => speed
        ? t('busy.progress', { pct: Math.round(p.fraction * 100), speed: speed.toFixed(1), eta: fmtEta(p.etaSec ?? NaN) })
        : t('busy.starting'),
      'processing',
    );
  }
}

// ---- main flow --------------------------------------------------------------
async function handleFile(file: File) {
  const my = ++runId;
  teardown();
  el.busyFile.textContent = file.name;
  setBusy(() => t('busy.reading'), () => t('busy.decoding'));
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
  setBusy(() => t('busy.starting'), () => '');
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
  lastError = e;
  renderError();
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

function renderMeta() {
  if (!session) return;
  const dur = session.dry.length / SAMPLE_RATE;
  el.resultMeta.textContent = t('result.meta', { dur: fmtTime(dur), channels: t(session.dry.numberOfChannels === 1 ? 'result.mono' : 'result.stereo') });
}

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
  renderMeta();
  el.timeTotal.textContent = fmtTime(dur);
  el.attenResult.value = String(atten);
  setExport(null);
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
  el.play.setAttribute('aria-label', t(p.playing ? 'pause' : 'play'));
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
function renderStrength() {
  el.strengthOut.textContent = `${el.strength.value}%`;
  el.strength.setAttribute('aria-valuetext', t('strength.valuetext', { n: el.strength.value }));
}
el.strength.addEventListener('input', () => {
  renderStrength();
  player?.setStrength(strength());
  schedulePeaks();
});

// ---- export -----------------------------------------------------------------------
async function exportAs(kind: 'wav' | 'mp3') {
  if (!session) return;
  const s = session;
  el.dlWav.disabled = el.dlMp3.disabled = true;
  const label = kind.toUpperCase();
  setExport(() => t(kind === 'mp3' ? 'export.loadMp3' : 'export.prepWav'));
  try {
    const mix = makeMixer(s.dry, s.wet, strength());
    const prog = (f: number) => setExport(() => t('export.encoding', { fmt: label, pct: Math.round(f * 100) }));
    let blob: Blob;
    if (kind === 'wav') blob = await encodeWav(s.dry.numberOfChannels, s.dry.length, mix, prog);
    else {
      const { encodeMp3 } = await import('./audio/mp3');
      blob = await encodeMp3(s.dry.numberOfChannels, s.dry.length, mix, prog);
    }
    download(blob, `${s.name}-hushvox.${kind}`);
    const size = (blob.size / 1048576).toFixed(1);
    setExport(() => t('export.ready', { fmt: label, size }));
  } catch (e) {
    console.error(e);
    const err = e;
    setExport(() => t('export.failed', { msg: err instanceof AppError ? t(err.key, err.params) : err instanceof Error ? err.message : String(err) }));
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

// ---- language ------------------------------------------------------------------------------
const langSelect = $<HTMLSelectElement>('lang');
onLangChange(() => {
  langSelect.value = getLang();
  renderBusy();
  renderError();
  renderMeta();
  renderStrength();
  setExport(exportMsg);
  syncUi();
});
langSelect.addEventListener('change', () => {
  const l = parseLang(langSelect.value);
  if (l) chooseLang(l);
});
setLang(resolveLang());
