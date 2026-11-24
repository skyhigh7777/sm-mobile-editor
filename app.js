import {
  RESOLUTIONS,
  QUANT_COLORS,
  parseSM,
  exportDocument,
  newDocument,
  addDifficulty,
  timingOf,
  beatToSeconds,
  secondsToBeat,
  beatToTicks,
  ticksToBeat,
  quantizeTicks,
  quantColor,
  countNotes,
  findNote,
  holdPairs,
  measurePlan,
  chartEndBeat,
  extendMeasures,
  timeSigAt,
  beatsPerMeasure,
} from "./sm.js";

const SNAPS = [4, 8, 12, 16, 24, 32, 48, 64];
const RECEPTOR_Y = 72;
const BOTTOM_PAD = 200;
const DB_NAME = "sm-mobile-editor";
const DB_STORE = "kv";
const SESSION_KEY = "session-v1";

const els = {
  stats: document.getElementById("stats"),
  fileLabel: document.getElementById("fileLabel"),
  chartSelect: document.getElementById("chartSelect"),
  snapRow: document.getElementById("snapRow"),
  scroller: document.getElementById("scroller"),
  sizer: document.getElementById("sizer"),
  canvas: document.getElementById("grid"),
  colHeads: document.getElementById("colHeads"),
  toast: document.getElementById("toast"),
  overlay: document.getElementById("overlay"),
  btnOpenSm: document.getElementById("btnOpenSm"),
  btnOpenAudio: document.getElementById("btnOpenAudio"),
  btnNew: document.getElementById("btnNew"),
  btnExport: document.getElementById("btnExport"),
  fileSm: document.getElementById("fileSm"),
  fileAudio: document.getElementById("fileAudio"),
  btnAddDiff: document.getElementById("btnAddDiff"),
  modeTap: document.getElementById("modeTap"),
  modeLn: document.getElementById("modeLn"),
  btnUndo: document.getElementById("btnUndo"),
  btnRedo: document.getElementById("btnRedo"),
  btnMore: document.getElementById("btnMore"),
  btnPlay: document.getElementById("btnPlay"),
  speedSelect: document.getElementById("speedSelect"),
  assistChk: document.getElementById("assistChk"),
  btnGoto: document.getElementById("btnGoto"),
  zoomRange: document.getElementById("zoomRange"),
  zoomVal: document.getElementById("zoomVal"),
  latencyRange: document.getElementById("latencyRange"),
  latencyVal: document.getElementById("latencyVal"),
  extendCount: document.getElementById("extendCount"),
  btnExtend: document.getElementById("btnExtend"),
  btnClearSession: document.getElementById("btnClearSession"),
  btnCreateNew: document.getElementById("btnCreateNew"),
  btnCreateDiff: document.getElementById("btnCreateDiff"),
  btnDoGoto: document.getElementById("btnDoGoto"),
};

const state = {
  doc: null,
  chartIndex: 0,
  fileName: "chart.sm",
  snap: 16,
  mode: "tap",
  pendingLN: null,
  pxPerBeat: 80,
  speed: 1,
  assist: false,
  latencyMs: 0,
  undo: [],
  redo: [],
  audioName: "",
  audioType: "",
  pointer: null,
  playingInteract: false,
  toastTimer: 0,
};

const player = {
  ctx: null,
  buffer: null,
  source: null,
  gain: null,
  clickBuf: null,
  playing: false,
  rate: 1,
  startCtxTime: 0,
  startSongTime: 0,
  tickScheduledUntil: 0,
  raf: 0,
};

function currentChart() {
  return state.doc && state.doc.charts[state.chartIndex] ? state.doc.charts[state.chartIndex] : null;
}

function timing() {
  return state.doc ? timingOf(state.doc) : { offset: 0, bpms: [{ beat: 0, bpm: 120 }], stops: [] };
}

