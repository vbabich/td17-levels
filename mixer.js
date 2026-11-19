// TD-17 mixer: ten pad faders over Bluetooth MIDI. Design decisions: docs/mixer-layout.md.
import * as td from './td17.js?v=19';
import * as core from './mixer-core.js?v=8';
import { createSimModule } from './mixer-sim.js?v=2';

const { KIND, valueOf, originalOf } = core;
const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIM = new URLSearchParams(location.search).has('sim');
const MIN_GAP_MS = 20;   // Roland: leave at least 20 ms between DT1 messages
const MAX_RETRIES = 3;
const STABLE_MS = 30000; // a link up this long starts with a fresh set of retries
const MESSAGE_KEY = 'td17-mixer-message';

// ---------- state ----------
const S = {
  conn: 'disconnected', // disconnected | connecting | connected | reconnecting
  mode: 'level',
  kit: null,            // 0-99
  model: null,          // the kit on screen (see createKit)
  loaded: 0,            // pads read so far, in order
  comparing: false,
  busy: false,          // Compare or Restore is writing
  open: null,           // pad shown in the pad view
  attempt: 0,
  loadError: false,
  notice: '',
  message: '',          // shown on the connect screen
};
const kits = new Map(); // per kit, so the first-read originals survive kit changes
let deviceId = td.DEFAULT_DEVICE_ID;

const shown = (p) => (S.comparing ? p.original : p.value);
const locked = (i) => S.conn !== 'connected' || S.comparing || S.busy || i >= S.loaded;

// ---------- sending (serialised, spaced) ----------
let transport = null; // { send(bytes) }
let chain = Promise.resolve();
const waiters = [];   // pending replies: { match, resolve, reject, timer }

function send(bytes) {
  chain = chain.catch(() => {}).then(async () => {
    if (!transport) throw new Error('Not connected');
    await transport.send(bytes);
    await sleep(MIN_GAP_MS);
  });
  return chain;
}

// Latest-wins queue for fader moves: one pending write per value.
const pendingWrites = new Map();
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (pendingWrites.size && transport) {
      const [k, b] = pendingWrites.entries().next().value;
      pendingWrites.delete(k);
      await send(b).catch((e) => console.warn('Write failed:', e.message));
    }
  } finally {
    pumping = false;
  }
}
function writeParam(p, value) {
  pendingWrites.set(p.addr.join(), td.dt1(deviceId, p.addr, td.encodeNibbles(value, p.size)));
  pump();
}
async function writesDone() {
  while (transport && (pumping || pendingWrites.size)) await sleep(20);
  await chain.catch(() => {});
}

function waitFor(match, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const w = { match, resolve, reject };
    w.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1);
      reject(new Error('The module did not answer'));
    }, timeoutMs);
    waiters.push(w);
  });
}
function failWaiters() {
  for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('Connection lost')); }
}

async function request(address, size, timeoutMs) {
  const reply = waitFor((msg) => {
    const d = td.parseDt1(msg);
    return d && d.address.every((b, i) => b === address[i]) ? d : null;
  }, timeoutMs);
  send(td.rq1(deviceId, address, size)).catch(() => {});
  const d = await reply;
  if (!d.checksumOk) throw new Error('Reply had a bad checksum');
  return d.data;
}

async function readParam(p) {
  try { return td.decodeNibbles(await request(p.addr, p.size)); }
  catch (e) {
    if (!transport) throw e;
    return td.decodeNibbles(await request(p.addr, p.size)); // one more try
  }
}

// ---------- messages from the module ----------
function onMidi(msg) {
  if (msg[0] >= 0xf8) return; // clock / active sensing
  let solicited = false;
  for (let i = waiters.length - 1; i >= 0; i--) {
    const r = waiters[i].match(msg);
    if (r) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(r);
      solicited = true;
    }
  }
  if ((msg[0] & 0xf0) === 0x90 && msg[2] > 0) showHit(msg[1], msg[2]);
  if (recorder) { // the drummer's notes and hi-hat pedal
    const type = msg[0] & 0xf0;
    if (type === 0x90 && msg[2] > 0) recorder.note(msg[0] & 15, msg[1], msg[2]);
    else if (type === 0xb0 && msg[1] === core.HAT_CC) recorder.pedal(msg[2]);
    if (recorder.full) stopRecording();
  }
  if ((msg[0] & 0xf0) === 0xc0) { kitSignal(null); return; } // Program Change: the kit was switched
  if (msg[0] !== 0xf0 || solicited) return;
  const d = td.parseDt1(msg);
  if (d?.checksumOk) applyModuleMessage(d);
}

// A pad was hit on the module: lightly mark the pad row and, in the pad view, the values that hit edits.
const hitTimers = new Map();
// Velocity meters: a gray track (0-127) that is always there. A hit makes the green bar jump to its
// velocity and drain away fast; "vel N" stays for a moment, then "max N" (sticky) or nothing.
// With sticky on, an orange mark on the track sits at the loudest hit seen since the box was ticked.
const HOLD_MS_VEL = 800, DRAIN_MS = 350;
let stickyMax = false;
const maxByNote = new Map();
const liveMeters = new Set(); // meters still animating
let meterFrame = 0;
function maxFor(match) {
  let best = 0;
  for (const [note, v] of maxByNote) { const t = core.noteTarget(note); if (t && match(t) && v > best) best = v; }
  return best;
}
function makeMeter(parent, maxOf) {
  const el = h('div', 'vm'), txt = h('div', 'vt'), track = h('div', 'vb'), bar = h('i', 'vg'), mark = h('i', 'vx');
  track.append(bar, mark);
  el.append(txt, track);
  parent.append(el);
  return { el, txt, bar, mark, maxOf, v: 0, t: 0 };
}
function paintMeter(m, now = performance.now()) {
  const age = now - m.t, max = stickyMax ? m.maxOf() : 0, fresh = m.t > 0 && age < HOLD_MS_VEL;
  m.bar.style.width = `${m.t > 0 ? m.v * Math.max(0, 1 - age / DRAIN_MS) / 127 * 100 : 0}%`;
  m.mark.style.display = max ? 'block' : 'none';
  if (max) m.mark.style.left = `${max / 127 * 100}%`;
  if (fresh || max) m.txt.textContent = fresh ? `vel ${m.v}` : `max ${max}`; // without a max the last text fades out in place
  m.txt.style.opacity = fresh || max ? '1' : '0';
  m.txt.classList.toggle('now', fresh);
  return age < HOLD_MS_VEL + 50;
}
function runMeters(now) {
  meterFrame = 0;
  for (const m of liveMeters) if (!m.el.isConnected || !paintMeter(m, now)) liveMeters.delete(m);
  if (liveMeters.size) meterFrame = requestAnimationFrame(runMeters);
}
function meterHit(m, vel) {
  m.v = vel; m.t = performance.now();
  liveMeters.add(m);
  if (!meterFrame) meterFrame = requestAnimationFrame(runMeters);
  paintMeter(m);
}
// Pad rows show their loudest hit; an open pad shows it per zone, at the zone's heading.
function allMeters() {
  const list = padEls.map((e) => e.meter);
  return sheetParts ? list.concat(sheetParts.meters) : list;
}
function renderMax() { for (const m of allMeters()) paintMeter(m); }
function showHit(note, vel) {
  const t = core.noteTarget(note);
  if (t && stickyMax && vel > (maxByNote.get(note) ?? 0)) { maxByNote.set(note, vel); renderMax(); }
  if (!t || !S.model || t.pad >= S.loaded) return;
  const mark = (el) => {
    el.classList.add('hit');
    clearTimeout(hitTimers.get(el));
    hitTimers.set(el, setTimeout(() => el.classList.remove('hit'), 220));
  };
  mark(padEls[t.pad].pad);
  if (S.open == null) meterHit(padEls[t.pad].meter, vel); // with a pad open the list is hidden behind it
  if (S.open !== t.pad || !sheetParts) return;
  const pad = S.model.pads[t.pad];
  const extraAt = t.extra ? pad.extras.findIndex((x) => x.addr.join() === td.address[t.extra](S.kit).join()) : -1;
  const meter = sheetParts.meters[t.extra ? pad.zones.length + extraAt : t.zone];
  if (meter) meterHit(meter, vel);
  for (const { r, p } of sheetParts.rows) {
    const hit = t.extra ? p.role === 'extra' && p.addr.join() === td.address[t.extra](S.kit).join() : p.role !== 'extra' && p.zone === pad.zones[t.zone]?.name;
    if (hit) mark(r);
  }
}

