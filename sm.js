/**
 * StepMania / Etterna .sm parse, timing, and serialize.
 * dance-single (4-key) focused. Works in the browser and in Node.
 */

export const TICKS_PER_BEAT = 48;
export const RESOLUTIONS = [4, 8, 12, 16, 24, 32, 48, 64, 192];

/** DivideByZero / ArrowVortex-style quantization colors. */
export const QUANT_COLORS = {
  4: "#FF3B3B",
  8: "#3B6CFF",
  12: "#3CCF6A",
  16: "#F0D03C",
  24: "#C04CFF",
  32: "#FF9A2E",
  48: "#2ED4D4",
  64: "#B4B4B4",
  192: "#D8D8D8",
};

export function beatToTicks(beat) {
  return Math.round(Number(beat) * TICKS_PER_BEAT);
}

export function ticksToBeat(ticks) {
  return ticks / TICKS_PER_BEAT;
}

export function snapTicks(snap) {
  return (TICKS_PER_BEAT * 4) / snap;
}

export function quantizeTicks(ticks, snap) {
  const st = snapTicks(snap);
  return Math.round(ticks / st) * st;
}

export function quantization(beat) {
  const t = Math.abs(beatToTicks(beat));
  if (t % 48 === 0) return 4;
  if (t % 24 === 0) return 8;
  if (t % 16 === 0) return 12;
  if (t % 12 === 0) return 16;
  if (t % 8 === 0) return 24;
  if (t % 6 === 0) return 32;
  if (t % 4 === 0) return 48;
  if (t % 3 === 0) return 64;
  return 192;
}

export function quantColor(beat) {
  return QUANT_COLORS[quantization(beat)] || QUANT_COLORS[192];
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function findSemicolon(text, i) {
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === ";") return i;
    i++;
  }
  return -1;
}

