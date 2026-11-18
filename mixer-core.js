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
