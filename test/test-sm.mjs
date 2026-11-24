import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSM,
  exportDocument,
  beatToSeconds,
  secondsToBeat,
  ticksToBeat,
  beatToTicks,
  quantizeTicks,
  quantization,
  serializeNoteData,
  parseNoteData,
  notesEqual,
  countNotes,
  newDocument,
  addDifficulty,
  measurePlan,
  parseTimeSignatures,
} from "../sm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL:", msg);
  } else {
    passed++;
    console.log("ok:", msg);
  }
}

function assertEq(a, b, msg) {
  if (a !== b) {
    failed++;
    console.error("FAIL:", msg, "\n  expected:", JSON.stringify(b), "\n  got:     ", JSON.stringify(a));
  } else {
    passed++;
    console.log("ok:", msg);
  }
}

function assertClose(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) {
    failed++;
    console.error("FAIL:", msg, "expected", b, "got", a);
  } else {
    passed++;
    console.log("ok:", msg);
  }
}

// --- timing ---
{
  const timing = {
    offset: -1,
    bpms: [
      { beat: 0, bpm: 120 },
      { beat: 4, bpm: 60 },
    ],
    stops: [],
  };
  // beat 0 at t = -offset = 1
  assertClose(beatToSeconds(0, timing), 1, 1e-9, "beat 0 time with offset -1 is 1s");
  // 4 beats at 120bpm = 2s, so beat 4 at 3s
  assertClose(beatToSeconds(4, timing), 3, 1e-9, "beat 4 time after 120bpm run");
  // 4 more beats at 60bpm = 4s, beat 8 at 7s
  assertClose(beatToSeconds(8, timing), 7, 1e-9, "beat 8 time after bpm change");
  assertClose(secondsToBeat(1, timing), 0, 1e-9, "inverse: 1s -> beat 0");
  assertClose(secondsToBeat(3, timing), 4, 1e-9, "inverse: 3s -> beat 4");
  assertClose(secondsToBeat(7, timing), 8, 1e-9, "inverse: 7s -> beat 8");

  const withStop = { ...timing, stops: [{ beat: 4, seconds: 0.5 }] };
  assertClose(beatToSeconds(4, withStop), 3, 1e-9, "stop does not delay the note at its beat");
  assertClose(beatToSeconds(8, withStop), 7.5, 1e-9, "stop adds 0.5s after beat 4");
  assertClose(secondsToBeat(3.25, withStop), 4, 1e-9, "playhead freezes at stop beat during stop");
  assertClose(secondsToBeat(3.5, withStop), 4, 1e-9, "playhead still frozen at end of stop");
  assertClose(secondsToBeat(7.5, withStop), 8, 1e-9, "inverse after stop");
}

// --- quantization ---
{
  assertEq(quantization(0), 4, "beat 0 is a 4th");
  assertEq(quantization(1), 4, "beat 1 is a 4th");
  assertEq(quantization(0.5), 8, "beat 0.5 is an 8th");
  assertEq(quantization(1 / 3), 12, "beat 1/3 is a 12th");
  assertEq(quantization(0.25), 16, "beat 0.25 is a 16th");
  assertEq(quantization(1 / 6), 24, "beat 1/6 is a 24th");
  assertEq(quantization(0.125), 32, "beat 0.125 is a 32nd");
  assertEq(quantization(1 / 12), 48, "beat 1/12 is a 48th");
  assertEq(quantization(1 / 16), 64, "beat 1/16 is a 64th");
  assertEq(quantization(1 / 48), 192, "beat 1/48 is a 192nd");
}

// --- place a 16th in measure 2 and confirm row ---
{
  const doc = newDocument({ title: "Place Test", bpm: 140, offset: -0.5, measures: 8 });
  const chart = doc.charts[0];
  // measure 1 (0-based) starts at beat 4. Note at beat 5.25, column 2 (index 1).
  const beat = 5.25;
  const tick = beatToTicks(beat);
  chart.notes.push({ tick, col: 1, type: "1" });
  chart.dirty = true;
  const out = exportDocument(doc);
  const again = parseSM(out);
  const notes = again.charts[0].notes;
  assertEq(notes.length, 1, "placed one note");
  assertEq(notes[0].col, 1, "placed note column is 1 (column 2)");
  assertEq(notes[0].tick, tick, "placed note tick is 5.25");
  assertEq(notes[0].type, "1", "placed note is a tap");

  // Inspect raw rows of measure 1 (second measure)
  const body = again.charts[0].notesText;
  const measures = body.split(",");
  const rows = measures[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9MLF]{4}$/.test(l));
  assertEq(rows.length, 16, "measure 1 written at 16th resolution");
  // offset 1.25 beats into a 4-beat measure at 16 rows: row = 1.25/4*16 = 5
  assertEq(rows[5], "0100", "row 5 of measure 1 is 0100");
  assert(
    rows.every((r, i) => (i === 5 ? r === "0100" : r === "0000")),
    "no other notes in that measure"
  );
}