const flashTimers = new Map();
function flash(i) {
  const row = padEls[i]?.pad;
  if (!row) return;
  row.classList.add('flash');
  clearTimeout(flashTimers.get(i));
  flashTimers.set(i, setTimeout(() => row.classList.remove('flash'), 1500));
}

// With "Transmit Edit Data" on, the module sends a DT1 whenever a value is edited on its
// own panel. These move the current value only: the original stays as first read.
function applyModuleMessage(d) {
  if (core.isKitNumberMessage(d)) { kitSignal(d.data[0]); return; }
  if (!S.model) return;
  let moved = false;
  for (const e of core.moduleEdits(S.model, d)) {
    const p = e.param;
    if ('on' in e) { p.on = e.on; moved = true; continue; }
    if (p.original == null || e.value === p.value) continue; // not read yet: the read will see it
    if (p.dragging || performance.now() - p.touched < core.TOUCH_GUARD_MS) continue; // never fight a fader in use
    p.value = e.value;
    moved = true;
    flash(p.pad);
  }
  if (moved) repaint();
}

// Several signals can announce one kit change, and kits can be stepped through quickly.
let kitTimer = 0;
function kitSignal(kit) {
  clearTimeout(kitTimer);
  kitTimer = setTimeout(async () => {
    if (S.conn !== 'connected') return;
    try {
      const k = kit ?? (await request(td.address.currentKit(), 1))[0];
      if (k !== S.kit || S.loaded < core.PAD_COUNT) loadKit(k);
    } catch (e) { console.warn('Kit check failed:', e.message); }
  }, 200);
}

// ---------- reading a kit ----------
let loadSeq = 0;
class Superseded extends Error {}

async function loadKit(kit = null) {
  const seq = ++loadSeq;
  confirmEpoch++;
  const alive = () => { if (seq !== loadSeq || S.conn !== 'connected') throw new Superseded(); };
  cancelDrags();
  closeSheet();
  dismissAsk();
  S.notice = '';
  S.loadError = false;
  S.loaded = 0;
  repaint();
  try {
    await leaveCompare();
    alive();
    const number = kit ?? (await request(td.address.currentKit(), 1))[0];
    alive();
    if (!kits.has(number)) kits.set(number, core.createKit(number));
    S.kit = number;
    S.model = kits.get(number);
    repaint();
    const model = S.model;
    // The kit name is a nicety: a kit without a readable name just shows its number.
    try { model.name = core.parseKitName(await request(core.kitNameAddress(number), core.KIT_NAME_SIZE, 800)); }
    catch { alive(); }
    alive();
    for (const pad of model.pads) {
      for (const z of pad.zones) {
        z.sub.on = (await request(z.sub.switchAddr, 1))[0] === 1;
        alive();
      }
      for (const p of pad.params) {
        const value = await readParam(p);
        alive();
        p.value = value;
        p.original ??= value;
      }
      S.loaded = pad.index + 1;
      repaint();
    }
  } catch (e) {
    if (e instanceof Superseded || seq !== loadSeq || S.conn !== 'connected') return;
    console.warn('Reading the kit failed:', e.message);
    S.loadError = true;
    repaint();
  }
}

// ---------- reading back after writes ----------
// The module has the last word: if it kept something else, show what it kept.
const confirmSet = new Set();
let confirmTimer = 0;
let confirmEpoch = 0;
function confirmLater(params) {
  params.forEach((p) => confirmSet.add(p));
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(runConfirm, 350);
}
async function runConfirm() {
  const list = [...confirmSet];
  confirmSet.clear();
  const epoch = confirmEpoch;
  try {
    await writesDone();
    const started = performance.now();
    const differ = [];
    for (const p of list) {
      const actual = await readParam(p);
      if (epoch !== confirmEpoch || S.conn !== 'connected') return;
      if (p.dragging || p.touched > started) continue; // moved again: a later check covers it
      if (actual !== p.value) { p.value = actual; differ.push(p); }
    }
    if (differ.length) {
      const p = differ[0];
      showNotice(differ.length === 1
        ? `The module kept ${p.padName} ${p.name} at ${core.fmtText(p.kind, p.value)}`
        : `The module kept different values for ${differ.length} settings`);
    }
  } catch (e) { console.warn('Read-back failed:', e.message); }
}

let noticeTimer = 0;
function showNotice(text) {
  S.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(clearNotice, 5000);
  repaint();
}
function clearNotice() { S.notice = ''; repaint(); }

// ---------- fader ----------
// Grabbing is relative: a touch changes nothing until it has moved 8 px along the fader,
// then the value follows the finger from where it was. Taps and brushes do nothing.
const faders = new Set();
const buzz = (ms) => { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(ms); };

