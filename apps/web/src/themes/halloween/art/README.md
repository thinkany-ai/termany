# Halloween art

The key words MUST, MUST NOT, SHOULD and MAY in this document are to be
interpreted as described in RFC 2119.

![palette card](../../../../../../docs/halloween/palette-card.png)

## Palette

`palette.gpl` is the single source of truth: 24 sRGB colors in six ramps,
step 0 darkest. Aseprite and GIMP load it directly.

| Ramp | Colors | Role |
|---|---|---|
| N (night) | `#08060d` `#110c18` `#1b1426` `#2a2039` `#43365a` `#6f6390` | Void and outlines (N0). Scene and sidebar background (N1). Sky band (N2). Hills, unlit purple bulb (N3). Moon rim (N4). Stars (N5). |
| R (rind) | `#1c0a0b` `#33110e` `#521a10` `#7a2a12` | Rind lit only by bounce light. R1 is also the orange halo; R3 is also the deepest cut wall. |
| G (candle) | `#c0360c` `#ea5a0f` `#ff8a1f` `#ffb33d` `#ffdf7a` `#fff7d6` | Cut wall to flame core. G1 is the lit orange bulb; G5 is every bulb's filament. |
| S (stem) | `#1a1a0e` `#353118` `#5a5226` | Stem. S1 is also the light-string wire. |
| P (purple bulb) | `#8a3ad0` `#c98cff` | Lit body, lit core. |
| E (green bulb) | `#0f2a22` `#4fd09a` `#c4ffd8` | Unlit and halo, lit body, lit core. |

Where the colors come from:
- **The G ramp.** It follows candlelit jack-o'-lantern photos. The hue of the
  lit areas rises with brightness, from about 5° through 20° to 40–60°.
- **The N ramp.** It sits at the complementary hue (300° OKLCH).
- **The bulbs.** Orange, purple and green follow C7/C9 Halloween strings.
- **The green bulb.** Its green is shifted toward teal. Under simulated
  deuteranopia, plain green was 0.058 OKLab from orange; teal is 0.150.

## Rules

- **PAL-1** Every opaque sprite pixel MUST be one of the 24 palette colors.
  `npm test` checks every committed sheet against its source.
- **PAL-2** A sprite pixel MUST be fully opaque or fully transparent.
- **PAL-5** R0 MUST NOT sit on the pumpkin's outer edge: it is only 0.006 in
  lightness from N1, so the silhouette would vanish.
- **PAL-6** Any surface behind a sprite MUST be exactly N1 (bulb halos are
  drawn for it).
- **PAL-7** Bulb color MUST NOT be the only signal of a state.
- **PX-1** One art pixel MUST render as exactly 4 CSS px (4, 6 or 8 device
  px on a Mac).
- **PX-2** IF the scene does not fit, THEN it MUST be cropped, never scaled.
- **SPR-1** Every flame and bulb step MUST last at least 180 ms. That keeps
  each layer under 3 flashes per second (WCAG 2.3.1).
- **SPR-2** Blinks MUST be at least 1 s apart.
- **SPR-3** WHILE a blink plays, the flame frame MUST hold.
- **SPR-4** A gaze change MUST cut straight to the next pupil frame, as a
  real saccade does.
- **SPR-5** WHEN an agent in an unfocused pane goes from working to done or
  error, the pupils MUST face that pane and the flame MUST switch to `alert`.
  The alert ends when the user focuses the pane or the agent works again.
- **SPR-6** WHERE reduced motion is on, every layer MUST hold still. An alert
  shows as the held flare.
- **SPR-7** At most one bulb MUST be dark at a time.
- **SPR-8** WHILE the window is unfocused, or idle for 30 s, the scene MUST
  rest the same way. Each frame change costs about 0.6% of a core per change
  per second in the packaged app.

## Sprites

Each frame is a character grid in `src/*.sprite`, one character per art
pixel. `node scripts/halloween-sprites.mjs` builds `sheets/<name>.png` and
`sheets/<name>.json`. It only maps characters to colors; nothing is
computed. The right-leaning flame is the left one flipped. Every other frame
is drawn by hand.

The scene is 60×64 art px: a 16-row light string over 48 rows of night.

| Layer | Size | Frames | Sequences |
|---|---|---|---|
| backdrop | 60×48 | night | — |
| pumpkin-flame | 32×28 | mid, left, right, dim, flare | `idle` (3.2 s loop), `alert`, `still` |
| pumpkin-pupils | 32×7 | c, l, r, ur, dr | `wander` (8.4 s), `still` |
| pumpkin-lids | 32×7 | open, half, shut | `blink` (70/110/70 ms), `blinks` (every 2.9–6.1 s), `open` |
| pumpkin-body | 46×39 | body | — (holes are transparent) |
| wire | 24×5 | segment | — (tiles) |
| bulb | 9×11 | lit, warm, off per color | `a/b/c` (one shared 12 s cycle), `show` (6 s, share loop), `steady` |

`player.ts` picks frames from these sequences, and `player.test.ts` checks
SPR-1, 2, 3, 6 and 7.