// --- note on a measure boundary ---
{
  const doc = newDocument({ title: "Boundary", bpm: 120, measures: 2 });
  const chart = doc.charts[0];
  chart.notes.push({ tick: beatToTicks(4), col: 0, type: "1" });
  chart.dirty = true;
  const out = exportDocument(doc);
  const again = parseSM(out);
  assertEq(again.charts[0].notes.length, 1, "boundary note survived");
  assertEq(again.charts[0].notes[0].tick, beatToTicks(4), "boundary note stays at beat 4");
  const measures = again.charts[0].notesText.split(",");
  const m1 = measures[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9MLF]{4}$/.test(l));
  assertEq(m1[0], "1000", "beat 4 is row 0 of measure 1");
}

// --- 6/4 time signature measure length and row count ---
{
  const sm = `#TITLE:TS; #OFFSET:0; #BPMS:0.000000=120.000000; #STOPS:; #TIMESIGNATURES:0.000000=4=4,8.000000=6=4,14.000000=4=4;
#NOTES:
     dance-single:
     :
     Challenge:
     1:
     0,0,0,0,0:
0000
0000
0000
0000
,
0000
0000
0000
0000
,
1000
0000
0100
0000
0010
0000
;
`;
  const doc = parseSM(sm);
  const timesigs = doc.timesigs;
  assertEq(timesigs.length, 3, "parsed 3 time signatures");
  const plan = measurePlan(timesigs, 3, 0);
  assertClose(plan[0].length, 4, 1e-9, "measure 0 is 4 beats (4/4)");
  assertClose(plan[1].length, 4, 1e-9, "measure 1 is 4 beats (4/4)");
  assertClose(plan[2].length, 6, 1e-9, "measure 2 is 6 beats (6/4)");
  // note at beat 8 (start of 6/4) col 0, and beat 10 col 1, beat 12 col 2
  // written as 8th notes: 6 beats * 8/4 = 12 rows. beat 8 = row 0, beat 10 = row 4, beat 12 = row 8
  const rows = doc.charts[0].notesText
    .split(",")[2]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9MLF]{4}$/.test(l));
  assertEq(rows.length, 6, "6/4 measure stored as 6 rows of 4ths in fixture");
  assertEq(doc.charts[0].notes.length, 3, "three notes in 6/4 fixture");
  assertEq(ticksToBeat(doc.charts[0].notes[0].tick), 8, "first 6/4 note at beat 8");
  assertEq(ticksToBeat(doc.charts[0].notes[1].tick), 10, "second at beat 10");
  assertEq(ticksToBeat(doc.charts[0].notes[2].tick), 12, "third at beat 12");

  // Place an 8th (beat 8.5) in the 6/4 bar; 4ths would be 6 rows, 8ths need 12.
  doc.charts[0].notes.push({ tick: beatToTicks(8.5), col: 3, type: "1" });
  doc.charts[0].dirty = true;
  const out = exportDocument(doc);
  const again = parseSM(out);
  const ticks = again.charts[0].notes.map((n) => `${ticksToBeat(n.tick)}:${n.col}`).sort();
  assert(
    ticks.includes("8.5:3") && ticks.includes("8:0") && ticks.includes("10:1") && ticks.includes("12:2"),
    "new 6/4 note plus originals: " + ticks.join(",")
  );
  const m2 = again.charts[0].notesText
    .split(",")[2]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[0-9MLF]{4}$/.test(l));
  // beat 8.5 is 0.5 beats into a 6-beat measure: row = 0.5/6*12 = 1, "0001"
  assertEq(m2.length, 12, "6/4 measure with an 8th is written as 12 rows");
  assertEq(m2[1], "0001", "beat 8.5 is row 1 at 8th resolution in a 6-beat measure");
}

// --- holds survive a dirty rewrite ---
{
  const doc = newDocument({ title: "LN", bpm: 120, measures: 4 });
  const c = doc.charts[0];
  c.notes.push(
    { tick: beatToTicks(0), col: 0, type: "2" },
    { tick: beatToTicks(1.5), col: 0, type: "3" },
    { tick: beatToTicks(2), col: 3, type: "1" }
  );
  c.dirty = true;
  const out = exportDocument(doc);
  const again = parseSM(out);
  const types = again.charts[0].notes
    .map((n) => `${ticksToBeat(n.tick)}:${n.col}:${n.type}`)
    .sort();
  assert(
    types.includes("0:0:2") && types.includes("1.5:0:3") && types.includes("2:3:1"),
    "hold head/tail and tap survive rewrite: " + types.join(",")
  );
}