function makeFader(o, extraClass = '') {
  const el = h('div', `fader ${extraClass}`);
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.innerHTML = '<div class="track"><i class="bars"><i class="fill"></i><i class="band"></i></i><i class="tick"></i><i class="orig"></i><i class="thumb"></i></div>';
  const track = el.firstChild;
  const kind = () => (typeof o.kind === 'function' ? o.kind() : o.kind);
  let st = null;

  const finish = () => {
    if (!st) return;
    clearTimeout(st.hold);
    const wasOn = st.on;
    st = null;
    el.classList.remove('drag', 'fine');
    if (wasOn) o.end?.();
  };

  const f = {
    el, o, kind, cancel: finish,
    paint() {
      if (o.ready && !o.ready()) return;
      const K = KIND[kind()], v = o.get(), band = o.band?.(), orig = o.orig();
      el.classList.toggle('pan', kind() === 'pan');
      el.classList.toggle('spread', Boolean(band));
      el.classList.toggle('changed', orig !== v);
      el.classList.toggle('locked', Boolean(o.locked?.()));
      el.style.setProperty('--p', K.pos(v));
      el.style.setProperty('--o', K.pos(orig));
      if (band) { el.style.setProperty('--b0', K.pos(band[0])); el.style.setProperty('--b1', K.pos(band[1])); }
      el.setAttribute('aria-label', o.label());
      el.setAttribute('aria-valuetext', core.fmtText(kind(), v));
      el.setAttribute('aria-valuemin', K.min);
      el.setAttribute('aria-valuemax', K.max);
      el.setAttribute('aria-valuenow', v);
    },
    nudge(steps) { // one-off change (− and + buttons, keyboard)
      if (o.locked?.()) return;
      const K = KIND[kind()];
      o.begin?.();
      o.set(clamp(o.get() + steps * K.step, K.min, K.max));
      o.end?.();
      repaint();
    },
  };

  el.addEventListener('pointerdown', (e) => {
    if (st || o.locked?.() || e.button > 0) return;
    const r = track.getBoundingClientRect();
    const mine = st = { id: e.pointerId, x: e.clientX, y: e.clientY, along: 0, len: r.width, p0: KIND[kind()].pos(o.get()), on: false, slip: 0, snapped: o.get() };
    // Press and hold without moving: precision mode. Every 6 px of movement is one step
    // (0.1 dB, or one pan step), and nothing snaps.
    st.hold = setTimeout(() => {
      if (st !== mine || st.on || o.locked?.()) return;
      Object.assign(st, { on: true, fine: true, slip: st.along, v0: o.get() });
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      o.begin?.();
      el.classList.add('drag', 'fine');
      buzz(25);
    }, core.HOLD_MS);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault()); // a long press must not open a menu
  el.addEventListener('touchmove', (e) => { if (st?.on && e.cancelable) e.preventDefault(); }, { passive: false }); // a drag in progress must not turn into a scroll
  el.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const along = e.clientX - st.x, across = st.y - e.clientY;
    st.along = along;
    const K = KIND[kind()];
    if (st.fine) {
      const v = core.fineValue(kind(), st.v0, along - st.slip);
      if (v !== o.get()) { o.set(v); repaint(); }
      return;
    }
    if (!st.on) {
      if (Math.abs(along) < core.GRAB_PX) {
        if (Math.abs(across) > 14) { clearTimeout(st.hold); st = null; }
        return;
      }
      clearTimeout(st.hold);
      st.on = true;
      st.slip = along;
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      o.begin?.();
      el.classList.add('drag');
    }
    const pos = clamp(st.p0 + (along - st.slip) / st.len, 0, 1);
    // Sticky spots: 0 dB or centre, the original value and, in the pad view, related sliders.
    const snap = core.pickSnap(kind(), pos, st.len, [0, o.orig(), ...(o.snaps?.() ?? [])]);
    if (snap !== undefined && snap !== st.snapped) buzz(8);
    st.snapped = snap;
    const v = snap ?? K.val(pos);
    if (v !== o.get()) { o.set(v); repaint(); }
  });
  const end = (e) => { if (st && e.pointerId === st.id) finish(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d || o.locked?.()) return;
    e.preventDefault();
    f.nudge(d);
  });
  faders.add(f);
  return f;
}
const cancelDrags = () => { for (const f of faders) f.cancel(); };

// A pad-wide Level or Pan: moves every value under it by the same amount.
function padControl(i, kindOf) {
  const kind = () => (typeof kindOf === 'function' ? kindOf() : kindOf);
  const pad = () => S.model.pads[i];
  let list = [], blend = null;
  const moved = new Set();
  return {
    kind,
    label: () => `${pad().name} ${kind() === 'pan' ? 'pan' : 'level'}`,
    ready: () => Boolean(S.model) && i < S.loaded,
    get: () => core.padValue(pad(), kind(), shown),
    orig: () => core.padValue(pad(), kind(), originalOf),
    band: () => core.padBand(pad(), kind(), shown),
    locked: () => locked(i),
    begin() {
      list = core.layers(pad(), kind());
      blend = core.captureLayers(list, kind());
      moved.clear();
      for (const p of list) p.dragging = true;
    },
    set(level) {
      td.applyBlend(blend, level).forEach((value, n) => {
        const p = list[n];
        if (value === null || value === p.value) return;
        p.value = value;
        p.touched = performance.now();
        moved.add(p);
        if (!core.isDeferred(p)) writeParam(p, value);
      });
    },
    end() {
      for (const p of list) p.dragging = false;
      for (const p of moved) writeParam(p, p.value); // deferred values, and the last word over anything ignored meanwhile
      confirmLater([...moved]);
    },
  };
}

// One stored value in the pad view.
function paramControl(i, p) {
  return {
    kind: p.kind,
    label: () => `${p.padName} ${p.name}`,
    get: () => p.value,
    orig: () => p.original,
    locked: () => locked(i),
    snaps: () => core.relatedValues(S.model.pads[i], p),
    begin() { p.dragging = true; },
    set(v) { p.value = v; p.touched = performance.now(); writeParam(p, v); },
    end() { p.dragging = false; writeParam(p, p.value); confirmLater([p]); },
  };
}


