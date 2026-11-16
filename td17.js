// Roland TD-17 SysEx protocol helpers and BLE-MIDI packet framing.
// Addresses and formats: Roland "TD-17 MIDI Implementation" v2.00.
// Pure functions only, so this file also runs under Node for tests.

export const MODEL_ID = [0x00, 0x00, 0x00, 0x4b];
export const DEFAULT_DEVICE_ID = 0x10;
export const VOLUME_MIN = -601; // -INF
export const VOLUME_MAX = 60; // +6.0 dB
export const PAN_MIN = -30;
export const PAN_MAX = 30;

// Order of the 20 "kit units" inside a kit.
export const UNITS = [
  'Kick', 'Snare Head', 'Snare Rim',
  'Tom 1 Head', 'Tom 1 Rim', 'Tom 2 Head', 'Tom 2 Rim', 'Tom 3 Head', 'Tom 3 Rim',
  'Hi-Hat Head', 'Hi-Hat Rim', 'Crash 1 Head', 'Crash 1 Rim', 'Crash 2 Head', 'Crash 2 Rim',
  'Ride Head', 'Ride Rim', 'Ride Bell', 'Aux Head', 'Aux Rim',
];

export function checksum(bytes) {
  const sum = bytes.reduce((a, b) => a + b, 0);
  return (128 - (sum % 128)) % 128;
}

export function dt1(deviceId, address, data) {
  const body = [...address, ...data];
  return [0xf0, 0x41, deviceId, ...MODEL_ID, 0x12, ...body, checksum(body), 0xf7];
}

export function rq1(deviceId, address, size) {
  const body = [...address, 0, 0, 0, size];
  return [0xf0, 0x41, deviceId, ...MODEL_ID, 0x11, ...body, checksum(body), 0xf7];
}

// Returns { deviceId, address, data, checksumOk } for a TD-17 DT1 message, else null.
export function parseDt1(msg) {
  if (msg.length < 15 || msg[0] !== 0xf0 || msg[1] !== 0x41 || msg[7] !== 0x12) return null;
  if (MODEL_ID.some((b, i) => msg[3 + i] !== b)) return null;
  const body = msg.slice(8, -2);
  return {
    deviceId: msg[2],
    address: body.slice(0, 4),
    data: body.slice(4),
    checksumOk: checksum(body) === msg[msg.length - 2],
  };
}

export function identityRequest(deviceId = 0x7f) {
  return [0xf0, 0x7e, deviceId, 0x06, 0x01, 0xf7];
}

// Returns { deviceId, manufacturer, family, isTd17, revision } or null.
export function parseIdentityReply(msg) {
  if (msg.length < 15 || msg[1] !== 0x7e || msg[3] !== 0x06 || msg[4] !== 0x02) return null;
  return {
    deviceId: msg[2],
    manufacturer: msg[5],
    family: [msg[6], msg[7]],
    isTd17: msg[5] === 0x41 && msg[6] === 0x4b && msg[7] === 0x03,
    revision: msg.slice(10, 14),
  };
}

// Signed value -> `count` nibbles (two's complement, most significant first).
export function encodeNibbles(value, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push((value >> (4 * i)) & 0x0f);
  return out;
}

export function decodeNibbles(nibbles) {
  const bits = 4 * nibbles.length;
  const raw = nibbles.reduce((acc, n) => (acc << 4) | (n & 0x0f), 0);
  return raw >= 1 << (bits - 1) ? raw - (1 << bits) : raw;
}

// kit: 0-99 (kit 1-100). Address bytes are 7-bit, so kit 65+ carries into the first byte.
function kitBase(kit) {
  const v = 2 * kit;
  return [0x03 + (v >> 7), v & 0x7f];
}

// Pad groups as the player thinks of them: unit indexes plus related kit-wide volumes.
export const GROUPS = [
  { name: 'Kick', units: [0] },
  { name: 'Snare', units: [1, 2], extras: ['xstickVolume'] },
  { name: 'Tom 1', units: [3, 4] },
  { name: 'Tom 2', units: [5, 6] },
  { name: 'Tom 3', units: [7, 8] },
  { name: 'Hi-Hat', units: [9, 10], extras: ['pedalHhVolume'] },
  { name: 'Crash 1', units: [11, 12] },
  { name: 'Crash 2', units: [13, 14] },
  { name: 'Ride', units: [15, 16, 17] },
  { name: 'Aux', units: [18, 19] },
];

export const EXTRA_LABELS = { xstickVolume: 'XStick', pedalHhVolume: 'Pedal HH' };

export const address = {
  currentKit: () => [0x00, 0x00, 0x00, 0x00],
  // Multi-nibble values are addressed by their FIRST nibble (the '#' row in Roland's tables).
  kitVolume: (kit) => [...kitBase(kit), 0x00, 0x1c],
  pedalHhVolume: (kit) => [...kitBase(kit), 0x00, 0x20],
  xstickVolume: (kit) => [...kitBase(kit), 0x00, 0x24],
  pan: (kit, unit) => [...kitBase(kit), 0x20 + unit, 0x00],
  subSwitch: (kit, unit) => [...kitBase(kit), 0x20 + unit, 0x02],
  volume: (kit, unit, layer = 'main') => [...kitBase(kit), (layer === 'sub' ? 0x60 : 0x40) + unit, 0x04],
};