export function parseListPairs(value, arity) {
  const out = [];
  const s = String(value || "").trim();
  if (!s) return out;
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const bits = p.split("=").map((x) => x.trim());
    if (arity === 2 && bits.length >= 2) {
      const a = parseFloat(bits[0]);
      const b = parseFloat(bits[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) out.push({ beat: a, value: b });
    } else if (arity === 3 && bits.length >= 3) {
      const a = parseFloat(bits[0]);
      const b = parseInt(bits[1], 10);
      const c = parseInt(bits[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) {
        out.push({ beat: a, num: b, den: c });
      }
    }
  }
  return out;
}

export function parseBpms(value) {
  const pairs = parseListPairs(value, 2).map((p) => ({ beat: p.beat, bpm: p.value }));
  if (!pairs.length) pairs.push({ beat: 0, bpm: 120 });
  pairs.sort((a, b) => a.beat - b.beat);
  if (pairs[0].beat > 0) pairs.unshift({ beat: 0, bpm: pairs[0].bpm });
  return pairs;
}

export function parseStops(value) {
  return parseListPairs(value, 2)
    .map((p) => ({ beat: p.beat, seconds: p.value }))
    .sort((a, b) => a.beat - b.beat);
}

export function parseTimeSignatures(value) {
  const list = parseListPairs(value, 3);
  if (!list.length) list.push({ beat: 0, num: 4, den: 4 });
  list.sort((a, b) => a.beat - b.beat);
  if (list[0].beat > 0) list.unshift({ beat: 0, num: 4, den: 4 });
  return list;
}

export function beatsPerMeasure(sig) {
  const den = sig.den || 4;
  return (sig.num * 4) / den;
}

export function timeSigAt(beat, timesigs) {
  let cur = timesigs[0] || { beat: 0, num: 4, den: 4 };
  for (const s of timesigs) {
    if (s.beat <= beat + 1e-9) cur = s;
    else break;
  }
  return cur;
}

/**
 * Time in seconds of a beat (the instant the beat occurs, before a stop on that beat).
 * Beat 0 occurs at t = -offset.
 */
export function beatToSeconds(beat, timing) {
  const offset = Number(timing.offset || 0);
  const bpms = timing.bpms && timing.bpms.length ? timing.bpms : [{ beat: 0, bpm: 120 }];
  const stops = timing.stops || [];
  let t = -offset;
  const firstBpm = bpms[0].bpm || 120;
  if (beat < 0) {
    t += beat * (60 / firstBpm);
  } else {
    for (let i = 0; i < bpms.length; i++) {
      const start = bpms[i].beat;
      const end = i + 1 < bpms.length ? bpms[i + 1].beat : Infinity;
      const a = Math.max(start, 0);
      const b = Math.min(end, beat);
      if (b > a) t += ((b - a) * 60) / (bpms[i].bpm || 120);
      if (end >= beat) break;
    }
  }
  for (const st of stops) {
    if (st.beat < beat - 1e-12) t += st.seconds;
  }
  return t;
}

/**
 * Inverse of beatToSeconds. During a stop, returns the stop beat (playhead freezes).
 */
export function secondsToBeat(sec, timing) {
  const bpms = timing.bpms && timing.bpms.length ? timing.bpms : [{ beat: 0, bpm: 120 }];
  const stops = (timing.stops || []).slice().sort((a, b) => a.beat - b.beat);
  const firstBpm = bpms[0].bpm || 120;
  let t = -Number(timing.offset || 0);
  if (sec <= t) {
    return ((sec - t) * firstBpm) / 60;
  }
  // Walk bpm segments, inserting stops.
  const stopAt = new Map();
  for (const st of stops) {
    stopAt.set(st.beat, (stopAt.get(st.beat) || 0) + st.seconds);
  }
  for (let i = 0; i < bpms.length; i++) {
    const start = Math.max(bpms[i].beat, 0);
    const end = i + 1 < bpms.length ? bpms[i + 1].beat : start + 1e9;
    const bpm = bpms[i].bpm || 120;
    // Stops in [start, end)
    const midStops = stops.filter((s) => s.beat >= start - 1e-12 && s.beat < end - 1e-12);
    let cursor = start;
    const points = [...midStops.map((s) => s.beat), end];
    points.sort((a, b) => a - b);
    for (const pt of points) {
      if (pt > cursor) {
        const dur = ((pt - cursor) * 60) / bpm;
        if (sec <= t + dur) {
          return cursor + ((sec - t) * bpm) / 60;
        }
        t += dur;
        cursor = pt;
      }
      if (pt < end && stopAt.has(pt)) {
        const hold = stopAt.get(pt);
        if (sec <= t + hold) return pt;
        t += hold;
      }
    }
  }
  const last = bpms[bpms.length - 1];
  return last.beat + ((sec - t) * (last.bpm || 120)) / 60;
}

export function measurePlan(timesigs, measureCount, endBeat) {
  const starts = [];
  let beat = 0;
  let guard = 0;
  const minCount = measureCount || 0;
  const needBeat = endBeat == null ? 0 : endBeat;
  // Keep writing measures until we cover the last note (beat < needBeat means
  // a note sits on this measure start) and the original measure count.
  while (guard++ < 20000) {
    if (starts.length >= Math.max(minCount, 1) && beat > needBeat + 1e-9) break;
    const sig = timeSigAt(beat, timesigs);
    const len = beatsPerMeasure(sig);
    starts.push({ start: beat, length: len, sig });
    beat += len;
  }
  if (!starts.length) {
    starts.push({ start: 0, length: 4, sig: { beat: 0, num: 4, den: 4 } });
  }
  return starts;
}

function stripCommentsFromLine(line) {
  const i = line.indexOf("//");
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

export function parseNoteData(notesText, timesigs) {
  const notes = [];
  const chunks = notesText.split(",");
  let measureBeat = 0;
  let measureCount = 0;
  for (const chunk of chunks) {
    const rows = [];
    for (const rawLine of chunk.split(/\r?\n/)) {
      const s = stripCommentsFromLine(rawLine);
      if (!s) continue;
      if (/^[0-9MLFmlf]{4,}$/.test(s)) rows.push(s);
    }
    const sig = timeSigAt(measureBeat, timesigs);
    const length = beatsPerMeasure(sig);
    const nRows = rows.length;
    if (nRows > 0) {
      for (let r = 0; r < nRows; r++) {
        const row = rows[r];
        const beat = measureBeat + (r / nRows) * length;
        const tick = beatToTicks(beat);
        const cols = Math.min(4, row.length);
        for (let c = 0; c < cols; c++) {
          const ch = row[c];
          if (ch && ch !== "0") {
            notes.push({ tick, col: c, type: ch.toUpperCase() });
          }
        }
      }
    }
    measureBeat += length;
    measureCount++;
  }
  return { notes, measureCount, endBeat: measureBeat };
}

export function serializeMeasure(notes, startBeat, lengthBeats, newline) {
  const startTick = beatToTicks(startBeat);
  const lengthTicks = Math.round(lengthBeats * TICKS_PER_BEAT);
  const tryRes = (res) => {
    const rowsF = (lengthBeats * res) / 4;
    const nRows = Math.round(rowsF);
    if (nRows < 1) return null;
    if (Math.abs(rowsF - nRows) > 1e-8) return null;
    const grid = Array.from({ length: nRows }, () => ["0", "0", "0", "0"]);
    for (const n of notes) {
      const rel = n.tick - startTick;
      const rowF = rel / (lengthTicks / nRows);
      const row = Math.round(rowF);
      if (row < 0 || row >= nRows || Math.abs(rowF - row) > 1e-6) return null;
      grid[row][n.col] = n.type;
    }
    return grid.map((r) => r.join("")).join(newline);
  };
  for (const res of RESOLUTIONS) {
    const s = tryRes(res);
    if (s != null) return s;
  }
  return tryRes(192) || "0000";
}

export function serializeNoteData(notes, timesigs, measureCount, newline = "\n") {
  let maxTick = 0;
  for (const n of notes) if (n.tick > maxTick) maxTick = n.tick;
  const endBeat = ticksToBeat(maxTick);
  const plan = measurePlan(timesigs, measureCount, endBeat);
  const measures = [];
  for (const m of plan) {
    const startTick = beatToTicks(m.start);
    const endTick = beatToTicks(m.start + m.length);
    const inM = notes.filter((n) => n.tick >= startTick && n.tick < endTick);
    measures.push(serializeMeasure(inM, m.start, m.length, newline));
  }
  return newline + measures.join("," + newline) + newline;
}

function parseNotesFields(value) {
  const fields = [];
  let i = 0;
  let cur = "";
  while (i < value.length && fields.length < 5) {
    if (value[i] === "/" && value[i + 1] === "/") {
      while (i < value.length && value[i] !== "\n") i++;
      continue;
    }
    if (value[i] === ":") {
      fields.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += value[i];
    i++;
  }
  return { fields, dataOffset: i };
}

export function parseSM(text) {
  if (typeof text !== "string") text = String(text);
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const raw = bom ? "\uFEFF" + text : text;
  const newline = detectNewline(text);
  const tags = {};
  const tagList = [];
  const charts = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] !== "#") {
      i++;
      continue;
    }
    const tagStart = i;
    i++;
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9\-_]/i.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] !== ":") continue;
    i++; // skip :
    const valueStart = i;
    const semi = findSemicolon(text, i);
    if (semi < 0) break;
    const value = text.slice(valueStart, semi);
    const tagEnd = semi + 1;
    if (name.toUpperCase() === "NOTES") {
      const { fields, dataOffset } = parseNotesFields(value);
      const notesText = value.slice(dataOffset);
      const notesDataStart = (bom ? 1 : 0) + valueStart + dataOffset;
      const notesDataEnd = (bom ? 1 : 0) + semi;
      charts.push({
        stepstype: (fields[0] || "").trim(),
        credit: (fields[1] || "").trim(),
        difficulty: (fields[2] || "").trim(),
        meter: (fields[3] || "").trim(),
        radar: (fields[4] || "").trim(),
        notesText,
        notesDataStart,
        notesDataEnd,
        blockStart: (bom ? 1 : 0) + tagStart,
        blockEnd: (bom ? 1 : 0) + tagEnd,
        notes: [],
        measureCount: 0,
        endBeat: 0,
        dirty: false,
        editable: false,
      });
    } else {
      const key = name.toUpperCase();
      tags[key] = value;
      tagList.push({ name: key, value, start: (bom ? 1 : 0) + tagStart, end: (bom ? 1 : 0) + tagEnd });
    }
    i = tagEnd;
  }

  const bpms = parseBpms(tags.BPMS);
  const stops = parseStops(tags.STOPS).concat(parseStops(tags.DELAYS));
  stops.sort((a, b) => a.beat - b.beat);
  const timesigs = parseTimeSignatures(tags.TIMESIGNATURES);
  const offset = parseFloat(tags.OFFSET || "0");
  const safeOffset = Number.isFinite(offset) ? offset : 0;

  for (const c of charts) {
    const parsed = parseNoteData(c.notesText, timesigs);
    c.notes = parsed.notes;
    c.measureCount = parsed.measureCount;
    c.endBeat = parsed.endBeat;
    const st = (c.stepstype || "").toLowerCase();
    c.editable = st === "dance-single" || st === "";
  }

  return {
    raw,
    bom,
    newline,
    tags,
    tagList,
    bpms,
    stops,
    timesigs,
    offset: safeOffset,
    charts,
  };
}