// ---------- record and replay ----------
const RECS_KEY = 'td17-mixer-recordings';
const LAST_KEY = 'td17-mixer-last-played';
const PREFS_KEY = 'td17-mixer-recording-prefs';
const LONG_PRESS_MS = 500;
let recorder = null;       // while recording
let userRecs = [];         // recorded on this phone
let lastPlayed = null;     // { id, at }
let playingId = null, playingRec = null;
try {
  userRecs = (JSON.parse(localStorage.getItem(RECS_KEY) ?? '[]') ?? []).map(core.sanitizeRecording).filter(Boolean);
  const l = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
  if (l && typeof l.id === 'string' && Number.isFinite(l.at)) lastPlayed = l;
} catch { /* storage unavailable or damaged: start with the seeds only */ }
let prefs = { order: [], gains: {} }; // the list's order (seeds included) and each recording's loudness factor
try { prefs = core.sanitizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null')); } catch { /* defaults */ }
const gainOf = (rec) => prefs.gains[rec.id] ?? 1;
const allRecs = () => core.reorder([...userRecs, ...core.seedRecordings()], prefs.order);
// The Play list: the user's recordings in their own order (new ones go on top), then the built-in ones.
function saveRecs() {
  try {
    localStorage.setItem(RECS_KEY, JSON.stringify(userRecs));
    localStorage.setItem(LAST_KEY, JSON.stringify(lastPlayed));
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) { console.warn('Could not save recordings:', e.message); }
}

const player = core.createPlayer({
  send: (bytes) => { transport?.sendShort(bytes)?.catch?.(() => {}); },
  now: () => performance.now(),
  // Loudness is applied as each note goes out, so the slider in Settings changes playback live.
  transform: (b) => ((b[0] & 0xf0) === 0x90 && playingRec ? [b[0], b[1], core.scaleVelocity(b[2], gainOf(playingRec))] : b),
  onChange: () => { if (!player.playing) playingId = playingRec = null; repaintRecPlay(); },
});

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function repaintRecPlay() {
  const ready = S.conn === 'connected' && S.loaded >= core.PAD_COUNT;
  const rec = $('rec'), play = $('play'), playing = player.playing;
  rec.dataset.state = recorder ? 'on' : 'off';
  rec.disabled = !ready && !recorder;
  rec.setAttribute('aria-label', recorder ? 'Stop recording' : 'Record');
  play.dataset.state = playing ? 'on' : 'off';
  play.disabled = Boolean(recorder) || (!ready && !playing);
  play.setAttribute('aria-label', playing ? 'Stop' : 'Play');
  repaintRowPlay();
}

// The ring on Stop: how much of the recording has played.
let playStart = 0, playMs = 1, ringFrame = 0;
function drawRing() {
  ringFrame = 0;
  if (!player.playing) { $('ringFill').style.strokeDashoffset = ''; return; }
  const done = Math.min(1, (performance.now() - playStart) / playMs);
  const offset = String(113.1 * (1 - done));
  $('ringFill').style.strokeDashoffset = offset;
  for (const f of document.querySelectorAll('.rowplay[data-state=on] .ring circle + circle')) f.style.strokeDashoffset = offset;
  ringFrame = requestAnimationFrame(drawRing);
}

function playRecording(rec) {
  if (!transport || recorder) return;
  closeMenu();
  stopPlayback(); // the previous recording's Note Offs go out first; its end resets playingId
  playingId = rec.id;
  lastPlayed = { id: rec.id, at: Date.now() };
  saveRecs();
  playStart = performance.now();
  playMs = core.recordingMs(rec);
  playingRec = rec;
  player.play(core.playbackMessages(rec));
  if (player.playing && !ringFrame) drawRing();
  if (!player.playing) playingId = playingRec = null;
}
function stopPlayback() { player.stop(); }

function startRecording() {
  if (recorder || !transport) return;
  stopPlayback();
  closeMenu();
  recorder = core.createRecorder(() => performance.now());
  repaintRecPlay();
}
function stopRecording() {
  if (!recorder) return;
  const done = recorder.finish();
  recorder = null;
  if (done) {
    const created = Date.now();
    const rec = { id: `r${created}`, name: core.recordingName(new Date(created)), created, ...done };
    userRecs = [rec, ...userRecs].slice(0, core.MAX_SAVED);
    prefs.order = [rec.id, ...prefs.order];
    saveRecs();
    toast(`Saved ${rec.name} (${core.fmtDuration(core.recordingMs(rec))})`);
  } else toast('Nothing recorded');
  repaintRecPlay();
}
$('rec').onclick = () => (recorder ? stopRecording() : startRecording());

// ---------- the cog: reorder and delete the user's recordings ----------
const panel = $('recsPanel'), list = $('recsList');
const GRIP = '<svg viewBox="0 0 24 24"><path d="M4 7h16v2H4zm0 4h16v2H4zm0 4h16v2H4z"/></svg>';
const RING = '<svg viewBox="0 0 44 44" class="ring"><circle cx="22" cy="22" r="18"/><circle cx="22" cy="22" r="18"/></svg>';
const ROWPLAY = '<svg viewBox="0 0 24 24" class="i-play"><path d="M7 4.5v15l13-7.5z"/></svg><svg viewBox="0 0 24 24" class="i-stop"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' + RING;
const TRASH = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
function makeRowPlay(r) {
  const play = h('button', 'rowplay');
  play.innerHTML = ROWPLAY;
  play.onclick = () => (player.playing && playingId === r.id ? stopPlayback() : playRecording(r));
  return play;
}
// The velocity slider covers its row (nothing around it moves) and leaves Play within reach.
const setChip = (chip, n) => { chip.replaceChildren(h('small', '', 'MAX'), h('b', '', String(n))); };
function openAdjust(li, r, chip) {
  const box = h('div', 'adjust'), slider = h('input'), out = h('output'), ok = h('button', 'ok');
  slider.type = 'range'; slider.min = 1; slider.max = 127; slider.step = 1;
  slider.value = core.maxVelocity(r, gainOf(r));
  slider.setAttribute('aria-label', `Loudest hit of ${r.name}`);
  const show = () => { out.textContent = slider.value; };
  show();
  const revert = h('button', 'revert', 'Revert');
  revert.setAttribute('aria-label', 'Back to the recorded loudness');
  revert.disabled = !(r.id in prefs.gains);
  slider.oninput = () => {
    show();
    prefs.gains[r.id] = core.gainForMax(r, Number(slider.value));
    setChip(chip, Number(slider.value));
    revert.disabled = false;
  };
  slider.onchange = saveRecs;
  revert.onclick = () => {
    delete prefs.gains[r.id];
    slider.value = core.maxVelocity(r);
    show(); setChip(chip, Number(slider.value));
    revert.disabled = true;
    saveRecs();
  };
  ok.textContent = '✓'; ok.setAttribute('aria-label', 'Done');
  ok.onclick = () => { saveRecs(); box.remove(); };
  box.append(slider, out, revert, makeRowPlay(r), ok);
  li.append(box);
  repaintRowPlay();
  slider.focus();
}
function buildRecsList() {
  $('recsEmpty').hidden = true;
  list.replaceChildren(...allRecs().map((r) => {
    const li = h('li'), nm = h('div', 'nm'), sub = h('div', 'sub'), grip = h('button', 'grip'), del = h('button', 'del');
    li.dataset.id = r.id;
    const chip = h('button', 'chip');
    setChip(chip, core.maxVelocity(r, gainOf(r)));
    chip.setAttribute('aria-label', `Adjust loudness of ${r.name}`);
    chip.onclick = () => openAdjust(li, r, chip);
    sub.append(h('small', '', core.fmtDuration(core.recordingMs(r))));
    nm.append(h('span', '', r.name), sub);
    grip.innerHTML = GRIP; grip.setAttribute('aria-label', `Move ${r.name}`);
    del.innerHTML = TRASH; del.setAttribute('aria-label', `Delete ${r.name}`);
    del.disabled = Boolean(r.seed); // the built-in recordings stay
    del.onclick = async () => {
      const yes = await ask('Delete this recording?', `${r.name} (${core.fmtDuration(core.recordingMs(r))}) will be removed from this phone. This cannot be undone.`, 'Delete');
      if (!yes) return;
      userRecs = userRecs.filter((x) => x.id !== r.id);
      prefs.order = prefs.order.filter((x) => x !== r.id);
      delete prefs.gains[r.id];
      saveRecs();
      buildRecsList();
    };
    // Drag the handle: the row follows the finger by swapping places with its neighbours.
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      li.classList.add('moving');
      grip.onpointermove = (m) => {
        const box = list.getBoundingClientRect();
        if (m.clientY < box.top + 24) list.scrollTop -= 10; else if (m.clientY > box.bottom - 24) list.scrollTop += 10;
        const next = [...list.children].find((x) => x !== li && m.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
        if (next) { if (li.nextSibling !== next) list.insertBefore(li, next); } else list.append(li);
      };
      const done = () => {
        grip.onpointermove = grip.onpointerup = grip.onpointercancel = null;
        li.classList.remove('moving');
        prefs.order = [...list.children].map((x) => x.dataset.id);
        saveRecs();
      };
      grip.onpointerup = grip.onpointercancel = done;
    });
    li.append(grip, nm, chip, makeRowPlay(r), del);
    return li;
  }));
  repaintRowPlay();
}
// Play/Stop buttons in the list follow the same state as the top bar.
function repaintRowPlay() {
  const ready = S.conn === 'connected' && S.loaded >= core.PAD_COUNT;
  for (const b of list.querySelectorAll('.rowplay')) {
    const on = player.playing && playingId === b.closest('li').dataset.id;
    b.dataset.state = on ? 'on' : 'off';
    b.disabled = !on && (Boolean(recorder) || !ready);
    b.setAttribute('aria-label', on ? 'Stop' : 'Play');
    if (!on) b.querySelector('.ring circle + circle').style.strokeDashoffset = '';
  }
}
$('cog').onclick = () => { closeMenu(); buildRecsList(); panel.showModal(); };
// Ticking (and unticking) starts a new measurement: the stored maxima are cleared.
$('stickyMax').onchange = (e) => { stickyMax = e.target.checked; maxByNote.clear(); renderMax(); };
$('recsClose').onclick = () => panel.close();
panel.addEventListener('click', (e) => { if (e.target === panel) panel.close(); });

