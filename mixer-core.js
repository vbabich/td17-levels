// Pure logic for the TD-17 mixer: the kit model, fader law, pad-wide values, disagreement
// rules, snapping and matching of incoming module edits. No DOM, so it also runs under Node.
import * as td from './td17.js?v=19';

export const PAD_COUNT = td.GROUPS.length;
export const SNAP_PX = 5;      // how close a drag must come to a sticky spot
export const GRAB_PX = 8;      // movement along the fader before anything changes
export const HOLD_MS = 1000;   // press and hold this long without moving for precision mode
export const FINE_PX = 6;      // in precision mode, px of movement per step
export const TOUCH_GUARD_MS = 500; // a value moved here is not overwritten by the module for this long

// ---------- fader law ----------
// More travel where mixing happens: -12 to +6 dB takes half the fader.
const TAPER = [[-601, 0], [-600, 0.04], [-240, 0.27], [-120, 0.5], [0, 0.8], [60, 1]];

export function levelPos(v) {
  for (let i = 1; i < TAPER.length; i++) {
    const [a, pa] = TAPER[i - 1], [b, pb] = TAPER[i];
    if (v <= b) return pa + (Math.max(v, a) - a) / (b - a) * (pb - pa);
  }
  return 1;
}

export function levelVal(p) {
  for (let i = 1; i < TAPER.length; i++) {
    const [a, pa] = TAPER[i - 1], [b, pb] = TAPER[i];
    if (p <= pb) return Math.round(a + (p - pa) / (pb - pa) * (b - a));
  }
  return td.VOLUME_MAX;
}