// --- unedited export equals input (synthetic two-chart file) ---
{
  const src =
    `#TITLE:Two Diffs;\n#ARTIST:Test;\n#OFFSET:-1.250000;\n#BPMS:0.000000=180.000000\n,64.000000=90.000000\n,96.000000=180.000000\n;\n#STOPS:32.000000=0.250000;\n#TIMESIGNATURES:0.000000=4=4;\n` +
    `//--------------- dance-single - A ----------------\n#NOTES:\n     dance-single:\n     A:\n     Challenge:\n     8:\n     0,0,0,0,0:\n1001\n0100\n1010\n0001\n,\n0002\n0000\n0000\n0003\n;\n` +
    `//--------------- dance-single - B ----------------\n#NOTES:\n     dance-single:\n     B:\n     Hard:\n     6:\n     0,0,0,0,0:\n1100\n0011\n0000\n0000\n;\n`;
  const doc = parseSM(src);
  const out = exportDocument(doc);
  assertEq(out, src, "unedited two-chart file round-trips byte-for-byte");
  assertEq(doc.charts.length, 2, "parsed two charts");
  assertEq(doc.charts[0].difficulty, "Challenge", "first difficulty is Challenge");
  assertEq(doc.charts[1].difficulty, "Hard", "second difficulty is Hard");

  // Edit only Challenge; Hard bytes must stay the same
  doc.charts[0].notes.push({ tick: beatToTicks(1.25), col: 2, type: "1" });
  doc.charts[0].dirty = true;
  const edited = exportDocument(doc);
  const again = parseSM(edited);
  assertEq(again.charts.length, 2, "still two charts after edit");
  assert(notesEqual(again.charts[1].notes, doc.charts[1].notes), "unedited Hard chart notes unchanged");
  assert(
    again.charts[1].notesText.replace(/\s+/g, "") === "1100001100000000",
    "Hard note data still the original 4th-note rows"
  );
  assert(
    again.charts[0].notes.some((n) => n.tick === beatToTicks(1.25) && n.col === 2),
    "new note present in Challenge"
  );
  // original Challenge notes still there
  assert(again.charts[0].notes.some((n) => n.tick === 0 && n.col === 0 && n.type === "1"), "original 1001 survived");
}

// --- add a new difficulty, original notes untouched ---
{
  const src =
    `#TITLE:Add Diff;\n#OFFSET:0.000000;\n#BPMS:0.000000=120.000000;\n#STOPS:;\n#TIMESIGNATURES:0.000000=4=4;\n` +
    `#NOTES:\n     dance-single:\n     :\n     Challenge:\n     1:\n     0,0,0,0,0:\n1000\n0000\n0000\n0000\n;\n`;
  const doc = parseSM(src);
  const idx = addDifficulty(doc, { difficulty: "Hard", meter: "5", credit: "SRT." });
  doc.charts[idx].notes.push({ tick: beatToTicks(0), col: 3, type: "1" });
  const out = exportDocument(doc);
  const again = parseSM(out);
  assertEq(again.charts.length, 2, "added a second difficulty");
  assertEq(again.charts[0].difficulty, "Challenge", "original difficulty kept");
  assertEq(again.charts[1].difficulty, "Hard", "new difficulty is Hard");
  assertEq(again.charts[1].credit, "SRT.", "new credit kept");
  assert(notesEqual(again.charts[0].notes, doc.charts[0].notes), "original chart notes untouched after adding Hard");
  assertEq(again.charts[1].notes[0].col, 3, "new Hard note in column 4");
}

// --- real files: exact unedited round-trip + semantic rewrite ---
const realFiles = [
  "/workspace/zera_wip/Zera_complete.sm",
  "/workspace/chartvideo/butcher/ButcherVanity.sm",
  "/workspace/nidaime_wip/NidaimeEnma_complete.sm",
  "/workspace/bakenohana/BakeNoHana.sm",
];

for (const path of realFiles) {
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    console.log("skip (missing):", path);
    continue;
  }
  const name = path.split("/").pop();
  const doc = parseSM(src);
  const out = exportDocument(doc);
  assertEq(out, src, `${name}: unedited export equals input`);
  const chart = doc.charts.find((c) => c.editable) || doc.charts[0];
  if (!chart) continue;
  const counts = countNotes(chart.notes);
  console.log(`   ${name}: ${counts.total} notes (${counts.taps} taps, ${counts.holds} holds), ${chart.measureCount} measures, bpms=${doc.bpms.length}`);

  // Rewrite the same notes (dirty) and check semantic equality
  chart.dirty = true;
  const rewritten = exportDocument(doc);
  const again = parseSM(rewritten);
  const c2 = again.charts[0];
  assert(notesEqual(c2.notes, chart.notes), `${name}: dirty rewrite is semantically equal`);
  assertEq(c2.measureCount, chart.measureCount, `${name}: measure count preserved on rewrite`);
}

// --- snap helper ---
{
  assertEq(quantizeTicks(beatToTicks(5.2), 16), beatToTicks(5.25), "5.2 snaps to 5.25 at 16ths");
  assertEq(quantizeTicks(beatToTicks(5.1), 16), beatToTicks(5.0), "5.1 snaps to 5.0 at 16ths");
}

console.log("\n" + passed + " passed,", failed + " failed");
if (failed) process.exit(1);