// Play: a quick press plays (or stops); a long press lists the recordings.
const menu = $('menu');
function closeMenu() { menu.hidden = true; }
function openMenu() {
  menu.replaceChildren(...allRecs().map((r) => {
    const b = h('button'), name = h('span', '', r.name), dur = h('small', '', core.fmtDuration(core.recordingMs(r)));
    b.setAttribute('role', 'menuitem');
    b.append(name, dur);
    b.onclick = () => playRecording(r);
    return b;
  }));
  const r = $('play').getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(10, document.documentElement.clientWidth - r.right)}px`;
  menu.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 16)}px`;
  menu.hidden = false;
}
{
  const btn = $('play');
  let holdTimer = 0, swallow = false;
  btn.addEventListener('pointerdown', () => {
    swallow = !menu.hidden; // a press that only closes the menu does nothing else
    clearTimeout(holdTimer);
    if (swallow) { closeMenu(); return; }
    holdTimer = setTimeout(() => { swallow = true; openMenu(); buzz(20); }, LONG_PRESS_MS);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, () => clearTimeout(holdTimer));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    if (swallow) { swallow = false; return; }
    if (player.playing) { stopPlayback(); return; }
    const rec = core.pickQuick(allRecs(), lastPlayed);
    if (rec) playRecording(rec);
  });
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ContextMenu') { e.preventDefault(); openMenu(); menu.firstChild?.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target.closest?.('#play') == null) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
}

// ---------- main screen ----------
const padEls = [];
function setValue(out, kind, v) {
  const [text, unit] = KIND[kind].fmt(v);
  out.textContent = text;
  if (unit) out.append(h('small', '', unit));
}

function buildMixer() {
  td.GROUPS.forEach((group, i) => {
    const pad = h('div', 'pad');
    const btn = h('button', 'name');
    btn.append(h('b', '', group.name));
    btn.setAttribute('aria-label', `${group.name}: open individual values`);
    btn.onclick = () => { if (!locked(i)) openSheet(i); };
    const f = makeFader(padControl(i, () => S.mode));
    f.main = true;
    const val = h('output', 'val');
    pad.append(btn, f.el, val);
    $('mixer').append(pad);
    padEls.push({ pad, val, meter: makeMeter(pad, () => maxFor((t) => t.pad === i)) });
  });
}

function setBanner(cls, text, action, fn, disabled = false) {
  const b = $('banner');
  b.hidden = false;
  b.className = cls;
  b.firstChild.textContent = text;
  b.lastChild.textContent = action;
  b.lastChild.onclick = fn;
  b.lastChild.disabled = disabled;
}