export function timingOf(doc) {
  return { offset: doc.offset, bpms: doc.bpms, stops: doc.stops };
}

export function countNotes(notes) {
  let taps = 0;
  let holds = 0;
  let mines = 0;
  for (const n of notes) {
    if (n.type === "1") taps++;
    else if (n.type === "2" || n.type === "4") holds++;
    else if (n.type === "M") mines++;
  }
  return { taps, holds, mines, total: taps + holds };
}

export function notesKeySet(notes) {
  const set = new Set();
  for (const n of notes) set.add(`${n.tick}:${n.col}:${n.type}`);
  return set;
}

export function notesEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...notesKeySet(a)].sort();
  const sb = [...notesKeySet(b)].sort();
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

export function findNote(notes, tick, col) {
  return notes.find((n) => n.tick === tick && n.col === col) || null;
}

export function holdPairs(notes) {
  const byCol = [[], [], [], []];
  for (const n of notes) {
    if (n.col >= 0 && n.col < 4) byCol[n.col].push(n);
  }
  const pairs = [];
  for (let c = 0; c < 4; c++) {
    const list = byCol[c].slice().sort((a, b) => a.tick - b.tick);
    let open = null;
    for (const n of list) {
      if (n.type === "2" || n.type === "4") {
        if (open) pairs.push({ head: open, tail: null });
        open = n;
      } else if (n.type === "3") {
        if (open) {
          pairs.push({ head: open, tail: n });
          open = null;
        } else {
          pairs.push({ head: null, tail: n });
        }
      }
    }
    if (open) pairs.push({ head: open, tail: null });
  }
  return pairs;
}

