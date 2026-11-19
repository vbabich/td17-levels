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

export function padValue(pad, kind, read = valueOf) {
  const list = layers(pad, kind);
  return read(list[captureLayers(list, kind, read).leader]);
}

const spreadEntry = (p, read) => ({ kind: p.role, value: read(p), main: p.main ? read(p.main) : undefined, on: p.on });

// The orange bar on a pad-wide fader: [lowest, highest], or null when everything agrees.
export function padBand(pad, kind, read = valueOf) {
  const band = td.spreadBand(padValue(pad, kind, read), layers(pad, kind).map((p) => spreadEntry(p, read)));
  return band ? [band.min, band.max] : null;
}

// The individual values that make the pad disagree, by the same rules as the bar.
export function disagreements(pad, kind, read = valueOf) {
  const leader = padValue(pad, kind, read);
  return layers(pad, kind).filter((p) => td.spreadBand(leader, [spreadEntry(p, read)]));
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
  'Hi-Hat': [42, 46, 44],
  'Crash 1': [49, 55],
  'Crash 2': [57, 52],
  'Ride': [51, 59, 53],
  'Aux': [27, 28],
};
export const padOfNote = (note) => Object.keys(NOTE_MAP).find((p) => NOTE_MAP[p].includes(note)) ?? null;

// What a note on a pad hits, for the highlight in the app: the pad (index in td.GROUPS), the zone
// (index in pad.zones) or, for cross-stick and the chick of the hi-hat pedal, the pad's extra value.
// Head/bow = zone 0, rim/edge = 1, bell = 2.
const ZONE_OF = { 'Snare': [0, 1], 'Tom 1': [0, 1], 'Tom 2': [0, 1], 'Tom 3': [0, 1], 'Hi-Hat': [0, 0], 'Crash 1': [0, 1], 'Crash 2': [0, 1], 'Ride': [0, 1, 2] };
export function noteTarget(note) {
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
  let channel = null;
  const rec = {
    get count() { return events.length; },
    get full() { return events.length >= MAX_EVENTS; },
    note(ch, n, v) {
      if (!v || rec.full) return;
      channel ??= ch;
      events.push({ t: now() - t0, n, v });
    },
    pedal(v) { if (!rec.full) events.push({ t: now() - t0, cc: HAT_CC, v }); },
    // Events from the first note on (the last pedal position before it is kept at 0), or null.
    finish() {
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

// Timed MIDI messages for a recording: [{ t, bytes }] sorted by time. Each Note On gets its Note Off
// NOTE_MS later (sooner when the same note is struck again). Offs come before controllers before ons.
export function playbackMessages(rec) {
  const ch = rec.channel ?? DRUM_CHANNEL;
  const out = [];
  rec.events.forEach((e, i) => {
    if (e.cc != null) { out.push({ t: e.t, rank: 1, bytes: [0xb0 | ch, e.cc, e.v] }); return; }
    const next = rec.events.slice(i + 1).find((x) => x.n === e.n);
    const off = Math.max(e.t + 1, Math.min(e.t + NOTE_MS, next ? next.t : Infinity));
    out.push({ t: e.t, rank: 2, bytes: [0x90 | ch, e.n, e.v] }, { t: off, rank: 0, bytes: [0x80 | ch, e.n, 0] });
  });
  return out.sort((a, b) => a.t - b.t || a.rank - b.rank).map(({ t, bytes }) => ({ t, bytes }));
}

// Plays timed messages with a look-ahead: one timer wakes every tickMs and sends whatever is due
// within the next lookMs, so a late timer shifts a note by at most one tick and nothing is chained.
// stop() sends a Note Off for every note still sounding.
export function createPlayer({ send, now, setTimer = setTimeout, clearTimer = clearTimeout, tickMs = 10, lookMs = 5, onChange = () => {} }) {
  let queue = [], i = 0, t0 = 0, timer = null, playing = false;
  const sounding = new Set();
  const fire = (bytes) => {
    const [status, n] = bytes;
    if ((status & 0xf0) === 0x90) sounding.add(`${status & 15}:${n}`);
    else if ((status & 0xf0) === 0x80) sounding.delete(`${status & 15}:${n}`);
    try { send(bytes); } catch { /* link gone: the app ends playback itself */ }
  };
  const end = () => { clearTimer(timer); timer = null; queue = []; playing = false; onChange(); };
  const tick = () => {
    timer = null;
    const el = now() - t0;
    while (i < queue.length && queue[i].t <= el + lookMs) fire(queue[i++].bytes);
    if (i >= queue.length) end();
    else timer = setTimer(tick, tickMs);
  };
  return {
    get playing() { return playing; },
    play(messages) {
      if (playing) this.stop();
      queue = messages; i = 0; t0 = now(); playing = true;
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
  const events = [hit(0, 'Snare', 96), hit(230, 'Kick', 110), hit(520, 'Crash 1', 118), hit(520, 'Kick', 100)];
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