/* ---------- IndexedDB ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const q = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key, val) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const q = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(val, key);
      q.onsuccess = () => resolve();
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}

async function idbDel(key) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const q = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(key);
      q.onsuccess = () => resolve();
      q.onerror = () => reject(q.error);
    });
  } finally {
    db.close();
  }
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveSession().catch((err) => console.warn("autosave failed", err));
  }, 400);
}

async function saveSession() {
  if (!state.doc) return;
  const smText = exportDocument(state.doc);
  const audioBlob = player.buffer ? await audioBufferToWavBlob(player.buffer).catch(() => null) : null;
  // Prefer the original uploaded blob if we still have it.
  const payload = {
    smText,
    fileName: state.fileName,
    chartIndex: state.chartIndex,
    snap: state.snap,
    mode: state.mode,
    speed: state.speed,
    assist: state.assist,
    latencyMs: state.latencyMs,
    pxPerBeat: state.pxPerBeat,
    scrollBeat: beatAtReceptor(),
    audioName: state.audioName,
    audioType: state.audioType,
    audioBlob: state._audioBlob || audioBlob,
  };
  await idbSet(SESSION_KEY, payload);
}

async function restoreSession() {
  const data = await idbGet(SESSION_KEY);
  if (!data || !data.smText) return false;
  loadDocument(parseSM(data.smText), data.fileName || "chart.sm", { fromRestore: true });
  state.chartIndex = Math.min(data.chartIndex || 0, state.doc.charts.length - 1);
  state.snap = data.snap || 16;
  state.mode = data.mode === "ln" ? "ln" : "tap";
  state.speed = Number(data.speed) || 1;
  state.assist = !!data.assist;
  state.latencyMs = Number(data.latencyMs) || 0;
  state.pxPerBeat = Number(data.pxPerBeat) || 80;
  els.speedSelect.value = String(state.speed);
  els.assistChk.checked = state.assist;
  els.zoomRange.value = String(state.pxPerBeat);
  els.zoomVal.textContent = state.pxPerBeat + "px";
  els.latencyRange.value = String(state.latencyMs);
  els.latencyVal.textContent = state.latencyMs + "ms";
  updateModeButtons();
  fillChartSelect();
  updateSnapButtons();
  resizeCanvas();
  refreshStats();
  if (data.scrollBeat != null) scrollToBeat(data.scrollBeat, false);
  if (data.audioBlob) {
    state._audioBlob = data.audioBlob;
    state.audioName = data.audioName || "audio";
    state.audioType = data.audioType || data.audioBlob.type || "";
    await loadAudioBlob(data.audioBlob, state.audioName);
  }
  return true;
}

/* Keep the original encoded audio when possible so we don't transcode to wav on every save. */
async function audioBufferToWavBlob(buffer) {
  // fallback only
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * numCh * 2, true);
  v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, len * numCh * 2, true);
  let o = 44;
  const chans = Array.from({ length: numCh }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

/* ---------- Audio ---------- */

function ensureCtx() {
  if (!player.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    player.ctx = new Ctx();
    const sr = player.ctx.sampleRate;
    const n = Math.floor(sr * 0.014);
    const buf = player.ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const env = Math.pow(1 - i / n, 3);
      d[i] = env * Math.sin((2 * Math.PI * 1800 * i) / sr);
    }
    player.clickBuf = buf;
  }
  return player.ctx;
}

async function loadAudioBlob(blob, name) {
  ensureCtx();
  const arr = await blob.arrayBuffer();
  player.buffer = await player.ctx.decodeAudioData(arr.slice(0));
  state.audioName = name || state.audioName;
  els.btnPlay.disabled = !state.doc;
  refreshStats();
  toast("音源を読み込んだよ");
}

function hardwareLatency() {
  const ctx = player.ctx;
  if (!ctx) return 0;
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
}

function songTime() {
  if (!player.playing) return player.startSongTime;
  const elapsed = (player.ctx.currentTime - player.startCtxTime) * player.rate;
  return player.startSongTime + elapsed;
}

function visualSongTime() {
  return songTime() - state.latencyMs / 1000 - (player.playing ? hardwareLatency() : 0);
}

function stopSource() {
  if (player.source) {
    try { player.source.stop(); } catch (_) { /* already stopped */ }
    try { player.source.disconnect(); } catch (_) {}
    player.source = null;
  }
  player.playing = false;
  player.tickScheduledUntil = 0;
  els.btnPlay.textContent = "▶";
  if (player.raf) {
    cancelAnimationFrame(player.raf);
    player.raf = 0;
  }
}

function playFrom(songT) {
  if (!player.buffer) return;
  ensureCtx();
  if (player.ctx.state === "suspended") player.ctx.resume();
  stopSource();
  player.rate = state.speed;
  const src = player.ctx.createBufferSource();
  src.buffer = player.buffer;
  src.playbackRate.value = player.rate;
  const gain = player.ctx.createGain();
  gain.gain.value = 1;
  src.connect(gain).connect(player.ctx.destination);
  src.onended = () => {
    if (player.source === src) {
      player.playing = false;
      player.source = null;
      player.startSongTime = songTime();
      els.btnPlay.textContent = "▶";
      if (player.raf) cancelAnimationFrame(player.raf);
      player.raf = 0;
      draw();
    }
  };
  const now = player.ctx.currentTime;
  player.startSongTime = songT;
  player.startCtxTime = now;
  if (songT >= 0 && songT < player.buffer.duration) {
    src.start(now, songT);
  } else if (songT < 0) {
    src.start(now - songT / player.rate, 0);
  } else {
    // past the end
    player.source = null;
    toast("音源の終わりだよ");
    return;
  }
  player.source = src;
  player.gain = gain;
  player.playing = true;
  els.btnPlay.textContent = "■";
  if (state.assist) scheduleTicks();
  loopPlay();
}