/**
 * Write the document back to .sm text.
 * Unedited charts keep their original note-data bytes, so an unedited
 * file round-trips byte-for-byte (plus a possible leading BOM already in raw).
 */
export function exportDocument(doc) {
  const dirtyCharts = doc.charts.filter((c) => c.dirty && !c.isNew);
  const extras = doc.pendingNewCharts || [];
  if (!dirtyCharts.length && !extras.length) return doc.raw;

  let text = doc.raw;
  const splices = dirtyCharts
    .map((c) => ({
      start: c.notesDataStart,
      end: c.notesDataEnd,
      body: serializeNoteData(c.notes, doc.timesigs, c.measureCount, doc.newline),
    }))
    .sort((a, b) => b.start - a.start);
  for (const s of splices) {
    text = text.slice(0, s.start) + s.body + text.slice(s.end);
  }
  if (extras.length) {
    let suffix = text.endsWith("\n") || text.endsWith("\r\n") ? "" : doc.newline;
    for (const ch of extras) {
      const body = serializeNoteData(ch.notes, doc.timesigs, ch.measureCount, doc.newline);
      suffix +=
        `${doc.newline}//--------------- ${ch.stepstype} - ${ch.credit} ----------------${doc.newline}` +
        `#NOTES:${doc.newline}` +
        `     ${ch.stepstype}:${doc.newline}` +
        `     ${ch.credit}:${doc.newline}` +
        `     ${ch.difficulty}:${doc.newline}` +
        `     ${ch.meter}:${doc.newline}` +
        `     ${ch.radar || "0,0,0,0,0"}:${body};${doc.newline}`;
    }
    text += suffix;
  }
  return text;
}