function repaint() {
  const live = S.conn === 'connected' || S.conn === 'reconnecting';
  const loading = S.loaded < core.PAD_COUNT;
  document.body.dataset.conn = S.conn;
  document.body.classList.toggle('locked', locked(0) && S.loaded > 0);
  $('mixer').hidden = !live;
  $('connect').hidden = live;
  $('connText').textContent = { connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', disconnected: 'Not connected' }[S.conn];
  $('connectBtn').disabled = S.conn === 'connecting';
  $('connectBtn').textContent = S.conn === 'connecting' ? 'Connecting…' : SIM ? 'Connect to simulator' : 'Connect via Bluetooth';
  $('connectMsg').textContent = S.message;
  $('kit').style.visibility = live ? '' : 'hidden';
  $('kitNo').textContent = S.kit == null ? 'Kit' : `Kit ${S.kit + 1}`;
  $('kitName').textContent = loading ? `Loading ${S.loaded}/${core.PAD_COUNT}…` : S.model?.name ?? '';
  $('progress').firstChild.style.width = loading && S.conn === 'connected' ? `${S.loaded * 10}%` : '0';

  for (const f of faders) f.paint();
  padEls.forEach(({ pad, val }, i) => {
    const rowLoading = i >= S.loaded || !S.model;
    pad.classList.toggle('loading', rowLoading);
    if (rowLoading) val.textContent = '– –';
    else setValue(val, S.mode, core.padValue(S.model.pads[i], S.mode, shown));
  });

  const changed = S.model && !loading ? S.model.pads.filter(core.isChanged) : [];
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', b.dataset.mode === S.mode);
  $('restore').disabled = !changed.length || S.comparing || S.busy;
  $('compare').disabled = S.busy || loading || (!changed.length && !S.comparing);
  $('compare').setAttribute('aria-pressed', S.comparing);
  $('compare').textContent = S.comparing ? 'Original' : 'Compare';

  if (S.conn === 'reconnecting') setBanner('warn', `Reconnecting… (try ${S.attempt} of ${MAX_RETRIES})`, 'Stop', stopLink);
  else if (S.loadError) setBanner('warn', 'Could not read this kit', 'Retry', () => loadKit());
  else if (S.comparing && S.conn === 'connected') setBanner('info', 'Showing original values', 'Back to mine', toggleCompare, S.busy);
  else if (S.notice && S.conn === 'connected') setBanner('warn', S.notice, 'OK', clearNotice);
  else $('banner').hidden = true;

  if (S.open != null) paintSheet();
  repaintRecPlay();
}

// ---------- one pad opened: pad Level and Pan, why it is orange, then every stored value ----------
let sheetParts = null;
function openSheet(i) {
  S.open = i;
  dropSheetFaders();
  const pad = S.model.pads[i];
  $('sheetTitle').textContent = pad.name;

  const big = (kind, title) => {
    const box = h('div', `big ${kind}`), lab = h('div', 'lab'), out = h('output'), ctl = h('div', 'ctl');
    const f = makeFader(padControl(i, kind));
    const minus = h('button', '', '−'), plus = h('button', '', '+');
    minus.setAttribute('aria-label', `${title} down`);
    plus.setAttribute('aria-label', `${title} up`);
    minus.onclick = () => f.nudge(-1);
    plus.onclick = () => f.nudge(1);
    lab.append(h('span', '', title), out);
    ctl.append(minus, f.el, plus);
    box.append(lab, ctl);
    return { box, out, kind, get: f.o.get };
  };
  const level = big('level', 'Level'), pan = big('pan', 'Pan'), why = h('div', 'why');
  $('sheetMain').replaceChildren(level.box, pan.box, why);

  const rows = [];
  const row = (label, p) => {
    const r = h('div', 'drow'), lab = h('span', 'lab', label), out = h('output');
    const f = makeFader(paramControl(i, p), 'detail');
    r.append(lab, f.el, out);
    rows.push({ r, lab, out, p });
    return r;
  };
  const detail = [], heads = [];
  const head = (text) => { const e = h('h3', '', text); heads.push(e); return e; };
  for (const z of pad.zones) detail.push(head(z.name), row('Main', z.main), row('Sub', z.sub), row('Pan', z.pan));
  for (const x of pad.extras) detail.push(head(x.name), row('Volume', x));
  $('sheetDetail').replaceChildren(...detail);

  const group = td.GROUPS[i];
  const meters = heads.map((head, k) => makeMeter(head, k < pad.zones.length
    ? () => maxFor((t) => t.pad === i && !t.extra && t.zone === k)
    : () => maxFor((t) => t.pad === i && t.extra === group.extras[k - pad.zones.length])));
  sheetParts = { level, pan, why, rows, heads, meters };
  renderMax();
  $('sheet').hidden = false;
  $('sheet').querySelector('.sheet-body').scrollTop = 0;
  history.pushState({ sheet: true }, '');
  repaint();
}

function paintSheet() {
  const pad = S.model.pads[S.open], { level, pan, why, rows } = sheetParts;
  for (const b of [level, pan]) setValue(b.out, b.kind, b.get());
  const odd = [...core.disagreements(pad, 'level'), ...core.disagreements(pad, 'pan')];
  for (const { r, lab, out, p } of rows) {
    setValue(out, p.kind, p.value);
    if (p.role === 'sub') { lab.textContent = p.on ? 'Sub' : 'Sub (off)'; r.classList.toggle('off', !p.on); }
    r.classList.toggle('odd', odd.includes(p));
  }
  why.classList.toggle('on', odd.length > 0);
  why.textContent = odd.length
    ? `${odd.length === 1 ? '1 value disagrees' : `${odd.length} values disagree`}: ${odd.map((p) => p.name).join(', ')}`
    : 'All values under this pad agree';
  $('padRestore').disabled = !core.isChanged(pad) || S.busy;
}

function dropSheetFaders() {
  for (const f of faders) if (!f.main) { f.cancel(); faders.delete(f); }
}
function hideSheet() {
  if (S.open == null) return;
  S.open = null;
  sheetParts = null;
  dropSheetFaders();
  $('sheet').hidden = true;
  repaint();
}
// Done closes at once; the phone's Back button closes it too.
function closeSheet() {
  if (S.open == null) return;
  hideSheet();
  if (history.state?.sheet) history.back();
}
window.addEventListener('popstate', () => { if (!history.state?.sheet) hideSheet(); });
$('sheetClose').onclick = closeSheet;

// ---------- confirm dialog ----------
let askDone = null;
function finishAsk(answer) {
  const done = askDone;
  askDone = null;
  if ($('confirm').open) $('confirm').close();
  done?.(answer);
}
const dismissAsk = () => finishAsk(false);
function ask(title, text, yes) {
  dismissAsk();
  const d = $('confirm');
  d.querySelector('h2').textContent = title;
  d.querySelector('p').textContent = text;
  d.querySelector('[data-yes]').textContent = yes;
  d.showModal();
  return new Promise((resolve) => { askDone = resolve; });
}
$('confirm').querySelector('[data-yes]').onclick = () => finishAsk(true);
$('confirm').querySelector('[data-no]').onclick = () => finishAsk(false);
$('confirm').addEventListener('close', () => finishAsk(false));

// ---------- getting back ----------
async function restoreParams(list) {
  S.busy = true;
  cancelDrags();
  repaint();
  const now = performance.now();
  for (const p of list) { p.value = p.original; p.touched = now; writeParam(p, p.original); }
  repaint();
  await writesDone();
  S.busy = false;
  repaint();
  confirmLater(list);
}

$('restore').onclick = async () => {
  const model = S.model, names = model.pads.filter(core.isChanged).map((p) => p.name);
  const yes = await ask(`Restore kit ${model.kit + 1}?`, `Puts ${names.join(', ')} back to the values read when this kit was first loaded. Your changes are lost.`, 'Restore all');
  if (yes && model === S.model && S.conn === 'connected') restoreParams(core.changedParams(model));
};
$('padRestore').onclick = async () => {
  const pad = S.model.pads[S.open];
  const yes = await ask(`Restore ${pad.name}?`, `Puts ${pad.name} back to the values read when this kit was first loaded. Your changes are lost.`, 'Restore pad');
  if (yes && S.conn === 'connected' && S.model?.pads[pad.index] === pad) restoreParams(core.changedParams(pad));
};

// Compare plays the originals on the module; "mine" stays in memory until coming back.
async function toggleCompare() {
  if (S.busy || !S.model || S.conn !== 'connected') return;
  cancelDrags();
  confirmEpoch++;
  confirmSet.clear();
  S.busy = true;
  S.comparing = !S.comparing;
  repaint();
  for (const p of core.changedParams(S.model)) writeParam(p, S.comparing ? p.original : p.value);
  await writesDone();
  S.busy = false;
  repaint();
}
$('compare').onclick = toggleCompare;

// Puts my values back on the module before anything else happens to this kit.
async function leaveCompare() {
  if (!S.comparing) return;
  S.comparing = false;
  if (S.model) for (const p of core.changedParams(S.model)) writeParam(p, p.value);
  await writesDone();
}

for (const b of document.querySelectorAll('.seg button')) {
  b.onclick = () => { cancelDrags(); S.mode = b.dataset.mode; repaint(); };
}

// ---------- keeping the screen awake ----------
let wakeLock = null;
async function updateWakeLock() {
  const wanted = (S.conn === 'connected' || S.conn === 'reconnecting') && document.visibilityState === 'visible';
  if (!wanted) { const l = wakeLock; wakeLock = null; l?.release().catch(() => {}); return; }
  if (wakeLock || !navigator.wakeLock) return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch (e) { console.warn('Wake lock:', e.message); }
}
document.addEventListener('visibilitychange', updateWakeLock);

// ---------- links ----------
// A link has prepare() (needs the tap), open() -> transport, close(), and calls onLinkLost.

function bleLink() {
  let device = null, characteristic = null, listener = null;
  const forgetListener = () => { characteristic?.removeEventListener('characteristicvaluechanged', listener); };
  return {
    reloadAfterClose: true, // reconnecting from the same page load fails on Android Chrome
    async prepare() {
      if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome on Android.');
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [td.BLE_MIDI_SERVICE] }, { namePrefix: 'TD-17' }],
        optionalServices: [td.BLE_MIDI_SERVICE],
      });
      device.addEventListener('gattserverdisconnected', onLinkLost);
    },
    async open() {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(td.BLE_MIDI_SERVICE);
      const ch = await service.getCharacteristic(td.BLE_MIDI_CHARACTERISTIC);
      const parser = new td.BleMidiParser();
      forgetListener();
      characteristic = ch;
      listener = (e) => {
        const v = e.target.value;
        for (const msg of parser.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))) onMidi(msg);
      };
      ch.addEventListener('characteristicvaluechanged', listener);
      // The BLE-MIDI spec has the central read first; on an encrypted link this prompts pairing.
      try { await ch.readValue(); } catch (e) { console.warn('Initial read:', e.message); }
      for (let attempt = 1; ; attempt++) {
        try { await ch.startNotifications(); break; }
        catch (e) {
          if (attempt === 3 || !device.gatt.connected) throw e;
          await sleep(1500); // pairing may still be completing
        }
      }
      const canSkipResponse = ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse;
      // Every write goes through one queue, one whole message at a time: notes can slip in between
      // two SysEx messages (and the 20 ms gap after each) but never inside a multi-packet one.
      let writes = Promise.resolve();
      const enqueue = (packets) => {
        const job = writes.then(async () => {
          for (const packet of packets) {
            const data = Uint8Array.from(packet);
            if (canSkipResponse) await ch.writeValueWithoutResponse(data);
            else await ch.writeValue(data);
          }
        });
        writes = job.catch(() => {});
        return job;
      };
      return {
        send: (bytes) => enqueue(td.bleEncodeSysex(bytes, performance.now())),
        sendShort: (bytes) => enqueue([core.bleEncodeShort(bytes, performance.now())]),
      };
    },
    async close() {
      device?.removeEventListener('gattserverdisconnected', onLinkLost);
      // Stop notifications first so Android releases the link.
      try { await characteristic?.stopNotifications(); } catch { /* link may already be gone */ }
      forgetListener();
      device?.gatt.disconnect();
    },
  };
}