function togglePlay() {
  if (!player.buffer || !state.doc) return;
  if (player.playing) {
    const t = songTime();
    stopSource();
    player.startSongTime = t;
    draw();
    return;
  }
  playFrom(beatToSeconds(beatAtReceptor(), timing()));
}

function scheduleTicks() {
  if (!player.playing || !state.assist || !player.clickBuf) return;
  const chart = currentChart();
  if (!chart) return;
  const ctx = player.ctx;
  const nowSong = songTime();
  const ahead = 0.25 * player.rate;
  const from = Math.max(nowSong, player.tickScheduledUntil);
  const to = nowSong + ahead + 0.05;
  const tmg = timing();
  for (const n of chart.notes) {
    if (n.type === "3") continue;
    const t = beatToSeconds(ticksToBeat(n.tick), tmg);
    if (t >= from - 1e-4 && t < to) {
      const when = player.startCtxTime + (t - player.startSongTime) / player.rate;
      if (when > ctx.currentTime + 0.01) {
        const src = ctx.createBufferSource();
        src.buffer = player.clickBuf;
        const g = ctx.createGain();
        g.gain.value = 0.35;
        src.connect(g).connect(ctx.destination);
        src.start(when);
      }
    }
  }
  player.tickScheduledUntil = to;
}

function loopPlay() {
  if (!player.playing) return;
  const t = visualSongTime();
  const beat = secondsToBeat(t, timing());
  scrollToBeat(beat, false);
  if (state.assist) scheduleTicks();
  if (player.buffer && songTime() > player.buffer.duration + 0.05) {
    stopSource();
    player.startSongTime = player.buffer.duration;
    draw();
    return;
  }
  player.raf = requestAnimationFrame(loopPlay);
}

/* ---------- Layout / canvas ---------- */

function colLayout(width) {
  const padL = 44;
  const padR = 8;
  const inner = Math.max(80, width - padL - padR);
  const colW = inner / 4;
  return {
    padL,
    padR,
    colW,
    x(col) { return padL + col * colW; },
  };
}

function chartHeight() {
  const chart = currentChart();
  if (!chart || !state.doc) return els.scroller.clientHeight + 1;
  const end = chartEndBeat(chart, state.doc.timesigs);
  return RECEPTOR_Y + end * state.pxPerBeat + BOTTOM_PAD;
}

function beatFromContentY(y) {
  return (y - RECEPTOR_Y) / state.pxPerBeat;
}

function contentYFromBeat(beat) {
  return RECEPTOR_Y + beat * state.pxPerBeat;
}

function beatAtReceptor() {
  return beatFromContentY(els.scroller.scrollTop + RECEPTOR_Y);
}

function scrollToBeat(beat, smooth) {
  const top = Math.max(0, contentYFromBeat(beat) - RECEPTOR_Y);
  if (smooth) els.scroller.scrollTo({ top, behavior: "smooth" });
  else els.scroller.scrollTop = top;
}

function resizeCanvas() {
  const scroller = els.scroller;
  const canvas = els.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = scroller.clientWidth || window.innerWidth;
  const h = scroller.clientHeight || 400;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  els.sizer.style.height = chartHeight() + "px";
  layoutColHeads(w);
  draw();
}

function layoutColHeads(width) {
  const L = colLayout(width);
  const spans = els.colHeads.querySelectorAll(".col-num");
  spans.forEach((sp, i) => {
    sp.style.left = L.x(i) + "px";
    sp.style.width = L.colW + "px";
  });
}

function visibleRange() {
  const top = els.scroller.scrollTop;
  const h = els.scroller.clientHeight;
  return {
    beat0: beatFromContentY(top) - 1,
    beat1: beatFromContentY(top + h) + 1,
    top,
    h,
  };
}

