// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as td from './td17.js';
import * as core from './mixer-core.js';
import { createSimModule } from './mixer-sim.js';

// A kit where every value agrees, for tests to adjust.
function kit() {
  const m = core.createKit(11);
  for (const p of m.params) p.value = p.original = p.kind === 'pan' ? 0 : -100;
  return m;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('fader law: every level survives a round trip and the stretch is where the note says', () => {
  for (let v = td.VOLUME_MIN; v <= td.VOLUME_MAX; v++) assert.equal(core.levelVal(core.levelPos(v)), v);
  assert.equal(core.levelPos(td.VOLUME_MIN), 0);
  assert.equal(core.levelPos(td.VOLUME_MAX), 1);
  assert.ok(Math.abs(core.levelPos(60) - core.levelPos(-120) - 0.5) < 1e-9); // -12 to +6 dB is half the travel
  assert.ok(Math.abs(core.levelPos(0) - 0.8) < 1e-9); // the 0 dB tick
});

test('value formats', () => {
  assert.equal(core.fmtText('level', td.VOLUME_MIN), '-INF');
  assert.equal(core.fmtText('level', -65), '−6.5 dB');
  assert.equal(core.fmtText('level', 15), '+1.5 dB');
  assert.equal(core.fmtText('level', 0), '0.0 dB');
  assert.equal(core.fmtText('pan', 0), 'C');
  assert.equal(core.fmtText('pan', -8), 'L8');
  assert.equal(core.fmtText('pan', 12), 'R12');
});

test('kit model: ten pads, cymbal zone names, addresses from td17.js', () => {
  const m = core.createKit(0);
  assert.equal(m.pads.length, 10);
  assert.deepEqual(m.pads[8].zones.map((z) => z.name), ['Bow', 'Edge', 'Bell']);
  assert.deepEqual(m.pads[1].zones.map((z) => z.name), ['Head', 'Rim']);
  assert.deepEqual(m.pads[1].extras.map((x) => x.name), ['XStick']);
  assert.deepEqual(m.pads[5].extras.map((x) => x.name), ['Pedal HH']);
  assert.deepEqual(m.pads[1].zones[0].main.addr, td.address.volume(0, 1, 'main'));
  assert.equal(m.params.length, 20 * 3 + 2);
  assert.deepEqual(core.kitNameAddress(99), [0x04, 0x46, 0, 0]);
});

test('pad value follows the first usable layer and skips -INF', () => {
  const m = kit(), snare = m.pads[1];
  snare.zones[0].main.value = td.VOLUME_MIN;
  snare.zones[1].main.value = -40;
  assert.equal(core.padValue(snare, 'level'), -40);
});

test('disagreements match the orange bar', () => {
  const m = kit(), ride = m.pads[8];
  assert.equal(core.padBand(ride, 'level'), null);
  assert.deepEqual(core.disagreements(ride, 'level'), []);

  ride.zones[2].main.value = -130;
  assert.deepEqual(core.padBand(ride, 'level'), [-130, -100]);
  assert.deepEqual(core.disagreements(ride, 'level').map((p) => p.name), ['Bell main']);

  ride.zones[2].main.value = -100;
  ride.zones[0].sub.value = -60; // 4 dB off its main, but the sub is off
  assert.equal(core.padBand(ride, 'level'), null);
  ride.zones[0].sub.on = true;
  assert.deepEqual(core.padBand(ride, 'level'), [-100, -60]);
  assert.deepEqual(core.disagreements(ride, 'level').map((p) => p.name), ['Bow sub']);

  ride.zones[1].pan.value = 5;
  assert.deepEqual(core.padBand(ride, 'pan'), [0, 5]);
});

test('the band can be read from the originals while comparing', () => {
  const m = kit(), tom = m.pads[2];
  tom.zones[1].main.value = -50;
  assert.ok(core.padBand(tom, 'level'));
  assert.equal(core.padBand(tom, 'level', core.originalOf), null);
});

test('related values: other mains, subs that are on, extras; pans only snap to pans', () => {
  const m = kit(), snare = m.pads[1];
  snare.zones[0].main.value = -10;
  snare.zones[1].main.value = -20;
  snare.zones[0].sub.value = -30;
  snare.zones[1].sub.value = -40;
  snare.extras[0].value = -50;
  assert.deepEqual(core.relatedValues(snare, snare.zones[0].main), [-20, -50]);
  snare.zones[0].sub.on = true;
  assert.deepEqual(core.relatedValues(snare, snare.zones[0].main), [-30, -20, -50]);
  snare.zones[1].pan.value = 7;
  assert.deepEqual(core.relatedValues(snare, snare.zones[0].pan), [7]);
  snare.zones[1].main.value = td.VOLUME_MIN;
  assert.ok(!core.relatedValues(snare, snare.zones[0].main).includes(td.VOLUME_MIN));
});

test('snapping picks the nearest spot within 5 px', () => {
  const len = 200, at = (v) => core.levelPos(v);
  assert.equal(core.pickSnap('level', at(0) + 4 / len, len, [0]), 0);
  assert.equal(core.pickSnap('level', at(0) + 6 / len, len, [0]), undefined);
  assert.equal(core.pickSnap('level', at(-5), len, [0, -6]), -6);
});

test('precision mode: 6 px per step, clamped', () => {
  assert.equal(core.fineValue('level', -100, 12), -98);
  assert.equal(core.fineValue('level', -100, -6), -101);
  assert.equal(core.fineValue('pan', 29, 60), 30);
  assert.equal(core.fineValue('level', td.VOLUME_MAX, 6), td.VOLUME_MAX);
});

test('deferred writes: subs that are off, Pedal HH and XStick', () => {
  const m = kit(), snare = m.pads[1];
  assert.equal(core.isDeferred(snare.zones[0].main), false);
  assert.equal(core.isDeferred(snare.zones[0].sub), true);
  snare.zones[0].sub.on = true;
  assert.equal(core.isDeferred(snare.zones[0].sub), false);
  assert.equal(core.isDeferred(snare.extras[0]), true);
});

test('a module edit moves the current value only, so it counts as a change', () => {
  const m = kit(), p = m.pads[3].zones[0].main;
  const edits = core.moduleEdits(m, { address: p.addr, data: td.encodeNibbles(-55, 4) });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].param, p);
  assert.equal(edits[0].value, -55);
  p.value = edits[0].value;
  assert.equal(p.original, -100);
  assert.deepEqual(core.changedParams(m), [p]);
  assert.equal(core.isChanged(m.pads[3]), true);
  assert.equal(core.isChanged(m.pads[4]), false);
});