export function newDocument({
  title = "New Chart",
  artist = "",
  music = "",
  offset = 0,
  bpm = 120,
  measures = 16,
  credit = "",
  difficulty = "Challenge",
  meter = "1",
} = {}) {
  const newline = "\n";
  const off = Number(offset);
  const bpmN = Number(bpm);
  const empty = serializeNoteData(
    [],
    [{ beat: 0, num: 4, den: 4 }],
    Math.max(1, Number(measures) || 16),
    newline
  );
  const text =
    `#TITLE:${title};${newline}` +
    `#SUBTITLE:;${newline}` +
    `#ARTIST:${artist};${newline}` +
    `#MUSIC:${music};${newline}` +
    `#CREDIT:${credit};${newline}` +
    `#OFFSET:${off.toFixed(6)};${newline}` +
    `#BPMS:0.000000=${bpmN.toFixed(6)};${newline}` +
    `#STOPS:;${newline}` +
    `#TIMESIGNATURES:0.000000=4=4;${newline}` +
    `//--------------- dance-single - ${credit} ----------------${newline}` +
    `#NOTES:${newline}` +
    `     dance-single:${newline}` +
    `     ${credit}:${newline}` +
    `     ${difficulty}:${newline}` +
    `     ${meter}:${newline}` +
    `     0,0,0,0,0:${empty};${newline}`;
  return parseSM(text);
}

export function addDifficulty(doc, { credit = "", difficulty = "Challenge", meter = "1" } = {}) {
  const src = doc.charts.find((c) => c.editable) || doc.charts[0];
  const measureCount = (src && src.measureCount) || 16;
  doc.pendingNewCharts = doc.pendingNewCharts || [];
  const chart = {
    stepstype: "dance-single",
    credit,
    difficulty,
    meter: String(meter),
    radar: "0,0,0,0,0",
    notes: [],
    measureCount,
    endBeat: measureCount * 4,
    dirty: false,
    editable: true,
    isNew: true,
  };
  doc.pendingNewCharts.push(chart);
  doc.charts.push(chart);
  return doc.charts.length - 1;
}

export function extendMeasures(chart, timesigs, untilBeat) {
  const plan = measurePlan(timesigs, chart.measureCount, untilBeat);
  chart.measureCount = plan.length;
  chart.endBeat = plan.length ? plan[plan.length - 1].start + plan[plan.length - 1].length : 0;
}

export function chartEndBeat(chart, timesigs) {
  const plan = measurePlan(timesigs, chart.measureCount, 0);
  if (!plan.length) return 0;
  const last = plan[plan.length - 1];
  return last.start + last.length;
}