// ---- Combined sliders: move several values together, keeping their differences ----

export const VOLUME_RANGE = { min: VOLUME_MIN, max: VOLUME_MAX, mute: true }; // min means -INF
export const PAN_RANGE = { min: PAN_MIN, max: PAN_MAX, mute: false };

// Captures the differences between values (e.g. head/rim, main/sub volumes). The first
// usable value is the "leader": the combined slider shows and sets it, and the others
// follow at their captured offsets. For volumes, a value at -INF is "pinned": the
// combined slider leaves it alone, unless every value is at -INF.
export function captureBlend(values, range = VOLUME_RANGE) {
  let pinned = values.map((v) => range.mute && v <= range.min);
  if (pinned.every(Boolean)) pinned = values.map(() => false);
  const leader = pinned.indexOf(false);
  return { range, leader, pinned, offsets: values.map((v, i) => (pinned[i] ? 0 : v - values[leader])) };
}

// New value for each entry when the combined slider is set to `level`.
// Pinned entries get null, meaning "leave unchanged".
export function applyBlend(blend, level) {
  const { min, max, mute } = blend.range;
  return blend.offsets.map((offset, i) => {
    if (blend.pinned[i]) return null;
    if (mute && level <= min) return min; // bottom of a volume slider mutes everything
    return Math.min(max, Math.max(mute ? min + 1 : min, level + offset));
  });
}

// ---- Spread band: shows on a combined slider when the values under it disagree ----

export const SPREAD_MIN = 30; // 3.0 dB: how far a sub or extra must be off to count

// `leader` is the value the combined slider shows. Each entry is { kind, value }, with
// kind 'main' or 'pan' (zone values: any difference from the leader counts), 'sub'
// (also { main, on }: counts only when on and SPREAD_MIN or more from its own main)
// or 'extra' (Pedal HH, XStick: counts when SPREAD_MIN or more from the leader).
// Returns { min, max } spanning the counted values and the leader, or null when
// nothing counts.
export function spreadBand(leader, entries) {
  const counted = entries
    .filter((e) => {
      if (e.kind === 'main' || e.kind === 'pan') return e.value !== leader;
      if (e.kind === 'sub') return Boolean(e.on) && Math.abs(e.value - e.main) >= SPREAD_MIN;
      if (e.kind === 'extra') return Math.abs(e.value - leader) >= SPREAD_MIN;
      return false;
    })
    .map((e) => e.value);
  if (!counted.length) return null;
  return { min: Math.min(leader, ...counted), max: Math.max(leader, ...counted) };
}

export function formatVolume(v) {
  if (v <= VOLUME_MIN) return '-INF';
  return `${v > 0 ? '+' : ''}${(v / 10).toFixed(1)} dB`;
}

export function formatPan(v) {
  if (v === 0) return 'CENTER';
  return v < 0 ? `L${-v}` : `R${v}`;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// ---- BLE-MIDI framing (MIDI over Bluetooth LE specification) ----

export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const BLE_MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

// Wraps one complete SysEx message (F0 ... F7) into one or more BLE packets.
export function bleEncodeSysex(msg, timestampMs = 0, maxPacket = 20) {
  const ts = Math.floor(timestampMs) & 0x1fff;
  const header = 0x80 | (ts >> 7);
  const tsLow = 0x80 | (ts & 0x7f);
  const packets = [];
  let packet = [header, tsLow];
  for (const b of msg.slice(0, -1)) {
    if (packet.length === maxPacket) {
      packets.push(packet);
      packet = [header];
    }
    packet.push(b);
  }
  if (packet.length + 2 > maxPacket) {
    packets.push(packet);
    packet = [header];
  }
  packet.push(tsLow, 0xf7);
  packets.push(packet);
  return packets;
}

function dataLength(status) {
  const hi = status & 0xf0;
  if (hi === 0xc0 || hi === 0xd0 || status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf6) return 0;
  return 2;
}

// Reassembles MIDI messages from incoming BLE packets (SysEx may span packets).
export class BleMidiParser {
  constructor() {
    this.sysex = null;
    this.current = null;
    this.running = 0;
  }

  push(packet) {
    const out = [];
    let i = 1; // byte 0 is the packet header
    while (i < packet.length) {
      let b = packet[i];
      if (b & 0x80) {
        // Timestamp byte; a status byte normally follows.
        i++;
        if (i >= packet.length) break;
        b = packet[i];
        if (!(b & 0x80)) {
          // Timestamp followed by data: running status.
          this.current = this.running ? [this.running] : null;
          continue;
        }
        i++;
        if (b === 0xf0) {
          this.sysex = [0xf0];
        } else if (b === 0xf7) {
          if (this.sysex) out.push([...this.sysex, 0xf7]);
          this.sysex = null;
        } else if (b >= 0xf8) {
          out.push([b]); // real-time, may interleave with SysEx
        } else {
          this.sysex = null;
          this.running = b < 0xf0 ? b : 0;
          this.current = [b];
          if (dataLength(b) === 0) out.push([b]);
        }
      } else {
        if (this.sysex) {
          this.sysex.push(b);
        } else if (this.current) {
          this.current.push(b);
          if (this.current.length === 1 + dataLength(this.current[0])) {
            out.push(this.current);
            this.current = [this.current[0]];
          }
        }
        i++;
      }
    }
    return out;
  }
}
