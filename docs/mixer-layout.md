# TD-17 mixer: layout proposal

Status: all eight layout decisions answered on 2026-11-17 (see the end). The working app is not built yet.

Mockup: [`mixer-mockup.html`](../mixer-mockup.html), live at https://vbabich.github.io/td17-levels/mixer-mockup.html

The mockup is a static page with fake data. It does not use Bluetooth and does not touch the tester or `td17.js`. The dashed purple **Mockup** button (top right) is not part of the app: it switches layout, connection state and theme, and pretends the module changed kit or had a knob turned.

It was checked in a desktop browser at 375x812, 812x375, 412x915, 768x1024 and 1024x768, dark and light. It has not been tried on a real phone yet, so how the drag feels under a finger is the first thing to judge.

## Chosen layout: rows

Ten horizontal faders, one pad per row: name on the left, fader in the middle, value on the right.

- **Portrait:** one column of ten rows, a slim bar on top (connection, kit) and the controls at the bottom (Level/Pan, Compare, Restore), next to the thumb.
- **Landscape:** two columns of five rows (Kick to Tom 3, Hi-Hat to Aux), and the controls move into the top bar so no height is lost.
- **Tablet:** the same arrangement with larger type; rows stop growing at 120 px.

Why rows rather than mixer-style vertical strips:

- The fader runs along the long side of each cell in both orientations. Rows are about 58 px tall on a 375 px phone with the browser bars showing, so every row is a full-height touch target.
- Name, fader and value read as one line, like the module's own screen.
- Pan makes sense on a horizontal fader (left is left). On a vertical strip it does not.
- A horizontal drag cannot be confused with a vertical scroll, so the same fader works inside the scrolling pad view.
- The name and value columns keep the fader away from the screen edges, where Android's back gesture lives.

The Strips layout is in the mockup too (Mockup → Layout → Strips): 5 x 2 in portrait, 10 x 1 in landscape. It looks more like a mixer and compares levels across pads at a glance, but its faders are shorter on a phone and Pan is awkward.

## How each requirement is met

| Requirement | In the mockup |
| --- | --- |
| Ten pads, one fader each | One screen, no scrolling at any tested size. |
| Level | Light blue fader, value in large digits. The scale is not linear: -12 to +6 dB takes half the travel, with a tick at 0 dB. Far left is -INF. |
| Pan | The **Level / Pan** switch turns all ten faders into pan faders: light green, filled outward from a centre tick, values like L8, C, R12. Pan is also in each pad's own view. |
| Individual values | Tap a pad's name. A full-screen view opens with the pad Level and Pan (with − and + for 0.5 dB or one pan step) and, below, every stored value by zone: Main, Sub (marked "off" when off), Pan, then Pedal HH or XStick. **Done** or the phone's Back button closes it. In landscape the two halves sit side by side. |
| Discrepancy | An orange bar drawn over the blue track from the lowest to the highest disagreeing value, with a small orange triangle above each end pointing down at it. The triangles sit clear of the thumb, so a narrow spread hidden under the thumb is still visible. Same rules as the tester. Inside the pad view an orange note says what disagrees in words, for example "Pedal HH is 6.5 dB below the pad level". Fake kit 12 has it on Snare, Hi-Hat and Ride (Level) and Ride (Pan). |
| Kit and kit change | Kit number and name in the top bar. On a kit change the name becomes "Loading 3/10…", a progress line runs under the bar, and each row is greyed out until its pad has been read. |
| Connection | Disconnected: a single large Connect button with the module instructions. Connecting: the button says so. Connected: green dot (tap it to disconnect). Reconnecting: the last known values stay visible but dimmed and locked, under an orange banner with the attempt count and a Stop button. |
| Edits from the module | The fader moves and the row is highlighted for a moment. |
| Getting back | The values first read from each kit are kept. A dashed ghost marks where a changed fader was. **Compare** shows the original values (faders locked, banner with "Back to my mix"); **Restore** puts the whole kit back after a confirmation that names the changed pads; **Restore pad** does it for one pad. |
| Reading the value under a thumb | While a fader is held, a large readout (pad name and value) appears at the top of the screen. The row's own value is also off to the right of the fader, not under it. |
| Accidental touches | A fader does not jump to where it is touched. Nothing changes until the finger has moved 8 px along the fader; from there the value follows the finger from where it was. Taps and brushes do nothing, and the finger does not have to land on the thumb: anywhere on the row works. Pull-to-refresh is switched off. |
| Dim light, both themes | Dark by default following the phone setting, with the tester's colours; light theme works. |

## Considered and rejected

- **Jump-to-touch faders** (the fader goes where you tap): one stray stick or sleeve changes the stored kit. Rejected.
- **A pan control on every row:** halves the room for the level fader for something adjusted rarely. Replaced by the Level/Pan switch.
- **Details expanding inside the row:** the other pads move around and up to eleven values do not fit. A full-screen pad view is calmer.
- **Orange bar below the track, a ring on the thumb, a flag on the pad name** (the first mockup): replaced at your request by the bar over the track plus triangle markers.
- **Two-line rows** (name and value above a full-width fader): about 60% more fader travel in portrait, but the name becomes a small tap target and the fader reaches into the back-gesture edge. Worth revisiting only if the faders feel too coarse on the phone.
- **Kit master volume as an eleventh fader:** left out to keep exactly ten equal rows. See decision 6.

## Decisions (answered 2026-11-17)

1. **Layout:** Rows. Strips stays in the mockup only for reference and will not be built.
2. **Grab:** anywhere on the row. Nothing changes until a drag of 8 px along the fader; then the value follows the finger from where it was.
3. **Fader scale:** stretched (-12 to +6 dB takes half the travel, tick at 0 dB).
4. **Pan:** the Level/Pan switch for the whole screen, and also in each pad's view.
5. **Getting back:** Compare plus Restore (plus Restore pad). The original values are what was read when you connected and are not kept after the page is closed.
6. **Kit volume:** left on the module; the app shows ten pad rows only.
7. **Discrepancy signs:** orange bar over the blue track, with triangle markers above each end pointing at it. No ring on the thumb, no flag on the name.
8. **Install as an app:** yes. Installable to the home screen (manifest and icon), full screen, keeps the screen awake.

Smaller things chosen without asking, still easy to change: cymbal zones are labelled Bow/Edge/Bell (the tester says Head/Rim); the − and + step is 0.5 dB; an edit made on the module counts as a change for Compare and Restore; opening a pad is by its name only, not by tapping the value.