function draw() {
  const canvas = els.canvas;
  const ctx = canvas.getContext("2d");
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const L = colLayout(w);
  const vis = visibleRange();
  const chart = currentChart();

  // column backgrounds
  for (let c = 0; c < 4; c++) {
    ctx.fillStyle = c % 2 === 0 ? "#12141c" : "#151821";
    ctx.fillRect(L.x(c), 0, L.colW, h);
  }

  if (!state.doc || !chart) {
    ctx.fillStyle = "#8b90a3";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("譜面を開くか、新規で始めてね", w / 2, h / 2 - 10);
    ctx.fillText("音源は別に読み込めるよ", w / 2, h / 2 + 14);
    drawReceptor(ctx, w, L);
    return;
  }

  const realPlan = measurePlan(state.doc.timesigs, chart.measureCount, chartEndBeat(chart, state.doc.timesigs) - 1e-6);
  const snap = state.snap;
  const px = state.pxPerBeat;

  for (const m of realPlan) {
    if (m.start + m.length < vis.beat0 || m.start > vis.beat1) continue;
    const y0 = contentYFromBeat(m.start) - vis.top;
    // measure background tint
    ctx.fillStyle = "rgba(255,255,255,0.012)";
    if (Math.round(m.start / Math.max(m.length, 1)) % 2 === 0) {
      ctx.fillRect(L.padL, y0, w - L.padL - L.padR, m.length * px);
    }
    // snap / beat lines
    const step = 4 / snap;
    const lines = Math.round(m.length / step);
    for (let i = 0; i <= lines; i++) {
      const beat = m.start + i * step;
      if (beat > m.start + m.length + 1e-9) break;
      const y = contentYFromBeat(beat) - vis.top;
      const onBeat = Math.abs(beat - Math.round(beat)) < 1e-6;
      const onMeasure = i === 0;
      ctx.beginPath();
      ctx.moveTo(L.padL, y + 0.5);
      ctx.lineTo(w - L.padR, y + 0.5);
      if (onMeasure) {
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 2;
      } else if (onBeat) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
      }
      ctx.stroke();
    }
    // measure number
    ctx.fillStyle = "#8b90a3";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    const measureIndex = realPlan.indexOf(m);
    ctx.fillText(String(measureIndex + 1), L.padL - 6, y0 + 3);
  }

  // holds
  const pairs = holdPairs(chart.notes);
  for (const p of pairs) {
    if (!p.head) continue;
    const b0 = ticksToBeat(p.head.tick);
    const b1 = p.tail ? ticksToBeat(p.tail.tick) : b0 + 0.25;
    if (b1 < vis.beat0 || b0 > vis.beat1) continue;
    const x = L.x(p.head.col);
    const yA = contentYFromBeat(b0) - vis.top;
    const yB = contentYFromBeat(b1) - vis.top;
    const color = quantColor(b0);
    ctx.fillStyle = color + "55";
    const inset = L.colW * 0.28;
    ctx.fillRect(x + inset, yA, L.colW - inset * 2, Math.max(4, yB - yA));
  }

  // pending LN
  if (state.pendingLN) {
    const b0 = ticksToBeat(state.pendingLN.tick);
    const b1 = Math.max(b0, beatAtReceptor());
    const x = L.x(state.pendingLN.col);
    const yA = contentYFromBeat(b0) - vis.top;
    const yB = contentYFromBeat(Math.max(vis.beat0, b1)) - vis.top;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    const inset = L.colW * 0.28;
    ctx.fillRect(x + inset, yA, L.colW - inset * 2, Math.max(4, yB - yA));
  }

  // notes
  const noteH = Math.max(10, Math.min(22, px * 0.28));
  for (const n of chart.notes) {
    const beat = ticksToBeat(n.tick);
    if (beat < vis.beat0 || beat > vis.beat1) continue;
    const y = contentYFromBeat(beat) - vis.top;
    const x = L.x(n.col);
    const color = n.type === "M" ? "#bbbbbb" : quantColor(beat);
    const inset = 6;
    const nx = x + inset;
    const nw = L.colW - inset * 2;
    const ny = y - noteH / 2;
    if (n.type === "3") {
      ctx.fillStyle = color;
      ctx.fillRect(nx, y - 3, nw, 6);
      continue;
    }
    roundRect(ctx, nx, ny, nw, noteH, 4);
    ctx.fillStyle = color;
    ctx.fill();
    if (n.type === "2" || n.type === "4") {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (n.type === "4") {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        for (let s = 0; s < nw; s += 6) ctx.fillRect(nx + s, ny, 3, noteH);
      }
    }
    if (n.type === "M") {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(nx + 4, ny + 3);
      ctx.lineTo(nx + nw - 4, ny + noteH - 3);
      ctx.moveTo(nx + nw - 4, ny + 3);
      ctx.lineTo(nx + 4, ny + noteH - 3);
      ctx.stroke();
    }
  }

  drawReceptor(ctx, w, L);

  // time / beat HUD
  const beat = beatAtReceptor();
  const t = state.doc ? beatToSeconds(beat, timing()) : 0;
  ctx.fillStyle = "rgba(18,20,28,0.7)";
  ctx.fillRect(w - 118, 6, 110, 32);
  ctx.fillStyle = "#e8eaf2";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(formatTime(t), w - 12, 8);
  ctx.fillStyle = "#8b90a3";
  ctx.fillText("beat " + formatBeat(beat), w - 12, 22);
}