test('module edits: a sub switch, a block covering a value, other kits ignored', () => {
  const m = kit(), sub = m.pads[1].zones[0].sub;
  assert.deepEqual(core.moduleEdits(m, { address: sub.switchAddr, data: [1] }), [{ param: sub, on: true }]);
  const p = m.pads[1].zones[0].main, block = [p.addr[0], p.addr[1], p.addr[2], 0x00];
  const edits = core.moduleEdits(m, { address: block, data: [0, 0, 0, 0, ...td.encodeNibbles(-7, 4)] });
  assert.equal(edits.find((e) => e.param === p).value, -7);
  assert.deepEqual(core.moduleEdits(m, { address: td.address.volume(12, 1), data: td.encodeNibbles(-7, 4) }), []);
});

test('kit number message and kit names', () => {
  assert.equal(core.isKitNumberMessage({ address: [0, 0, 0, 0], data: [5] }), true);
  assert.equal(core.isKitNumberMessage({ address: [0, 0, 0, 1], data: [5] }), false);
  assert.equal(core.parseKitName([...'Studio Rock '].map((c) => c.charCodeAt(0))), 'Studio Rock');
  assert.equal(core.parseKitName([0, 0, 0]), '');
});

test('the simulator answers like the module', async () => {
  const got = [];
  const sim = createSimModule({ emit: (m) => got.push(m), latency: 0 });
  const addr = td.address.volume(11, 1, 'main');
  sim.receive(td.rq1(0x10, addr, 4));
  await sleep(5);
  assert.equal(td.decodeNibbles(td.parseDt1(got[0]).data), 0);
  sim.receive(td.dt1(0x10, addr, td.encodeNibbles(-33, 4)));
  assert.equal(sim.readValue(addr, 4), -33);
  sim.selectKit(4);
  await sleep(5);
  assert.deepEqual(got[1], [0xc9, 4]);
  assert.equal(sim.kit, 4);
});

