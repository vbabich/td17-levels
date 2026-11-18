// A fake TD-17 for development (mixer.html?sim). It speaks the same SysEx as the module.
import * as td from './td17.js?v=19';

const NAMES = { 11: 'Studio Rock', 12: 'Dry Funk', 13: 'Jazz Brushes', 14: 'Big Arena' };
const INF = td.VOLUME_MIN;

// [main, pan, sub (only when the sub is on)] per unit, in td.UNITS order.
const KIT_12 = [
  [-20, 0, -30], [0, 0], [-40, 0], [-15, -8], [-15, -8], [-15, 2], [-15, 2], [-10, 12], [-10, 12],
  [-30, -14], [-30, -14], [-45, -18], [-45, -18], [-45, 16], [-45, 16], [-60, 20, -20], [-60, 20], [-60, 12],
  [INF, 0], [INF, 0],
];

export function createSimModule({ emit, latency = 15 }) {
  const memory = new Map();
  const key = (a, i) => ((a[0] << 21) | (a[1] << 14) | (a[2] << 7) | a[3]) + i;
  const poke = (addr, bytes) => bytes.forEach((b, i) => memory.set(key(addr, i), b));
  const peek = (addr, size) => Array.from({ length: size }, (_, i) => memory.get(key(addr, i)) ?? 0);
  const reply = (msg) => setTimeout(() => emit(msg), latency);
  const pokeValue = (addr, value, size) => poke(addr, td.encodeNibbles(value, size));

  for (let kit = 0; kit < 100; kit++) {
    const shift = kit === 11 ? 0 : ((kit * 37) % 17 - 10) * 5;
    KIT_12.forEach(([main, pan, sub], unit) => {
      const level = main <= INF ? (kit === 11 ? INF : -100) : Math.max(-300, Math.min(40, main + shift));
      pokeValue(td.address.volume(kit, unit, 'main'), level, 4);
      pokeValue(td.address.volume(kit, unit, 'sub'), kit === 11 && sub != null ? sub : level, 4);
      poke(td.address.subSwitch(kit, unit), [kit === 11 && sub != null ? 1 : 0]);
      pokeValue(td.address.pan(kit, unit), pan, 2);
    });
    pokeValue(td.address.xstickVolume(kit), Math.max(-300, -20 + shift), 4);
    pokeValue(td.address.pedalHhVolume(kit), kit === 11 ? -95 : Math.max(-300, -30 + shift), 4);
    const name = (NAMES[kit] ?? `User Kit ${kit + 1}`).padEnd(12).slice(0, 12);
    poke([...td.address.kitVolume(kit).slice(0, 2), 0, 0], [...name].map((c) => c.charCodeAt(0)));
  }
  poke(td.address.currentKit(), [11]);

  // A value edited on the module's own panel: stored, then announced.
  function edit(addr, data) {
    poke(addr, data);
    reply(td.dt1(0x10, addr, data));
  }

  return {
    peek,
    edit,
    get kit() { return peek(td.address.currentKit(), 1)[0]; },
    readValue: (addr, size) => td.decodeNibbles(peek(addr, size)),
    // Handles one complete message sent by the app.
    receive(bytes) {
      if (bytes[1] === 0x7e) return reply([0xf0, 0x7e, 0x10, 0x06, 0x02, 0x41, 0x4b, 0x03, 0, 0, 0, 0, 0, 2, 0xf7]);
      const addr = bytes.slice(8, 12);
      if (bytes[7] === 0x11) return reply(td.dt1(0x10, addr, peek(addr, bytes[15])));
      const d = td.parseDt1(bytes);
      if (d?.checksumOk) poke(addr, d.data);
    },
    // Kit selected on the module, announced as a Program Change or as the kit-number DT1.
    selectKit(kit, how = 'pc') {
      poke(td.address.currentKit(), [kit]);
      reply(how === 'pc' ? [0xc9, kit] : td.dt1(0x10, td.address.currentKit(), [kit]));
    },
  };
}