function drawReceptor(ctx, w, L) {
  const y = RECEPTOR_Y;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(L.padL, y);
  ctx.lineTo(w - L.padR, y);
  ctx.stroke();
  for (let c = 0; c < 4; c++) {
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1.5;
    const inset = 8;
    ctx.strokeRect(L.x(c) + inset, y - 10, L.colW - inset * 2, 20);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function formatTime(t) {
  const sign = t < 0 ? "-" : "";
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return sign + m + ":" + s.toFixed(2).padStart(5, "0");
}

function formatBeat(b) {
  return (Math.round(b * 1000) / 1000).toFixed(3);
}

/* ---------- Editing ---------- */

function snapshot() {
  const chart = currentChart();
  if (!chart) return null;
  return {
    index: state.chartIndex,
    notes: chart.notes.map((n) => ({ ...n })),
    measureCount: chart.measureCount,
    pendingLN: state.pendingLN ? { ...state.pendingLN } : null,
  };
}

function applySnapshot(snap) {
  if (!snap || !state.doc) return;
  state.chartIndex = snap.index;
  const chart = currentChart();
  if (!chart) return;
  chart.notes = snap.notes.map((n) => ({ ...n }));
  chart.measureCount = snap.measureCount;
  chart.dirty = true;
  state.pendingLN = snap.pendingLN ? { ...snap.pendingLN } : null;
}

function pushUndo() {
  const snap = snapshot();
  if (!snap) return;
  state.undo.push(snap);
  if (state.undo.length > 100) state.undo.shift();
  state.redo.length = 0;
  updateUndoButtons();
}

function undo() {
  if (!state.undo.length) return;
  const cur = snapshot();
  const prev = state.undo.pop();
  state.redo.push(cur);
  applySnapshot(prev);
  updateUndoButtons();
  refreshStats();
  draw();
  scheduleSave();
}

function redo() {
  if (!state.redo.length) return;
  const cur = snapshot();
  const next = state.redo.pop();
  state.undo.push(cur);
  applySnapshot(next);
  updateUndoButtons();
  refreshStats();
  draw();
  scheduleSave();
}

function updateUndoButtons() {
  els.btnUndo.disabled = !state.undo.length;
  els.btnRedo.disabled = !state.redo.length;
}

function eventToColBeat(e) {
  const rect = els.scroller.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top + els.scroller.scrollTop;
  const L = colLayout(els.scroller.clientWidth);
  if (x < L.padL - 4 || x > L.padL + L.colW * 4 + 4) return null;
  const col = Math.max(0, Math.min(3, Math.floor((x - L.padL) / L.colW)));
  const rawBeat = beatFromContentY(y);
  if (rawBeat < -0.05) return null;
  const tick = Math.max(0, quantizeTicks(beatToTicks(rawBeat), state.snap));
  return { col, tick, beat: ticksToBeat(tick) };
}

function removeHoldAt(chart, tick, col) {
  const pairs = holdPairs(chart.notes);
  const hit = pairs.find(
    (p) =>
      p.head &&
      p.head.col === col &&
      ((p.head.tick === tick) || (p.tail && p.tail.tick === tick) ||
        (p.tail && p.head.tick <= tick && p.tail.tick >= tick && (p.head.tick === tick || p.tail.tick === tick)))
  );
  if (!hit || !hit.head) return false;
  chart.notes = chart.notes.filter((n) => n !== hit.head && n !== hit.tail);
  return true;
}

function placeAt(col, tick) {
  const chart = currentChart();
  if (!chart || !chart.editable) {
    toast("この譜面は 4 列の dance-single だけ編集できるよ");
    return;
  }
  const existing = findNote(chart.notes, tick, col);
  pushUndo();

  if (state.mode === "tap") {
    if (existing) {
      if (existing.type === "2" || existing.type === "3" || existing.type === "4") {
        removeHoldAt(chart, tick, col);
      } else {
        chart.notes = chart.notes.filter((n) => n !== existing);
      }
    } else {
      // don't drop a tap on a hold body? allow, SM can have it rarely; skip if exactly on head/tail already handled
      chart.notes.push({ tick, col, type: "1" });
    }
    state.pendingLN = null;
  } else {
    // LN mode
    if (existing) {
      if (existing.type === "2" || existing.type === "3" || existing.type === "4") removeHoldAt(chart, tick, col);
      else chart.notes = chart.notes.filter((n) => n !== existing);
      state.pendingLN = null;
    } else if (!state.pendingLN || state.pendingLN.col !== col) {
      state.pendingLN = { col, tick };
      chart.notes.push({ tick, col, type: "2" });
    } else {
      const head = state.pendingLN.tick;
      if (tick === head) {
        chart.notes = chart.notes.filter((n) => !(n.tick === head && n.col === col && n.type === "2"));
        state.pendingLN = null;
      } else {
        const a = Math.min(head, tick);
        const b = Math.max(head, tick);
        // move head if user tapped earlier
        const headNote = findNote(chart.notes, head, col);
        if (headNote) {
          headNote.tick = a;
          headNote.type = "2";
        } else {
          chart.notes.push({ tick: a, col, type: "2" });
        }
        const atTail = findNote(chart.notes, b, col);
        if (atTail && atTail !== headNote) {
          atTail.type = "3";
          atTail.tick = b;
        } else {
          chart.notes.push({ tick: b, col, type: "3" });
        }
        state.pendingLN = null;
      }
    }
  }

  const end = ticksToBeat(tick);
  if (end >= chartEndBeat(chart, state.doc.timesigs) - 1e-9) {
    extendMeasures(chart, state.doc.timesigs, end);
    els.sizer.style.height = chartHeight() + "px";
  }
  chart.dirty = true;
  refreshStats();
  draw();
  scheduleSave();
}

function onScrollerPointerDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if (player.playing) state.playingInteract = true;
  state.pointer = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    scroll: els.scroller.scrollTop,
    t: Date.now(),
    moved: false,
  };
}