// ---------- recording and replay ----------
test('BLE short message packet: header, timestamp, then the message', () => {
  assert.deepEqual(core.bleEncodeShort([0x99, 38, 100], 0), [0x80, 0x80, 0x99, 38, 100]);
  assert.deepEqual(core.bleEncodeShort([0x89, 38, 0], 1000), [0x80 | (1000 >> 7), 0x80 | (1000 & 0x7f), 0x89, 38, 0]);
  assert.deepEqual(core.bleEncodeShort([0xb9, 4, 64], 8192 + 5), [0x80, 0x85, 0xb9, 4, 64]); // 13-bit wrap
});

test('seeded fill uses every pad except Aux, never Aux, and lasts 5-8 s', () => {
  const fill = core.seedFill();
  const pads = new Set(fill.events.map((e) => core.padOfNote(e.n)));
  assert.deepEqual([...pads].sort(), ['Crash 1', 'Crash 2', 'Hi-Hat', 'Kick', 'Ride', 'Snare', 'Tom 1', 'Tom 2', 'Tom 3']);
  assert.ok(!pads.has('Aux') && !pads.has(null));
  const ms = core.recordingMs(fill);
  assert.ok(ms >= 5000 && ms <= 8000, `fill lasts ${ms} ms`);
  assert.ok(core.recordingMs(core.seedBaDumTss()) < 2000);
  for (const s of core.seedRecordings()) assert.ok(core.sanitizeRecording(s));
});

test('recorder: trims to the first note, keeps the pedal position, ignores Note On with velocity 0', () => {
  let t = 1000;
  const r = core.createRecorder(() => t);
  assert.equal(r.finish(), null);
  t = 1100; r.pedal(90);
  t = 1500; r.note(9, 38, 100);
  t = 1600; r.note(9, 38, 0);
  t = 1700; r.pedal(10);
  t = 1800; r.note(9, 42, 80);
  assert.deepEqual(r.finish(), { channel: 9, events: [{ t: 0, cc: 4, v: 90 }, { t: 0, n: 38, v: 100 }, { t: 200, cc: 4, v: 10 }, { t: 300, n: 42, v: 80 }] });
  assert.equal(core.createRecorder(() => 0).finish(), null);
});

test('playback messages: matching Note Offs, pedal before notes, retriggers cut the earlier note', () => {
  const msgs = core.playbackMessages({ channel: 9, events: [{ t: 0, cc: 4, v: 5 }, { t: 0, n: 42, v: 80 }, { t: 20, n: 42, v: 90 }, { t: 500, n: 38, v: 100 }] });
  assert.deepEqual(msgs.map((m) => m.bytes), [
    [0xb9, 4, 5], [0x99, 42, 80], [0x89, 42, 0], [0x99, 42, 90], [0x89, 42, 0], [0x99, 38, 100], [0x89, 38, 0],
  ]);
  assert.equal(msgs[2].t, 20);
  assert.equal(msgs[4].t, 20 + core.NOTE_MS);
  const ons = msgs.filter((m) => m.bytes[0] >> 4 === 9).length, offs = msgs.filter((m) => m.bytes[0] >> 4 === 8).length;
  assert.equal(ons, offs);
  assert.equal(core.playbackMessages({ channel: 3, events: [{ t: 0, n: 38, v: 1 }] })[0].bytes[0], 0x93); // replays on the recorded channel
});

