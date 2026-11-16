// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dt1, rq1, parseDt1, parseIdentityReply, encodeNibbles, decodeNibbles, address,
  bleEncodeSysex, BleMidiParser, hex, GROUPS, UNITS, captureBlend, applyBlend,
} from './td17.js';

test("Roland's worked DT1 example", () => {
  assert.equal(
    hex(dt1(0x10, [0x03, 0x01, 0x01, 0x01], [0, 0, 0, 5])),
    'F0 41 10 00 00 00 4B 12 03 01 01 01 00 00 00 05 75 F7',
  );
});

test("Roland's worked RQ1 example (kit 1 snare EQ switch)", () => {
  assert.equal(
    hex(rq1(0x10, [0x03, 0x00, 0x21, 0x05], 1)),
    'F0 41 10 00 00 00 4B 11 03 00 21 05 00 00 00 01 56 F7',
  );
});

test('addresses', () => {
  assert.deepEqual(address.volume(0, 1), [0x03, 0x00, 0x41, 0x04]);
  assert.deepEqual(address.volume(0, 19, 'sub'), [0x03, 0x00, 0x73, 0x04]);
  assert.deepEqual(address.pan(1, 0), [0x03, 0x02, 0x20, 0x00]);
  assert.deepEqual(address.pan(99, 0), [0x04, 0x46, 0x20, 0x00]); // kit 100
  assert.deepEqual(address.volume(79, 1), [0x04, 0x1e, 0x41, 0x04]); // seen on the real module
  assert.deepEqual(address.subSwitch(0, 1), [0x03, 0x00, 0x21, 0x02]);
  assert.deepEqual(address.pedalHhVolume(0), [0x03, 0x00, 0x00, 0x20]);
  assert.deepEqual(address.xstickVolume(0), [0x03, 0x00, 0x00, 0x24]);
});

test('groups cover every unit exactly once', () => {
  assert.deepEqual(GROUPS.flatMap((g) => g.units), UNITS.map((_, i) => i));
});

test('combined level keeps the main/sub balance', () => {
  const blend = captureBlend([0, -60]); // sub 6 dB under main
  assert.deepEqual(applyBlend(blend, -100), [-100, -160]);
  assert.deepEqual(applyBlend(blend, 60), [60, 0]);
  assert.deepEqual(applyBlend(blend, -590), [-590, -600]); // clamps above -INF
  assert.deepEqual(applyBlend(blend, -601), [-601, -601]); // bottom mutes both
  assert.deepEqual(applyBlend(blend, -30), [-30, -90]); // balance survives the trip to -INF
});

test('combined level leaves a muted layer alone', () => {
  assert.deepEqual(applyBlend(captureBlend([10, -601]), -50), [-50, null]);
  const subLeads = captureBlend([-601, -20]);
  assert.equal(subLeads.leader, 1);
  assert.deepEqual(applyBlend(subLeads, 0), [null, 0]);
  assert.deepEqual(applyBlend(captureBlend([-601, -601]), -40), [-40, -40]);
});

test('nibble encoding round-trips signed values', () => {
  assert.deepEqual(encodeNibbles(-60, 4), [0x0f, 0x0f, 0x0c, 0x04]);
  for (const v of [-601, -60, -1, 0, 1, 60]) assert.equal(decodeNibbles(encodeNibbles(v, 4)), v);
  for (const v of [-30, -1, 0, 30]) assert.equal(decodeNibbles(encodeNibbles(v, 2)), v);
});

test('parseDt1 checks model and checksum', () => {
  const msg = dt1(0x10, [0x03, 0x00, 0x41, 0x04], encodeNibbles(-60, 4));
  const parsed = parseDt1(msg);
  assert.deepEqual(parsed.address, [0x03, 0x00, 0x41, 0x04]);
  assert.equal(decodeNibbles(parsed.data), -60);
  assert.equal(parsed.checksumOk, true);
  msg[msg.length - 2] ^= 1;
  assert.equal(parseDt1(msg).checksumOk, false);
});

test('identity reply', () => {
  const r = parseIdentityReply([0xf0, 0x7e, 0x10, 0x06, 0x02, 0x41, 0x4b, 0x03, 0, 0, 0, 0, 0, 2, 0xf7]);
  assert.equal(r.isTd17, true);
  assert.deepEqual(r.revision, [0, 0, 0, 2]);
});

test('BLE framing round-trips SysEx across packet sizes', () => {
  const msg = dt1(0x10, [0x03, 0x00, 0x41, 0x04], encodeNibbles(-60, 4));
  for (const max of [5, 19, 20, 21, 64]) {
    const packets = bleEncodeSysex(msg, 1234, max);
    assert.ok(packets.every((p) => p.length <= max && p[0] & 0x80));
    const parser = new BleMidiParser();
    const out = packets.flatMap((p) => parser.push(p));
    assert.deepEqual(out, [msg], `max=${max}`);
  }
});

test('BLE parser handles notes, running status and real-time bytes', () => {
  const parser = new BleMidiParser();
  // header, ts, note on, ts, running-status note, ts, active sensing
  const out = parser.push([0x80, 0x81, 0x99, 0x26, 0x64, 0x82, 0x24, 0x40, 0x83, 0xfe]);
  assert.deepEqual(out, [[0x99, 0x26, 0x64], [0x99, 0x24, 0x40], [0xfe]]);
});