function simLink() {
  const module = createSimModule({ emit: (msg) => { if (up) onMidi(msg); }, onShort: (b) => simLogShort(b) });
  let up = false, failures = 0;
  const link = {
    reloadAfterClose: false,
    module,
    async prepare() { failures = 0; }, // pressing Connect means the module is back in reach
    async open() {
      await sleep(500);
      if (failures > 0) { failures--; throw new Error('Simulated module is out of reach'); }
      up = true;
      return {
        async send(bytes) { if (up) module.receive(bytes); },
        async sendShort(bytes) { if (up) module.receiveShort(bytes); },
      };
    },
    async close() { up = false; },
    drop(failNext = 0) { failures = failNext; up = false; onLinkLost(); },
  };
  return link;
}

const link = SIM ? simLink() : bleLink();

// ---------- connection life cycle ----------
let linkGen = 0;       // lets a newer attempt supersede one in flight
let closing = false;   // the user asked to disconnect
let retries = 0;
let linkUpAt = 0;
let everUp = false;

function setConn(state) {
  S.conn = state;
  if (state !== 'connected') {
    cancelDrags();
    closeSheet();
    dismissAsk();
    S.busy = false;
    S.loadError = false;
    S.notice = '';
  }
  updateWakeLock();
  repaint();
}