test('player sends on time, and stop silences sounding notes and cancels the rest', () => {
  let clock = 0, timers = [];
  const sent = [];
  const player = core.createPlayer({
    send: (b) => sent.push([clock, ...b]), now: () => clock,
    setTimer: (fn) => timers.push(fn) && timers.length, clearTimer: () => { timers = []; },
  });
  const run = (ms) => { const end = clock + ms; while (clock < end) { clock += 5; const f = timers.shift(); timers = []; f?.(); } };
  player.play(core.playbackMessages({ channel: 9, events: [{ t: 0, n: 36, v: 100 }, { t: 40, n: 38, v: 100 }, { t: 1000, n: 49, v: 100 }] }));
  assert.ok(player.playing);
  run(30);
  assert.deepEqual(sent.map((s) => s.slice(1)), [[0x99, 36, 100]]);
  run(20); // 50 ms: snare on, kick off at 60 not yet
  assert.ok(sent.some((s) => s[2] === 38 && s[1] === 0x99 && s[0] <= 45));
  player.stop();
  assert.ok(!player.playing);
  const open = new Set();
  for (const s of sent) (s[1] >> 4 === 9 ? open.add(s[2]) : open.delete(s[2]));
  assert.equal(open.size, 0); // nothing hanging
  const n = sent.length; run(2000);
  assert.equal(sent.length, n); // the crash at 1000 ms never sounds
  player.play(core.playbackMessages({ channel: 9, events: [{ t: 0, n: 36, v: 100 }] }));
  run(200);
  assert.ok(!player.playing); // ends by itself
});

test('quick press: newest if made after the last playback began, else the last played', () => {
  const recs = [{ id: 'a', created: 1 }, { id: 'b', created: 5 }, { id: 'c', created: 9 }];
  assert.equal(core.pickQuick(recs, null).id, 'c');
  assert.equal(core.pickQuick(recs, { id: 'a', at: 10 }).id, 'a');
  assert.equal(core.pickQuick(recs, { id: 'a', at: 8 }).id, 'c');
  assert.equal(core.pickQuick(recs, { id: 'gone', at: 100 }).id, 'c');
  assert.equal(core.pickQuick([], null), null);
});

test('stored recordings are validated', () => {
  const good = { id: 'r1', name: 'x', created: 5, channel: 9, events: [{ t: 0, n: 38, v: 90 }, { t: 5, cc: 4, v: 3 }] };
  assert.deepEqual(core.sanitizeRecording(JSON.parse(JSON.stringify(good))), good);
  assert.equal(core.sanitizeRecording({ ...good, events: [{ t: 0, n: 300, v: 1 }] }), null);
  assert.equal(core.sanitizeRecording({ ...good, events: [] }), null);
  assert.equal(core.sanitizeRecording(null), null);
  assert.equal(core.sanitizeRecording({ ...good, channel: 40 }).channel, 9);
});

test('sim module logs short messages and can play notes into the app', () => {
  const sent = [], got = [];
  const m = createSimModule({ emit: (x) => got.push(x), latency: 0, onShort: (b) => sent.push(b) });
  m.receiveShort([0x99, 38, 100]);
  assert.deepEqual(sent, [[0x99, 38, 100]]);
  m.hit(38, 90); m.pedal(20);
  return sleep(10).then(() => assert.deepEqual(got, [[0x99, 38, 90], [0xb9, 4, 20]]));
});

test('a hit maps to the pad, zone or extra value it edits', () => {
  assert.deepEqual(core.noteTarget(36), { pad: 0, zone: 0, extra: null });
  assert.deepEqual(core.noteTarget(40), { pad: 1, zone: 1, extra: null });   // snare rim
  assert.deepEqual(core.noteTarget(37), { pad: 1, zone: null, extra: 'xstickVolume' });
  assert.deepEqual(core.noteTarget(44), { pad: 5, zone: null, extra: 'pedalHhVolume' });
  assert.deepEqual(core.noteTarget(46), { pad: 5, zone: 0, extra: null });   // open hi-hat is the bow
  assert.deepEqual(core.noteTarget(53), { pad: 8, zone: 2, extra: null });   // ride bell
  assert.equal(core.noteTarget(1), null);
  for (const notes of Object.values(core.NOTE_MAP)) for (const n of notes) assert.ok(core.noteTarget(n));
});

