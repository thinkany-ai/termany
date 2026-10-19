# Halloween theme: flash analysis (WCAG 2.3.1)

Run on 2026-10-19. `node --import tsx scripts/halloween-flash.mjs` runs in CI
(`.github/workflows/halloween-theme.yml`).

## Result

| Input | Max general flashes in any 1 s, at any pixel | Max red flashes | Area over 3/s | Verdict |
|---|---|---|---|---|
| Self-test: 5 Hz full-scene strobe | 5 | 0 | 3840 of 1364 allowed | fails, as it must |
| Self-test: 5 Hz strobe on 10 pixels | 5 | 0 | 10 of 1364 | passes, as it must |
| Live scene, idle, 120 s | 3 | 0 | 0 | pass |
| Live scene, alerts on/off, 120 s | 3 | 0 | 0 | pass |
| Live scene, alert toggled every 1.2 s, 60 s | 3 | 0 | 0 | pass |
| Live scene, reduced motion, 60 s | 0 | 0 | 0 | pass |
| Share loop x3, 18 s | 2 | 0 | 0 | pass |
| `showcase.mp4` (the share video, 6 s) | 2 | 1 | 0 | pass |

Areas for the sprite timelines are in art pixels (one art pixel = 16 CSS
px²); 1364 art px is 25% of a 341 x 256 field. For the video the limit is
the same share of the frame.

**Margin.** The idle flame reaches exactly 3 general flashes in one second at
some pixels. That is the limit, so it passes, but with no margin: making any
idle flame step shorter than it is now will fail CI. The area rule passes by
a wide margin, since the whole scene is 3840 art px and nothing near 1364 of
them flicker together.

The single red flash in the video is not in the sprites (no palette color is
a saturated red, R/(R+G+B) < 0.8 for all 24). I infer it comes from H.264
chroma noise around the red status dot; I did not trace it frame by frame.

## Method

`scripts/halloween-flash.mjs` implements the WCAG 2.2 definitions:

- **Transitions.** Each pixel's luminance series is reduced to alternating
  extremes. A transition is a step between two extremes of at least 0.1 in
  relative luminance, with the darker end below 0.8. A red transition
  involves a saturated red and changes max(0, (R−G−B)×320) by more than 20.
- **Flashes.** A flash is a pair of transitions. Each 1 s window (stepping
  by 50 ms) counts, per pixel, floor(transitions / 2).
- **Sprite timelines.** These are composed from the committed sheets with
  the real player, so they include the interplay of flame, blink, gaze and
  bulbs. The video is area-averaged 6x down, so one sample is one art pixel.

## PEAT (not run)

PEAT (Trace Center, University of Maryland) is a Windows program. This Mac
has no Windows machine or VM, so it was not run. The numbers above come
from my own analyzer, not from PEAT. To run PEAT:

1. On Windows, install PEAT from https://trace.umd.edu/peat/. It is free.
2. Convert the video to an uncompressed AVI. I believe PEAT reads AVI
   most reliably; this is not verified:
   `ffmpeg -i docs/halloween/showcase.mp4 -c:v rawvideo -pix_fmt bgr24 showcase.avi`
3. In PEAT, set the display to the size and distance you expect viewers to
   use (for X on a laptop, 13–16 inch at 1920 px wide), open
   `showcase.avi` and run the analysis.
4. Save PEAT's report and chart next to this file as `peat-report.*` and
   add its verdict to the table above.