function onScrollerPointerMove(e) {
  if (!state.pointer || e.pointerId !== state.pointer.id) return;
  const dy = Math.abs(e.clientY - state.pointer.y);
  const dx = Math.abs(e.clientX - state.pointer.x);
  if (dy > 10 || dx > 10) {
    state.pointer.moved = true;
    if (player.playing && state.playingInteract) {
      const t = songTime();
      stopSource();
      player.startSongTime = t;
    }
  }
}

function onScrollerPointerUp(e) {
  if (!state.pointer || e.pointerId !== state.pointer.id) return;
  const p = state.pointer;
  state.pointer = null;
  const dt = Date.now() - p.t;
  const moved = p.moved || Math.abs(e.clientY - p.y) > 10 || Math.abs(els.scroller.scrollTop - p.scroll) > 8;
  state.playingInteract = false;
  if (moved || dt > 500) {
    if (state.doc) refreshStats();
    return;
  }
  const hit = eventToColBeat(e);
  if (!hit) return;
  placeAt(hit.col, hit.tick);
}

function onScrollerScroll() {
  draw();
}

/* ---------- Document / UI ---------- */

function loadDocument(doc, fileName, { fromRestore } = {}) {
  state.doc = doc;
  state.fileName = fileName || "chart.sm";
  const first = doc.charts.findIndex((c) => c.editable);
  state.chartIndex = first >= 0 ? first : 0;
  state.pendingLN = null;
  state.undo = [];
  state.redo = [];
  els.btnExport.disabled = false;
  els.btnAddDiff.disabled = false;
  els.chartSelect.disabled = false;
  els.btnGoto.disabled = false;
  els.btnPlay.disabled = !player.buffer;
  fillChartSelect();
  updateUndoButtons();
  updateModeButtons();
  updateSnapButtons();
  resizeCanvas();
  refreshStats();
  scrollToBeat(0, false);
  if (!fromRestore) scheduleSave();
}

function fillChartSelect() {
  const sel = els.chartSelect;
  sel.innerHTML = "";
  if (!state.doc) return;
  state.doc.charts.forEach((c, i) => {
    const opt = document.createElement("option");
    const mark = c.editable ? "" : " (編集不可)";
    opt.value = String(i);
    opt.textContent = `${c.difficulty || "?"}  ${c.meter || ""}  ${c.stepstype || ""}${mark}`;
    sel.appendChild(opt);
  });
  sel.value = String(state.chartIndex);
}

function refreshStats() {
  const chart = currentChart();
  if (!chart || !state.doc) {
    els.stats.textContent = "譜面を開くか、新規で始めてね";
    els.fileLabel.textContent = "";
    return;
  }
  const c = countNotes(chart.notes);
  const bpm = state.doc.bpms.map((b) => b.bpm).join("/") || "?";
  const music = (state.doc.tags.MUSIC || "").trim();
  els.stats.innerHTML =
    `${c.total} ノーツ` +
    (c.holds ? ` / LN ${c.holds}` : "") +
    ` / ${chart.measureCount} 小節<br>` +
    `BPM ${bpm}  OFFSET ${state.doc.offset}`;
  const audio = state.audioName ? `音源: ${state.audioName}` : music ? `音源未読込 (${music})` : "音源未読込";
  els.fileLabel.textContent = `${state.fileName} ・ ${audio}`;
}

function updateModeButtons() {
  els.modeTap.classList.toggle("on", state.mode === "tap");
  els.modeLn.classList.toggle("on", state.mode === "ln");
}

function updateSnapButtons() {
  els.snapRow.querySelectorAll(".snap-btn").forEach((b) => {
    const snap = Number(b.dataset.snap);
    const on = snap === state.snap;
    b.classList.toggle("on", on);
    b.style.background = on ? QUANT_COLORS[snap] || "#7c8cff" : "";
    b.style.color = on ? "#111" : "";
  });
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2400);
}

