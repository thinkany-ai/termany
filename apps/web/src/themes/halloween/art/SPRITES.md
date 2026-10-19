# Halloween sprites

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY in this document are
to be interpreted as described in RFC 2119.

![frames at 4x, the on-screen size](../../../../../../docs/halloween/frames-4x.png)

## How the art is made

- Every frame is a character grid in `src/*.sprite`. One character is one art
  pixel. The legend in `scripts/halloween-sprites.mjs` maps each character to
  one color of `palette.gpl`. `.` is transparent.
- `node scripts/halloween-sprites.mjs` turns each source into
  `sheets/<name>.png` (frames in one row, 1 px per art pixel) and
  `sheets/<name>.json` (size, origin, frame offsets, tags). It only maps
  characters to colors. It computes no shading and no in-between frames.
- `--check` validates the sources and writes nothing.
- The sheets are plain RGBA PNGs. Aseprite opens them with
  File > Import Sprite Sheet, so a pixel artist can edit them there. Aseprite
  is not installed on the build machine, so no `.aseprite` file is kept.
- The right-leaning flame frame is the left-leaning frame flipped. All other
  frames are drawn one by one.

## Scene

The scene is the foot of the sidebar: 60 × 48 art pixels, which is 240 × 192
CSS px at 4 CSS px per art pixel (PX-1). The sidebar is 240 CSS px wide.
Layers, bottom to top:

| Layer | Size | Origin in scene | Frames |
|---|---|---|---|
| `backdrop` | 60 × 48 | 0, 0 | `night` |
| `pumpkin-flame` | 32 × 28 | 14, 18 | `mid`, `left`, `right`, `dim`, `flare` |
| `pumpkin-pupils` | 32 × 7 | 14, 18 | `c`, `l`, `r`, `ur`, `dr` |
| `pumpkin-lids` | 32 × 7 | 14, 18 | `open`, `half`, `shut` |
| `pumpkin-body` | 46 × 39 | 7, 7 | `body` |

The body has transparent holes. The flame, pupil and lid layers show only
through those holes, so the code stacks the layers and never masks them.

The light string is separate. It sits over the top of the pane area:

| Layer | Size | Origin | Frames |
|---|---|---|---|
| `wire` | 24 × 5 | tiles every 24 px | `segment` |
| `bulb` | 9 × 11 | 7, 5 inside each segment | `<color>-lit`, `-warm`, `-off` for orange, purple, green |

## Sequences

| Sprite | Tag | Steps (ms) | Use |
|---|---|---|---|
| flame | `idle` | 10 steps, 200–520 each, 3.2 s loop | normal |
| flame | `alert` | `flare` held | an agent waits for the user |
| flame | `still` | `mid` held | reduced motion |
| lids | `blink` | half 70, shut 110, half 70 | one blink, after an alert ends |
| lids | `blinks` | open 2.9–6.1 s between blinks | idle rhythm |
| lids | `open` | `open` held | default |
| pupils | `wander` | c, l, c, ur, c, r over 8.4 s | idle gaze |
| pupils | `still` | `c` held | reduced motion |
| bulb | `<color>-a/b/c` | one shared 12 s cycle; dark at 0.8–2.2, 4.8–5.7, 8.4–10.2 s | normal twinkle |
| bulb | `<color>-show` | lit 4.0, warm 0.2, off 1.6, warm 0.2 = 6.0 s | share video loop |
| bulb | `<color>-steady` | lit held | reduced motion |

## Rules

- **SPR-1** Every flame and bulb step MUST last at least 180 ms. Then one
  layer makes at most 2.75 light-dark pairs per second. WCAG 2.3.1 allows 3.
- **SPR-2** The player MUST leave at least 1 s between two blinks.
- **SPR-3** WHILE a blink plays, the player MUST hold the current flame frame.
  This keeps the face region at one light-dark pair for that moment.
- **SPR-4** A gaze change MUST cut straight to the next pupil frame. A real
  saccade takes 30–50 ms, so in-between frames would look slower than an eye.
- **SPR-5** WHEN an agent in a pane the user is not focused on stops working
  (its dot goes from working to done or error), the player MUST switch the
  pupils to the frame that faces that pane and the flame to `alert`.
- **SPR-5a** WHEN the user focuses that pane or its agent starts working
  again, the alert MUST end. A pane that was already done when the scene
  appeared MUST NOT raise an alert.
- **SPR-6** WHERE reduced motion is on, the player MUST use `still`, `open`,
  `still` and `<color>-steady`. The alert state MUST then show as the `flare`
  frame held, with no other motion.
- **SPR-8** WHILE the window is not focused, or nobody has typed, clicked or
  moved the pointer in it for 30 s, the player MUST hold the still pose
  (as with reduced motion). An alert MUST still show, as the held flare and
  the turned eyes. Reason: each frame change costs about 0.6% of a core per
  change per second in the packaged app (docs/halloween/cpu.md).
- **SPR-7** At most one bulb MUST be dark at any time. In the share loop the
  three `show` tags start 2 s apart and the loop closes at 6 s; live, the
  a/b/c tags share one 12 s cycle.

## Player

`apps/web/src/themes/halloween/player.ts` picks frames; `scene.tsx` draws
them. `player.test.ts` checks SPR-1, 2, 3, 6 and 7.

## Not done yet

- A measured WCAG flash analysis and a PEAT run on a recording (step 4).
  The 180 ms floor above is a design limit, not a measurement.
- A check that the art survives X's H.264 encoding.
