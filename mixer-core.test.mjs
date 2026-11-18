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