export const KIND = {
  level: {
    min: td.VOLUME_MIN, max: td.VOLUME_MAX, range: td.VOLUME_RANGE, pos: levelPos, val: levelVal, step: 1,
    fmt: (v) => (v <= td.VOLUME_MIN ? ['-INF', ''] : [(v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) / 10).toFixed(1), 'dB']),
  },
  pan: {
    min: td.PAN_MIN, max: td.PAN_MAX, range: td.PAN_RANGE, step: 1,
    pos: (v) => (v - td.PAN_MIN) / (td.PAN_MAX - td.PAN_MIN),
    val: (p) => Math.round(td.PAN_MIN + p * (td.PAN_MAX - td.PAN_MIN)),
    fmt: (v) => [v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`, ''],
  },
};

export const fmtText = (kind, v) => KIND[kind].fmt(v).join(' ').trim();

// ---------- kit model ----------
const CYMBALS = new Set(['Hi-Hat', 'Crash 1', 'Crash 2', 'Ride']);
const zoneNames = (group) => (CYMBALS.has(group) ? ['Bow', 'Edge', 'Bell'] : ['Head', 'Rim']);

function param(fields) {
  return { value: null, original: null, touched: 0, dragging: false, dirty: false, ...fields };
}

// All values of one kit. `value` is the current value; `original` is the first value read
// from the module in this session and never changes afterwards.
export function createKit(kit) {
  const pads = td.GROUPS.map((group, index) => {
    const names = zoneNames(group.name);
    const zones = group.units.map((unit, z) => {
      const zone = names[z];
      const common = { pad: index, padName: group.name, zone };
      const main = param({ ...common, role: 'main', kind: 'level', name: `${zone} main`, addr: td.address.volume(kit, unit, 'main'), size: 4 });
      const sub = param({ ...common, role: 'sub', kind: 'level', name: `${zone} sub`, addr: td.address.volume(kit, unit, 'sub'), size: 4, main, on: false, switchAddr: td.address.subSwitch(kit, unit) });
      const pan = param({ ...common, role: 'pan', kind: 'pan', name: `${zone} pan`, addr: td.address.pan(kit, unit), size: 2 });
      return { name: zone, main, sub, pan };
    });
    const extras = (group.extras ?? []).map((x) => param({
      pad: index, padName: group.name, zone: td.EXTRA_LABELS[x], role: 'extra', kind: 'level',
      name: td.EXTRA_LABELS[x], addr: td.address[x](kit), size: 4,
    }));
    const params = [...zones.flatMap((z) => [z.main, z.sub, z.pan]), ...extras];
    return { index, name: group.name, zones, extras, params };
  });
  return { kit, name: '', pads, params: pads.flatMap((p) => p.params) };
}

export const valueOf = (p) => p.value;
export const originalOf = (p) => p.original;

// The values one pad-wide fader moves, in the tester's order: the first usable one leads.
export function layers(pad, kind) {
  if (kind === 'pan') return pad.zones.map((z) => z.pan);
  return [...pad.zones.map((z) => z.main), ...pad.zones.map((z) => z.sub), ...pad.extras];
}

export const captureLayers = (list, kind, read = valueOf) => td.captureBlend(list.map(read), KIND[kind].range);

// Values not read yet (null) are left out, so a pad whose mains are known already has a level.
const known = (pad, kind, read) => layers(pad, kind).filter((p) => read(p) != null);
export function padValue(pad, kind, read = valueOf) {
  const list = known(pad, kind, read);
  return list.length ? read(list[captureLayers(list, kind, read).leader]) : null;
}

const spreadEntry = (p, read) => ({ kind: p.role, value: read(p), main: p.main ? read(p.main) : undefined, on: p.on });

// The orange bar on a pad-wide fader: [lowest, highest], or null when everything agrees.
export function padBand(pad, kind, read = valueOf) {
  const band = td.spreadBand(padValue(pad, kind, read), known(pad, kind, read).map((p) => spreadEntry(p, read)));
  return band ? [band.min, band.max] : null;
}

// The individual values that make the pad disagree, by the same rules as the bar.
export function disagreements(pad, kind, read = valueOf) {
  const leader = padValue(pad, kind, read);
  return known(pad, kind, read).filter((p) => td.spreadBand(leader, [spreadEntry(p, read)]));
}

// Values a pad-view slider may snap to: levels snap to the other mains, subs that are on,
// and Pedal HH or XStick; pans snap to the other zones' pans.
export function relatedValues(pad, self, read = valueOf) {
  const list = self.kind === 'pan'
    ? pad.zones.map((z) => z.pan)
    : [...pad.zones.flatMap((z) => (z.sub.on ? [z.main, z.sub] : [z.main])), ...pad.extras];
  return list.filter((p) => p !== self).map(read).filter((v) => v != null && v > td.VOLUME_MIN);
}

// The sticky spot nearest to `pos` within SNAP_PX, or undefined.
export function pickSnap(kind, pos, lengthPx, candidates) {
  const K = KIND[kind];
  const near = (t) => Math.abs(K.pos(t) - pos) * lengthPx;
  return candidates.filter((t) => t >= K.min && t <= K.max && near(t) <= SNAP_PX).sort((a, b) => near(a) - near(b))[0];
}

export function fineValue(kind, start, movedPx) {
  const K = KIND[kind];
  return Math.min(K.max, Math.max(K.min, start + Math.round(movedPx / FINE_PX) * K.step));
}

// Subs that are off and Pedal HH / XStick cannot be heard while dragging the pad-wide
// fader, so they are only written when the drag ends.
export const isDeferred = (p) => p.role === 'extra' || (p.role === 'sub' && !p.on);

export const changedParams = (holder) => holder.params.filter((p) => p.original != null && p.value !== p.original);
export const isChanged = (pad) => changedParams(pad).length > 0;

// ---------- talking to the module ----------
export const kitNameAddress = (kit) => [...td.address.kitVolume(kit).slice(0, 2), 0, 0];
export const KIT_NAME_SIZE = 12;

// A kit name is 12 ASCII bytes; anything else is treated as "no name".
export function parseKitName(bytes) {
  if (!bytes.length || bytes.some((b) => b < 32 || b > 126)) return '';
  return String.fromCharCode(...bytes).trim();
}

// Where the value at `addr` sits inside a received DT1, or -1 when it is not covered.
export function coveredOffset(dt, addr, size) {
  if (!addr.slice(0, 3).every((b, i) => b === dt.address[i])) return -1;
  const offset = addr[3] - dt.address[3];
  return offset >= 0 && offset + size <= dt.data.length ? offset : -1;
}

export const isKitNumberMessage = (dt) => dt.address.every((b) => b === 0) && dt.data.length >= 1 && dt.data[0] <= 99;

// What a received DT1 changes in this kit: value edits and sub on/off switches.
export function moduleEdits(model, dt) {
  const edits = [];
  for (const p of model.params) {
    if (p.switchAddr) {
      const at = coveredOffset(dt, p.switchAddr, 1);
      if (at >= 0) edits.push({ param: p, on: dt.data[at] === 1 });
    }
    const at = coveredOffset(dt, p.addr, p.size);
    if (at >= 0) edits.push({ param: p, value: td.decodeNibbles(dt.data.slice(at, at + p.size)) });
  }
  return edits;
}

// ---------- recording and replaying drum notes ----------
// Note numbers are the TD-17 factory defaults (Roland's "TD-17 Default MIDI Note Map" could not be
// fetched when this was written, so they are the usual Roland defaults, not checked against it).
// They can be edited on the module; the seeded recordings depend on them being unchanged.
export const NOTE_MAP = {
  'Kick': [36],
  'Snare': [38, 40, 37],
  'Tom 1': [48, 50],
  'Tom 2': [45, 47],
  'Tom 3': [43, 58],
  'Hi-Hat': [42, 46, 44, 22, 26], // closed bow, open bow, pedal, closed edge, open edge (the last two from memory of the TD-series map)
  'Crash 1': [49, 55],
  'Crash 2': [57, 52],
  'Ride': [51, 59, 53],
  'Aux': [27, 28],
};
const PAD_OF_NOTE = new Map(Object.entries(NOTE_MAP).flatMap(([pad, notes]) => notes.map((n) => [n, pad])));
export const padOfNote = (note) => PAD_OF_NOTE.get(note) ?? null;

// What a note on a pad hits, for the highlight in the app: the pad (index in td.GROUPS), the zone
// (index in pad.zones) or, for cross-stick and the chick of the hi-hat pedal, the pad's extra value.
// Head/bow = zone 0, rim/edge = 1, bell = 2.
const ZONE_OF = { 'Snare': [0, 1], 'Tom 1': [0, 1], 'Tom 2': [0, 1], 'Tom 3': [0, 1], 'Hi-Hat': [0, 0, 0, 1, 1], 'Crash 1': [0, 1], 'Crash 2': [0, 1], 'Ride': [0, 1, 2] };
const TARGETS = new Map();
export function noteTarget(note) {
  if (!TARGETS.has(note)) TARGETS.set(note, computeTarget(note));
  return TARGETS.get(note);
}
function computeTarget(note) {
  const name = padOfNote(note);
  if (!name) return null;
  const pad = td.GROUPS.findIndex((g) => g.name === name);
  const at = NOTE_MAP[name].indexOf(note);
  if (name === 'Snare' && note === 37) return { pad, zone: null, extra: 'xstickVolume' };
  if (name === 'Hi-Hat' && note === 44) return { pad, zone: null, extra: 'pedalHhVolume' };
  return { pad, zone: ZONE_OF[name]?.[at] ?? 0, extra: null };
}

export const HAT_CC = 4;          // hi-hat control pedal position
export const DRUM_CHANNEL = 9;    // MIDI channel 10, zero-based
export const NOTE_MS = 60;        // replayed notes are held this long
export const MAX_EVENTS = 4000;   // one recording stops itself here
export const WARN_EVENTS = 3600;  // and warns from here (90%)
export const PEDAL_GAP_MS = 30;   // pedal position changes closer than this ...
export const PEDAL_STEP = 3;      // ... and smaller than this are thinned out (the last one is always kept)
export const MAX_SAVED = 30;      // user recordings kept on the phone

// One short channel message (Note On, Note Off, CC) as a BLE-MIDI packet.
export function bleEncodeShort(msg, timestampMs = 0) {
  const ts = Math.floor(timestampMs) & 0x1fff;
  return [0x80 | (ts >> 7), 0x80 | (ts & 0x7f), ...msg];
}

// A recording: { id, name, created, channel, events }, events sorted by t (ms from the first
// note): { t, n, v } is a Note On, { t, cc, v } a controller change (the hi-hat pedal).
export function createRecorder(now) {
  const t0 = now();
  const events = [];
  let channel = null, lastPedal = null, pending = null;
  // A thinned-out pedal position is kept as `pending` and written before the next note (or at the end),
  // so the pedal's resting position is never lost.
  const flush = () => { if (pending) { events.push({ t: pending.t, cc: HAT_CC, v: pending.v }); lastPedal = pending; pending = null; } };
  const rec = {
    get count() { return events.length; },
    get full() { return events.length >= MAX_EVENTS; },
    // `at` is the message's own time when the source has one (USB does), else it is timed on arrival.
    note(ch, n, v, at) {
      if (!v || rec.full) return;
      flush();
      channel ??= ch;
      events.push({ t: (at ?? now()) - t0, n, v });
    },
    pedal(v, at) {
      if (rec.full) return;
      const t = (at ?? now()) - t0;
      if (lastPedal && v === lastPedal.v) { pending = null; return; }
      if (lastPedal && t - lastPedal.t < PEDAL_GAP_MS && Math.abs(v - lastPedal.v) < PEDAL_STEP) { pending = { t, v }; return; }
      pending = null;
      lastPedal = { t, v };
      events.push({ t, cc: HAT_CC, v });
    },
    // Events from the first note on (the last pedal position before it is kept at 0), or null.
    finish() {
      flush();
      const first = events.find((e) => e.n != null);
      if (!first) return null;
      const lead = events.filter((e) => e.cc != null && e.t < first.t).pop();
      const out = events.filter((e) => e.t >= first.t).map((e) => ({ ...e, t: Math.round(e.t - first.t) }));
      if (lead) out.unshift({ t: 0, cc: lead.cc, v: lead.v });
      return { channel: channel ?? DRUM_CHANNEL, events: out };
    },
  };
  return rec;
}

export const recordingMs = (rec) => (rec.events.length ? rec.events[rec.events.length - 1].t + NOTE_MS : 0);

const pad2 = (n) => String(n).padStart(2, '0');
export function recordingName(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}
export function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// Velocity scaled by `gain`, kept inside 1-127 (0 would be a Note Off).
export const scaleVelocity = (v, gain = 1) => Math.min(127, Math.max(1, Math.round(v * gain)));
// The loudest hit of a recording, as played with `gain`.
export const maxVelocity = (rec, gain = 1) => Math.max(1, ...rec.events.filter((e) => e.n != null).map((e) => scaleVelocity(e.v, gain)));
// The gain that makes the loudest hit `target` (1-127); every other hit scales by the same ratio.
export function gainForMax(rec, target) {
  const raw = Math.max(1, ...rec.events.filter((e) => e.n != null).map((e) => e.v));
  return Math.min(127, Math.max(1, target)) / raw;
}

// Timed MIDI messages for a recording: [{ t, bytes }] sorted by time. Each Note On gets its Note Off
// NOTE_MS later (sooner when the same note is struck again). Offs come before controllers before ons.
export function playbackMessages(rec, gain = 1) {
  const ch = rec.channel ?? DRUM_CHANNEL;
  const out = [];
  const nextOn = new Map(); // note -> time of its next Note On, found by walking backwards: one pass
  for (let i = rec.events.length - 1; i >= 0; i--) {
    const e = rec.events[i];
    if (e.cc != null) { out.push({ t: e.t, rank: 1, bytes: [0xb0 | ch, e.cc, e.v] }); continue; }
    const off = Math.max(e.t + 1, Math.min(e.t + NOTE_MS, nextOn.get(e.n) ?? Infinity));
    out.push({ t: e.t, rank: 2, bytes: [0x90 | ch, e.n, scaleVelocity(e.v, gain)] }, { t: off, rank: 0, bytes: [0x80 | ch, e.n, 0] });
    nextOn.set(e.n, e.t);
  }
  return out.sort((a, b) => a.t - b.t || a.rank - b.rank).map(({ t, bytes }) => ({ t, bytes }));
}

// Plays timed messages with a look-ahead: one timer wakes every tickMs and sends whatever is due
// within the next lookMs, so a late timer shifts a note by at most one tick and nothing is chained.
// stop() sends a Note Off for every note still sounding.
export function createPlayer({ send, now, setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 10, lookMs = 5, onChange = () => {}, transform = (b) => b }) {
  let queue = [], i = 0, t0 = 0, pos = 0, timer = null, playing = false;
  const sounding = new Set();
  const fire = (bytes) => {
    const [status, n] = bytes;
    if ((status & 0xf0) === 0x90) sounding.add(`${status & 15}:${n}`);
    else if ((status & 0xf0) === 0x80) sounding.delete(`${status & 15}:${n}`);
    try { send(transform(bytes)); } catch { /* link gone: the app ends playback itself */ }
  };
  const end = () => { clearTimer(timer); timer = null; queue = []; playing = false; onChange(); };
  const tick = () => {
    timer = null;
    pos = now() - t0;
    while (i < queue.length && queue[i].t <= pos + lookMs) fire(queue[i++].bytes);
    if (i >= queue.length) end();
    else timer = setTimer(tick, Math.max(1, Math.min(tickMs * 5, Math.floor(queue[i].t - pos - lookMs)))); // sleep until the next note is due (at most 50 ms)
  };
  return {
    get playing() { return playing; },
    get position() { return pos; },
    play(messages) {
      if (playing) this.stop();
      queue = messages; i = 0; t0 = now(); pos = 0; playing = true;
      onChange();
      tick();
    },
    stop() {
      if (!playing) return;
      clearTimer(timer);
      for (const k of sounding) { const [ch, n] = k.split(':').map(Number); try { send([0x80 | ch, n, 0]); } catch { /* link gone */ } }
      sounding.clear();
      end();
    },
  };
}

// Which recording a quick press plays: the newest when one was made after the last playback began
// (or nothing was played yet), otherwise the last one played. `last` is { id, at } or null.
export function pickQuick(recs, last) {
  if (!recs.length) return null;
  const newest = recs.reduce((a, b) => (b.created > a.created ? b : a));
  const played = last && recs.find((r) => r.id === last.id);
  return !played || newest.created > last.at ? newest : played;
}

// Checks a recording read back from storage; returns a clean copy or null.
export function sanitizeRecording(r) {
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !Number.isFinite(r.created) || !Array.isArray(r.events)) return null;
  const byte = (x) => Number.isInteger(x) && x >= 0 && x <= 127;
  const events = [];
  for (const e of r.events.slice(0, MAX_EVENTS)) {
    if (!e || !Number.isFinite(e.t) || e.t < 0 || !byte(e.v)) return null;
    if (e.n != null && byte(e.n)) events.push({ t: e.t, n: e.n, v: e.v });
    else if (e.cc != null && byte(e.cc)) events.push({ t: e.t, cc: e.cc, v: e.v });
    else return null;
  }
  if (!events.some((e) => e.n != null)) return null;
  events.sort((a, b) => a.t - b.t);
  return { id: r.id, name: r.name.slice(0, 40), created: r.created, channel: Number.isInteger(r.channel) && r.channel >= 0 && r.channel < 16 ? r.channel : DRUM_CHANNEL, events };
}

// ---------- seeded recordings ----------
const hit = (t, pad, v, which = 0) => ({ t: Math.round(t), n: NOTE_MAP[pad][which], v });

export function seedBaDumTss() {
  // The classic rimshot: "ba-dum" is two quick hits close together (floor tom, then an accented snare),
  // then a beat of silence, then "tss": crash and kick together.
  const events = [hit(0, 'Tom 3', 98), hit(170, 'Snare', 120), hit(700, 'Crash 1', 124), hit(700, 'Kick', 112)];
  return { id: 'seed-ba-dum-tss', name: 'Ba-dum-tss', created: 2, seed: true, channel: DRUM_CHANNEL, events };
}

// Four bars at 138 bpm: two of groove on the hi-hat, one on the ride, then a fill round the toms.
export function seedFill() {
  const step = 60000 / 138 / 4; // a sixteenth
  const ev = [];
  const add = (s, pad, v, which) => ev.push(hit(s * step, pad, v, which));
  add(0, 'Crash 1', 118); add(0, 'Kick', 108);
  for (let bar = 0; bar < 2; bar++) {
    const b = bar * 16;
    for (let s = 0; s < 16; s += 2) add(b + s, 'Hi-Hat', s % 4 ? 70 : 88, bar === 1 && s === 14 ? 1 : 0);
    add(b, 'Kick', 108); add(b + 8, 'Kick', 104); add(b + 10, 'Kick', 92);
    add(b + 4, 'Snare', 104); add(b + 12, 'Snare', 108);
  }
  add(32, 'Crash 2', 112); add(32, 'Kick', 108);
  for (let s = 32; s < 48; s += 2) add(s, 'Ride', s % 4 ? 72 : 90);
  add(40, 'Kick', 104); add(36, 'Snare', 104); add(44, 'Snare', 108);
  for (let s = 48; s < 56; s++) add(s, 'Snare', 70 + (s - 48) * 5);
  [['Tom 1', 56], ['Tom 1', 57], ['Tom 2', 58], ['Tom 2', 59], ['Tom 3', 60], ['Tom 3', 61]].forEach(([p, s], k) => add(s, p, 100 + k * 3));
  add(62, 'Kick', 110); add(63, 'Snare', 112);
  add(64, 'Crash 1', 124); add(64, 'Kick', 118); add(64, 'Crash 2', 118);
  ev.sort((a, b) => a.t - b.t);
  return { id: 'seed-fill', name: 'Drum fill', created: 1, seed: true, channel: DRUM_CHANNEL, events: ev };
}
export const seedRecordings = () => [seedBaDumTss(), seedFill()];

// `items` in the order of `ids`; anything not named keeps its place at the end.
export function reorder(items, ids) {
  const by = new Map(items.map((x) => [x.id, x]));
  const named = ids.filter((id) => by.has(id)).map((id) => by.get(id));
  return [...named, ...items.filter((x) => !ids.includes(x.id))];
}

// Settings kept beside the recordings: { order: [ids], gains: { id: factor } }.
export function sanitizePrefs(p) {
  const order = Array.isArray(p?.order) ? p.order.filter((x) => typeof x === 'string') : [];
  const gains = {};
  for (const [id, g] of Object.entries(p?.gains ?? {})) if (Number.isFinite(g) && g > 0 && g <= 127) gains[id] = g;
  return { order, gains };
}

// ---------- Standard MIDI File: export and import ----------
const PPQ = 480, TEMPO_US = 500000, TICKS_PER_MS = PPQ * 1000 / TEMPO_US; // 120 bpm: about one tick per millisecond
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_IMPORT_MS = 10 * 60 * 1000;

const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

// A type 0 file with one track at 120 bpm. The loudness (`gain`) is baked in, so the file sounds like the app plays it.
export function toMidiFile(rec, { gain = 1 } = {}) {
  const name = [...rec.name].map((ch) => (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127 ? ch.charCodeAt(0) : 63)).slice(0, 60);
  const body = [0, 0xff, 0x03, ...vlq(name.length), ...name, 0, 0xff, 0x51, 3, TEMPO_US >> 16, (TEMPO_US >> 8) & 255, TEMPO_US & 255];
  let tick = 0;
  for (const m of playbackMessages(rec, gain)) {
    const at = Math.max(tick, Math.round(m.t * TICKS_PER_MS));
    body.push(...vlq(at - tick), ...m.bytes);
    tick = at;
  }
  body.push(0, 0xff, 0x2f, 0);
  return Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]);
}

// Reads a Standard MIDI File (type 0 or 1) into { channel, events, notes, unmapped, truncated }:
// the notes of one channel (10 when the file has it, else the first channel with notes), always replayed on channel 10, tempo changes
// followed, leading silence trimmed. Throws an Error with a readable message when it cannot.
export function parseMidiFile(bytes) {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('The file is larger than 1 MB');
  let p = 0;
  const need = (n) => { if (p + n > bytes.length) throw new Error('The file is damaged'); };
  const u8 = () => { need(1); return bytes[p++]; };
  const u16 = () => (u8() << 8) | u8();
  const u32r = () => ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
  const tag = () => String.fromCharCode(u8(), u8(), u8(), u8());
  if (tag() !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32r(), format = u16(), tracks = u16(), division = u16();
  if (format > 1) throw new Error('Only MIDI file types 0 and 1 are supported');
  if (division & 0x8000 || !division) throw new Error('Time-code timing is not supported');
  p = 8 + hlen;
  const notes = [], ccs = [], tempos = [];
  for (let k = 0; k < tracks && p < bytes.length; k++) {
    const kind = tag(), len = u32r(), endOfTrack = p + len;
    if (endOfTrack > bytes.length) throw new Error('The file is damaged');
    if (kind !== 'MTrk') { p = endOfTrack; continue; }
    let tick = 0, running = 0;
    const readVlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    while (p < endOfTrack) {
      tick += readVlq();
      let status = u8();
      if (status < 0x80) { if (!running) throw new Error('The file is damaged'); p--; status = running; } else if (status < 0xf0) running = status;
      if (status === 0xff) {
        const type = u8(), n = readVlq();
        need(n);
        if (type === 0x51 && n === 3) tempos.push({ tick, us: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2] });
        p += n;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        const n = readVlq(); need(n); p += n;
      } else {
        const hi = status & 0xf0, ch = status & 15, a = u8(), b = hi === 0xc0 || hi === 0xd0 ? 0 : u8();
        if (hi === 0x90 && b > 0) notes.push({ tick, ch, n: a, v: b });
        else if (hi === 0xb0 && a === HAT_CC) ccs.push({ tick, ch, v: b });
      }
    }
    p = endOfTrack;
  }
  if (!notes.length) throw new Error('The file has no notes');
  const first = notes.reduce((x, y) => (y.tick < x.tick ? y : x));
  const channel = notes.some((x) => x.ch === 9) ? 9 : first.ch;
  // ticks -> ms through the tempo map
  tempos.sort((x, y) => x.tick - y.tick);
  const toMs = (tick) => {
    let ms = 0, at = 0, us = 500000;
    for (const t of tempos) {
      if (t.tick >= tick) break;
      ms += (t.tick - at) * us / division / 1000;
      at = t.tick; us = t.us;
    }
    return ms + (tick - at) * us / division / 1000;
  };
  const t0 = toMs(first.tick);
  let events = [];
  for (const x of notes) if (x.ch === channel) events.push({ t: Math.round(toMs(x.tick) - t0), n: x.n, v: x.v });
  const lead = ccs.filter((x) => x.ch === channel && x.tick < first.tick).pop();
  for (const x of ccs) if (x.ch === channel && x.tick >= first.tick) events.push({ t: Math.round(toMs(x.tick) - t0), cc: HAT_CC, v: x.v });
  events.sort((x, y) => x.t - y.t || (x.cc != null ? -1 : 0) - (y.cc != null ? -1 : 0)); // the pedal first at equal times
  events = events.filter((e) => e.t <= MAX_IMPORT_MS);
  if (lead) events.unshift({ t: 0, cc: HAT_CC, v: lead.v });
  const truncated = events.length > MAX_EVENTS;
  events = events.slice(0, MAX_EVENTS);
  const played = events.filter((e) => e.n != null);
  // The file's own channel says nothing about the module: it listens for drums on its pad channel (10 by default),
  // so imported notes are always replayed there. Many drum loops are written on channel 1, which the module ignores.
  return { channel: DRUM_CHANNEL, sourceChannel: channel, events, notes: played.length, unmapped: played.filter((e) => padOfNote(e.n) == null).length, truncated };
}

// Tries `action` again every `everyMs` until it works, `windowMs` have passed, or shouldStop() is true; then
// rethrows the last error. Used to wait out Android's pairing dialogs instead of giving up and starting over.
export async function retryUntil(action, { windowMs, everyMs = 1000, sleep, now, shouldStop = () => false, onWait = () => {} }) {
  const deadline = now() + windowMs;
  for (;;) {
    try { return await action(); } catch (e) {
      if (shouldStop() || now() >= deadline) throw e;
      onWait(e);
      await sleep(everyMs);
    }
  }
}

// The TD-17's MIDI ports among the ones the browser lists (USB): the first input and output named TD-17.
export function pickTd17Ports(inputs, outputs) {
  const ok = (p) => /TD-17/i.test(p.name ?? '') && p.state !== 'disconnected';
  const input = inputs.find(ok), output = outputs.find(ok);
  return input && output ? { input, output } : null;
}

// ---------- kit menu ----------
export const KIT_COUNT = 100;
export const PRESET_KITS = 50; // kits 1-50 are the factory kits, 51-100 are user kits
export const isUserKit = (kit) => kit >= PRESET_KITS;
// The next kit whose name to read: one on screen first (lowest first), else the nearest to `current`.
export function nextKitToName(known, failed, visible, current) {
  const todo = (k) => !known.has(k) && !failed.has(k);
  const seen = [...visible].filter(todo).sort((a, b) => a - b)[0];
  if (seen != null) return seen;
  let best = null;
  for (let k = 0; k < KIT_COUNT; k++) if (todo(k) && (best == null || Math.abs(k - current) < Math.abs(best - current))) best = k;
  return best;
}