function dropTransport() {
  transport = null;
  stopRecording();
  stopPlayback();
  loadSeq++;
  confirmEpoch++;
  confirmSet.clear();
  pendingWrites.clear();
  clearTimeout(kitTimer);
  failWaiters();
}

function resetSession() {
  kits.clear();
  Object.assign(S, { kit: null, model: null, loaded: 0, comparing: false, mode: S.mode });
}

async function connect() {
  S.message = '';
  closing = false;
  retries = 0;
  everUp = false;
  setConn('connecting');
  try {
    await link.prepare();
  } catch (e) {
    if (e.name !== 'NotFoundError') S.message = e.message; // NotFoundError: the chooser was dismissed
    setConn('disconnected');
    return;
  }
  bringLinkUp();
}

async function bringLinkUp() {
  const gen = ++linkGen;
  try {
    const opened = await link.open();
    if (gen !== linkGen || closing) return;
    transport = opened;
    linkUpAt = performance.now();
    everUp = true;
    setConn('connected');
    await afterLinkUp(gen);
  } catch (e) {
    if (gen !== linkGen || closing) return;
    console.warn('Link failed:', e.message);
    onLinkLost(e);
  }
}

// Runs once a link is up: prove SysEx works, then read the current kit.
async function afterLinkUp(gen) {
  const reply = waitFor((msg) => td.parseIdentityReply(msg));
  send(td.identityRequest()).catch(() => {});
  const id = await reply;
  if (gen !== linkGen) return;
  if (!id.isTd17) { giveUp('Something answered, but it is not a TD-17.'); return; }
  deviceId = id.deviceId;
  await loadKit();
}

// The link dropped, or an attempt to bring it up failed.
async function onLinkLost(error) {
  if (closing) return;
  const gen = ++linkGen;
  dropTransport();
  if (linkUpAt && performance.now() - linkUpAt > STABLE_MS) retries = 0;
  linkUpAt = 0;
  if (retries >= MAX_RETRIES) {
    giveUp(error?.message && !everUp ? `${error.message}. Try again.` : 'The connection keeps dropping. Check the module and connect again.');
    return;
  }
  retries++;
  S.attempt = retries;
  setConn(everUp ? 'reconnecting' : 'connecting'); // last values stay visible but locked
  await sleep(700);
  if (gen === linkGen && !closing) bringLinkUp();
}

async function closeLink(message) {
  closing = true;
  linkGen++;
  dropTransport();
  await link.close().catch(() => {});
  setConn('disconnected');
  if (link.reloadAfterClose) {
    // A fresh page load is what makes the next connection work on Android Chrome.
    try { if (message) sessionStorage.setItem(MESSAGE_KEY, message); } catch { /* private mode */ }
    location.reload();
    return;
  }
  resetSession();
  S.message = message ?? '';
  repaint();
}
const giveUp = (message) => closeLink(message);
const stopLink = () => closeLink();

$('connectBtn').onclick = connect;
$('conn').onclick = async () => {
  if (S.conn !== 'connected') return;
  if (!await ask('Disconnect from the TD-17?', 'Changes you made stay stored on the module.', 'Disconnect')) return;
  await leaveCompare();
  closeLink();
};

// ---------- simulator controls (only with ?sim) ----------
const simSent = []; // every short message the app sent to the simulated module
function simLogShort(b) {
  simSent.push({ at: Math.round(performance.now()), bytes: b });
  const log = $('simLog'), type = b[0] & 0xf0;
  const what = type === 0x90 ? `on  ${b[1]} ${core.padOfNote(b[1]) ?? '?'} v${b[2]}` : type === 0x80 ? `off ${b[1]}` : `cc${b[1]}=${b[2]}`;
  log.hidden = false;
  log.dataset.lines = [...(log.dataset.lines ? log.dataset.lines.split('|') : []), `ch${(b[0] & 15) + 1} ${what}`].slice(-4).join('|');
  log.textContent = `sent ${simSent.length}\n${log.dataset.lines.split('|').join('\n')}`;
}
function buildSimPanel() {
  const panel = $('simPanel'), m = link.module;
  $('simBtn').hidden = false;
  $('simBtn').onclick = () => panel.showModal();
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.close(); });
  const knob = (padIndex) => { // the module's own knob moves this pad's mains by a few dB
    const pad = core.createKit(m.kit).pads[padIndex], addr = pad.zones[0].main.addr;
    const from = m.readValue(addr, 4), to = from > -60 ? from - 45 : from + 45;
    for (let step = 1; step <= 9; step++) {
      setTimeout(() => {
        const v = Math.round(from + (to - from) * step / 9);
        for (const z of pad.zones) m.edit(z.main.addr, td.encodeNibbles(v, 4));
      }, step * 70);
    }
  };
  const actions = {
    'Next kit (Program Change)': () => m.selectKit((m.kit + 1) % 100, 'pc'),
    'Next kit (kit number DT1)': () => m.selectKit((m.kit + 1) % 100, 'dt1'),
    'Knob turned (Tom 2)': () => knob(3),
    'Snare sub on/off': () => {
      const sub = core.createKit(m.kit).pads[1].zones[0].sub;
      m.edit(sub.switchAddr, [m.peek(sub.switchAddr, 1)[0] ? 0 : 1]);
    },
    'Drummer hits the snare': () => m.hit(38, 100),
    'Drummer plays a phrase (2 s)': () => {
      [[0, 36, 110], [250, 42, 80], [500, 38, 105], [750, 42, 75], [1000, 36, 110], [1250, 46, 85], [1500, 38, 105], [1750, 49, 120]]
        .forEach(([t, n, v]) => setTimeout(() => { if (n === 46) m.pedal(5); if (n === 42) m.pedal(120); m.hit(n, v); }, t));
    },
    'Link drops, comes back': () => link.drop(1),
    'Link drops for good': () => link.drop(99),
    'Theme: dark': () => { document.documentElement.dataset.theme = 'dark'; },
    'Theme: light': () => { document.documentElement.dataset.theme = 'light'; },
    'Theme: auto': () => { delete document.documentElement.dataset.theme; },
  };
  for (const [label, fn] of Object.entries(actions)) {
    $('simOpts').append(Object.assign(h('button', '', label), { onclick: () => { panel.close(); fn(); } }));
  }
  window.sim = { link, module: m, state: S, sent: simSent };
}

// ---------- start ----------
try {
  S.message = sessionStorage.getItem(MESSAGE_KEY) ?? '';
  sessionStorage.removeItem(MESSAGE_KEY);
} catch { /* private mode */ }
buildMixer();
if (SIM) buildSimPanel();
repaint();