test('reorder follows the given ids and keeps unnamed items', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(core.reorder(items, ['c', 'a', 'b']).map((x) => x.id), ['c', 'a', 'b']);
  assert.deepEqual(core.reorder(items, ['b', 'zzz']).map((x) => x.id), ['b', 'a', 'c']);
});

test('velocity adjustment scales proportionally and never clips', () => {
  const rec = { channel: 9, events: [{ t: 0, n: 38, v: 100 }, { t: 100, n: 36, v: 50 }, { t: 200, n: 42, v: 20 }] };
  assert.equal(core.maxVelocity(rec), 100);
  const g = core.gainForMax(rec, 127);
  assert.equal(core.maxVelocity(rec, g), 127);
  const vel = core.playbackMessages(rec, g).filter((m) => m.bytes[0] >> 4 === 9).map((m) => m.bytes[2]);
  assert.deepEqual(vel, [127, 64, 25]); // 100:50:20 kept (rounded)
  assert.deepEqual(core.playbackMessages(rec, core.gainForMax(rec, 1)).filter((m) => m.bytes[0] >> 4 === 9).map((m) => m.bytes[2]), [1, 1, 1]);
  assert.equal(core.playbackMessages(rec).filter((m) => m.bytes[0] >> 4 === 9)[1].bytes[2], 50);
  const withPedal = { channel: 9, events: [{ t: 0, cc: 4, v: 90 }, { t: 0, n: 38, v: 100 }] };
  assert.equal(core.playbackMessages(withPedal, 0.5)[0].bytes[2], 90); // the pedal is not scaled
});

test('prefs are validated', () => {
  assert.deepEqual(core.sanitizePrefs(null), { order: [], gains: {} });
  assert.deepEqual(core.sanitizePrefs({ order: ['a', 3], gains: { a: 0.5, b: 'x', c: -1 } }), { order: ['a'], gains: { a: 0.5 } });
});

test('hi-hat edge notes highlight the Edge zone', () => {
  assert.deepEqual(core.noteTarget(22), { pad: 5, zone: 1, extra: null });
  assert.deepEqual(core.noteTarget(26), { pad: 5, zone: 1, extra: null });
});

test('player can change a message just before it is sent (live loudness)', () => {
  let clock = 0, gain = 1, timers = [];
  const sent = [];
  const player = core.createPlayer({
    send: (b) => sent.push(b), now: () => clock,
    setTimer: (fn) => timers.push(fn), clearTimer: () => { timers = []; },
    transform: (b) => (b[0] >> 4 === 9 ? [b[0], b[1], core.scaleVelocity(b[2], gain)] : b),
  });
  const run = (ms) => { const end = clock + ms; while (clock < end) { clock += 5; const f = timers.shift(); timers = []; f?.(); } };
  player.play(core.playbackMessages({ channel: 9, events: [{ t: 0, n: 36, v: 100 }, { t: 500, n: 38, v: 100 }] }));
  run(100); gain = 0.5; run(600);
  assert.deepEqual(sent.filter((b) => b[0] >> 4 === 9).map((b) => b[2]), [100, 50]);
});

// ---------- MIDI files and tempo ----------
test('MIDI file round trip keeps notes, pedal and loudness', () => {
  const rec = { name: 'Take 1', channel: 9, events: [{ t: 0, cc: 4, v: 90 }, { t: 0, n: 42, v: 80 }, { t: 500, n: 38, v: 100 }, { t: 1000, n: 36, v: 110 }] };
  const same = core.parseMidiFile(core.toMidiFile(rec));
  assert.equal(same.channel, 9);
  assert.deepEqual(same.events.map((e) => [e.n, e.cc, e.v]), rec.events.map((e) => [e.n, e.cc, e.v]));
  same.events.forEach((e, i) => assert.ok(Math.abs(e.t - rec.events[i].t) <= 1));
  const quiet = core.parseMidiFile(core.toMidiFile(rec, { gain: 0.5 }));
  assert.deepEqual(quiet.events.filter((e) => e.n != null).map((e) => e.v), [40, 50, 55]);
  assert.equal(same.unmapped, 0);
});

