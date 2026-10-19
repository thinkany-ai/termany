# Request for a pixel-art review: Termany Halloween theme

Hi! We'd like a professional pixel artist's eye on a small seasonal piece
before it ships on Oct 22. A paid review is fine. Please tell us your rate
and when you could do it.

## What it is

Termany is a terminal app for running AI coding agents. The Halloween theme
puts a jack-o'-lantern at the foot of the sidebar, with a C9 light string
above it.

- **Story.** When an agent in another pane needs you (Claude Code asking for
  permission, say), the pumpkin's eyes cut to that pane and its candle
  flares.
- **Share image.** This one moment is the image we'll share.
- **Disclosure.** The art was made with AI assistance: every pixel was
  placed by hand as a character grid, but the drafting was done by an AI
  model under a human art director. We'd rather hear the problems from you
  than from the timeline.

## Files

| File | What |
|---|---|
| `docs/halloween/palette-card.png` | The locked 24-color palette, with the role of each ramp. |
| `docs/halloween/frames-4x.png` | Six composed frames at 4x, which is the real on-screen size. |
| `docs/halloween/frame-a-preview.gif` | The 6 s loop at 4x. |
| `docs/halloween/showcase-2500.png` | The share frame, 1920×1080, inside the app. |
| `docs/halloween/showcase.mp4` | The 6 s share video. |
| `apps/web/src/themes/halloween/art/sheets/*.png` | Every sprite sheet at 1x, importable in Aseprite. |
| `apps/web/src/themes/halloween/art/PALETTE.md`, `SPRITES.md` | The rules below, in full. |

## Constraints

1. **Palette.** 24 colors, locked. No alpha and no blends. If a fix truly
   needs a new color, say which ramp it would join and why. We can unlock it.
2. **Scale.** One art pixel is 4 CSS px everywhere (6 or 8 device px).
   Nothing is ever scaled; short sidebars crop the top of the scene.
3. **Sizes.** The pumpkin is 46×35 art px, the whole scene is 60×64, and a
   bulb is 9×11.
4. **Timing.** Flame and bulb frames are at least 180 ms each, to stay under
   3 flashes per second (WCAG 2.3.1). The idle flame is exactly at that
   limit now, so a faster flicker is not an option. A different one is.
5. **Lighting.** At night the rind is lit only by a cool moon rim from the
   top left and a warm bounce from the light pool on the ground. Real
   jack-o'-lanterns read mostly as their glowing holes, and we tried to
   keep that.

## Questions

1. **Readability.** At 1x on a phone (the X timeline, ~390 px wide), does the
   pumpkin read as a pumpkin, or only as a glowing face? What would you
   change first?
2. **Rind.** Do the lobes read as round? The grooves are R0, one pixel wide,
   with R1 beside them. Would you shade them differently?
3. **Face.** Do the eye holes read as carved? The pupils are 2×3 N0 blocks.
   Do they read as eyes looking somewhere?
4. **Bulbs.** Does the C9 bulb shape and its one-ring halo read as a vintage
   string light? The green bulb is mostly a cross; is that a problem?
5. **Animation.** Do the flicker, the blink (70/110/70 ms) and the instant
   gaze cut read as natural? Is anything mechanical?
6. **Backdrop.** Is the horizon's two-row 50% checker the right call, or
   would you blend differently with only N1/N2?
7. **Biggest problem.** Anything that would make another pixel artist wince
   at the share image.

## How to send feedback

- **Paintovers.** At 1x or 4x, on top of the sheets or the frames. Aseprite
  or PNG are both fine.
- **Notes.** A short note per question. Bullet points are enough.
- **Credit.** Please tell us whether you'd like credit in the release notes,
  and under what name.