function openDialog(id) {
  els.overlay.classList.remove("hidden");
  els.overlay.querySelectorAll(".dialog").forEach((d) => d.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

function closeDialog() {
  els.overlay.classList.add("hidden");
  els.overlay.querySelectorAll(".dialog").forEach((d) => d.classList.add("hidden"));
}

function exportNow() {
  if (!state.doc) return;
  const text = exportDocument(state.doc);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  const name = state.fileName.endsWith(".sm") || state.fileName.endsWith(".SM")
    ? state.fileName
    : state.fileName + ".sm";
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("書き出したよ");
}

async function onPickSm(file) {
  const text = await file.text();
  if (!/#NOTES:/i.test(text) && !/#TITLE:/i.test(text)) {
    toast("これは .sm に見えないよ");
    return;
  }
  try {
    const doc = parseSM(text);
    if (!doc.charts.length) {
      toast("譜面（#NOTES）が見つからなかったよ");
      return;
    }
    loadDocument(doc, file.name);
    toast("譜面を読み込んだよ");
  } catch (err) {
    console.error(err);
    toast("読み込みに失敗したよ");
  }
}

async function onPickAudio(file) {
  try {
    ensureCtx();
    if (player.ctx.state === "suspended") await player.ctx.resume();
    state._audioBlob = file;
    state.audioType = file.type || "";
    stopSource();
    await loadAudioBlob(file, file.name);
    scheduleSave();
  } catch (err) {
    console.error(err);
    toast("音源が読めなかったよ（形式を確認してね）");
  }
}

/* ---------- Snap buttons ---------- */

function buildSnapButtons() {
  els.snapRow.innerHTML = "";
  for (const s of SNAPS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "snap-btn";
    b.dataset.snap = String(s);
    b.textContent = s === 4 ? "4" : String(s);
    b.addEventListener("click", () => {
      state.snap = s;
      updateSnapButtons();
      draw();
      scheduleSave();
    });
    els.snapRow.appendChild(b);
  }
  updateSnapButtons();
}

/* ---------- Events ---------- */

function bind() {
  els.btnOpenSm.addEventListener("click", () => els.fileSm.click());
  els.btnOpenAudio.addEventListener("click", () => els.fileAudio.click());
  els.fileSm.addEventListener("change", () => {
    const f = els.fileSm.files && els.fileSm.files[0];
    els.fileSm.value = "";
    if (f) onPickSm(f);
  });
  els.fileAudio.addEventListener("change", () => {
    const f = els.fileAudio.files && els.fileAudio.files[0];
    els.fileAudio.value = "";
    if (f) onPickAudio(f);
  });
  els.btnExport.addEventListener("click", exportNow);
  els.btnNew.addEventListener("click", () => {
    if (player.buffer) {
      const dur = player.buffer.duration;
      const bpm = Number(document.getElementById("newBpm").value) || 140;
      const off = Number(document.getElementById("newOffset").value) || 0;
      const beats = Math.max(0, (dur + off) * bpm / 60);
      const meas = Math.max(8, Math.ceil(beats / 4) + 2);
      document.getElementById("newMeasures").value = String(meas);
    }
    openDialog("dialogNew");
  });
  els.btnCreateNew.addEventListener("click", () => {
    const title = document.getElementById("newTitle").value.trim() || "New Chart";
    const bpm = Number(document.getElementById("newBpm").value);
    const offset = Number(document.getElementById("newOffset").value);
    const measures = Number(document.getElementById("newMeasures").value);
    const credit = document.getElementById("newCredit").value.trim();
    if (!Number.isFinite(bpm) || bpm <= 0) {
      toast("BPM を入れてね");
      return;
    }
    const music = state.audioName || "";
    const doc = newDocument({ title, bpm, offset: Number.isFinite(offset) ? offset : 0, measures, credit, music });
    loadDocument(doc, sanitizeFileName(title) + ".sm");
    closeDialog();
    toast("新しい譜面をつくったよ");
  });
  els.btnAddDiff.addEventListener("click", () => {
    if (!state.doc) return;
    const credit = (currentChart() && currentChart().credit) || state.doc.tags.CREDIT || "";
    document.getElementById("addDiffCredit").value = String(credit).trim();
    openDialog("dialogAddDiff");
  });
  els.btnCreateDiff.addEventListener("click", () => {
    if (!state.doc) return;
    const difficulty = document.getElementById("addDiffName").value;
    const meter = document.getElementById("addDiffMeter").value;
    const credit = document.getElementById("addDiffCredit").value.trim();
    if (state.doc.charts.some((c) => c.editable && c.difficulty === difficulty)) {
      toast("同じ難易度がもうあるよ");
      return;
    }
    const idx = addDifficulty(state.doc, { difficulty, meter, credit });
    state.chartIndex = idx;
    fillChartSelect();
    refreshStats();
    resizeCanvas();
    closeDialog();
    scheduleSave();
    toast(difficulty + " を追加したよ");
  });
  els.chartSelect.addEventListener("change", () => {
    state.chartIndex = Number(els.chartSelect.value) || 0;
    state.pendingLN = null;
    els.sizer.style.height = chartHeight() + "px";
    refreshStats();
    draw();
    scheduleSave();
  });
  els.modeTap.addEventListener("click", () => {
    state.mode = "tap";
    state.pendingLN = null;
    updateModeButtons();
    draw();
  });
  els.modeLn.addEventListener("click", () => {
    state.mode = "ln";
    updateModeButtons();
  });
  els.btnUndo.addEventListener("click", undo);
  els.btnRedo.addEventListener("click", redo);
  els.btnPlay.addEventListener("click", togglePlay);
  els.speedSelect.addEventListener("change", () => {
    state.speed = Number(els.speedSelect.value) || 1;
    if (player.playing) playFrom(songTime());
    scheduleSave();
  });
  els.assistChk.addEventListener("change", () => {
    state.assist = els.assistChk.checked;
    player.tickScheduledUntil = 0;
    if (player.playing && state.assist) scheduleTicks();
    scheduleSave();
  });
  els.btnGoto.addEventListener("click", () => {
    if (!state.doc) return;
    const chart = currentChart();
    const plan = measurePlan(state.doc.timesigs, chart.measureCount, 0);
    document.getElementById("gotoMeasure").max = String(plan.length);
    document.getElementById("gotoMeasure").value = String(
      Math.min(plan.length, Math.max(1, Math.floor(beatAtReceptor() / 4) + 1))
    );
    openDialog("dialogGoto");
  });
  els.btnDoGoto.addEventListener("click", () => {
    const n = Number(document.getElementById("gotoMeasure").value);
    const chart = currentChart();
    if (!chart || !state.doc) return;
    const plan = measurePlan(state.doc.timesigs, chart.measureCount, 0);
    const idx = Math.max(1, Math.min(plan.length, Math.floor(n))) - 1;
    if (player.playing) stopSource();
    scrollToBeat(plan[idx].start, false);
    closeDialog();
    draw();
  });
  els.btnMore.addEventListener("click", () => openDialog("dialogMore"));
  els.zoomRange.addEventListener("input", () => {
    const beat = beatAtReceptor();
    state.pxPerBeat = Number(els.zoomRange.value);
    els.zoomVal.textContent = state.pxPerBeat + "px";
    els.sizer.style.height = chartHeight() + "px";
    scrollToBeat(beat, false);
    draw();
  });
  els.zoomRange.addEventListener("change", scheduleSave);
  els.latencyRange.addEventListener("input", () => {
    state.latencyMs = Number(els.latencyRange.value);
    els.latencyVal.textContent = state.latencyMs + "ms";
  });
  els.latencyRange.addEventListener("change", scheduleSave);
  els.btnExtend.addEventListener("click", () => {
    const chart = currentChart();
    if (!chart) return;
    const n = Math.max(1, Number(els.extendCount.value) || 8);
    pushUndo();
    extendMeasures(chart, state.doc.timesigs, chartEndBeat(chart, state.doc.timesigs) + n * 4 - 0.01);
    chart.dirty = true;
    els.sizer.style.height = chartHeight() + "px";
    refreshStats();
    draw();
    scheduleSave();
    toast(n + " 小節追加したよ");
  });
  els.btnClearSession.addEventListener("click", async () => {
    await idbDel(SESSION_KEY);
    toast("保存した作業を消したよ");
  });

  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) closeDialog();
  });
  els.overlay.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDialog));

  els.scroller.addEventListener("pointerdown", onScrollerPointerDown);
  els.scroller.addEventListener("pointermove", onScrollerPointerMove);
  els.scroller.addEventListener("pointerup", onScrollerPointerUp);
  els.scroller.addEventListener("pointercancel", () => { state.pointer = null; state.playingInteract = false; });
  els.scroller.addEventListener("scroll", onScrollerScroll, { passive: true });

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4") {
      const map = { 4: 4, 8: 8, 6: 16, /* ignore */ };
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveSession().catch(() => {});
  });
  window.addEventListener("pagehide", () => { saveSession().catch(() => {}); });
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "chart";
}

/* ---------- boot ---------- */

buildSnapButtons();
bind();
resizeCanvas();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((err) => {
    console.warn("sw register failed", err);
  });
}

restoreSession()
  .then((ok) => {
    if (ok) toast("前回の編集を復元したよ");
  })
  .catch((err) => console.warn("restore failed", err));