// A hand-made file: header, one track per entry of `tracks` (byte arrays).
const smf = (format, division, tracks) => Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 255,
  ...tracks.flatMap((t) => [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, t.length, ...t])]);

test('MIDI import: running status, tempo changes, channel choice, trimming', () => {
  // ppq 96; first note at tick 96 (channel 1, not drums), tempo 120 bpm then 60 bpm at tick 192
  const tr = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20,
    96, 0x90, 60, 100, // ch 1 note at tick 96
    0, 0x99, 38, 90,   // ch 10 note at tick 96 too
    96, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, // tempo 1,000,000 us at tick 192
    0, 0x99, 36, 0x70, // note at tick 192
    96, 38, 0, // running status, vel 0 = note off, ignored
    96, 0x99, 42, 80, 0, 0xff, 0x2f, 0];
  const r = core.parseMidiFile(smf(0, 96, [tr]));
  assert.equal(r.channel, 9); // channel 10 wins
  assert.deepEqual(r.events.map((e) => [e.t, e.n]), [[0, 38], [500, 36], [2500, 42]]); // 192 ticks at 60 bpm are 2000 ms
});

test('MIDI import: type 1 merges tracks, odd notes are counted, bad files are refused', () => {
  const t1 = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x2f, 0];
  const t2 = [0, 0x99, 38, 100, 0, 0x99, 1, 50, 0, 0xff, 0x2f, 0];
  const r = core.parseMidiFile(smf(1, 480, [t1, t2]));
  assert.equal(r.notes, 2); assert.equal(r.unmapped, 1);
  assert.throws(() => core.parseMidiFile(Uint8Array.from([1, 2, 3, 4])), /Not a MIDI file/);
  assert.throws(() => core.parseMidiFile(smf(0, 480, [[0, 0xff, 0x2f, 0]])), /no notes/);
  assert.throws(() => core.parseMidiFile(smf(0, 0x8000 | 25, [t2])), /Time-code/);
  assert.throws(() => core.parseMidiFile(smf(0, 480, [[0, 0x99, 38]])), /damaged/);
});

test('pedal thinning keeps the shape and always the last position', () => {
  let t = 0;
  const r = core.createRecorder(() => t);
  r.note(9, 38, 100);
  for (let v = 0; v <= 100; v++) { t = 10 + v * 2; r.pedal(v); } // a fast sweep, 1 step per 2 ms
  t = 400; r.pedal(100); // same value again: dropped
  t = 500; r.note(9, 42, 90);
  const out = r.finish().events;
  const cc = out.filter((e) => e.cc != null);
  assert.ok(cc.length < 40, `${cc.length} pedal events`);
  assert.equal(cc[cc.length - 1].v, 100); // the resting position survived
  assert.equal(cc[0].v, 0);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t); // still in order
  // a slow movement is not thinned
  t = 0; const s = core.createRecorder(() => t);
  s.note(9, 38, 100);
  for (let k = 1; k <= 5; k++) { t = k * 100; s.pedal(k * 2); }
  assert.equal(s.finish().events.filter((e) => e.cc != null).length, 5);
});

test('playbackMessages stays fast on a full recording', () => {
  const events = [];
  for (let i = 0; i < core.MAX_EVENTS; i++) events.push({ t: i * 5, n: [36, 38, 42][i % 3], v: 90 });
  const start = performance.now();
  const msgs = core.playbackMessages({ channel: 9, events });
  assert.equal(msgs.length, 2 * core.MAX_EVENTS);
  assert.ok(performance.now() - start < 100);
});
