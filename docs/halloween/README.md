# Halloween theme: evidence and launch notes

Measured on 2026-10-19 unless noted. The art and its rules are in
`apps/web/src/themes/halloween/art/README.md`.

## Share frame

`?theme=halloween&showcase=<ms>` in the demo build freezes a fixed 6 s loop
(`player.ts`, `showcasePose`). The agent panes show real Claude Code
v2.1.303 and Codex v0.163.0 screens, with local paths removed.

```
(cd apps/web && VITE_DEMO=1 npx vite --port 15173)
node --import tsx scripts/halloween-showcase.mjs            # showcase-2500.png, 1920x1080
node --import tsx scripts/halloween-showcase.mjs --at 500   # another moment
node --import tsx scripts/halloween-showcase.mjs --video    # showcase.mp4, 6 s
```

Three exports of the same moment were byte-identical.

## Checks

- **`npm test`** (apps/web) checks two things: every committed sprite sheet
  matches its hand-placed source (so only palette colors and no partial
  alpha), and the player rules SPR-1, 2, 3, 6 and 7.
- **`npx playwright test`** (apps/web, run by hand) compares snapshots of the
  scene at dpr 1 and 2. It covers the share pose, a 480 px window and a
  60-page sidebar.

## Contrast with real Claude Code and Codex output

- **Method.** Real screens were captured with `tmux capture-pane -e`, under
  `TERM=xterm-256color`, both with and without `COLORTERM`. They were
  replayed in `@xterm/headless`, and every glyph was scored against WCAG
  4.5:1.
- **Codex.** 0% of glyphs fall below 4.5:1 under Halloween (default dark:
  32–68%).
- **Claude Code.** 7.3% (256 colors) and 9.3% (truecolor) fall below 4.5:1
  under Halloween (default dark: 8.7% and 11.0%). Every one of these glyphs
  uses a color that Claude Code fixes itself from the 256-color cube
  (dashed rules, diff backgrounds, status separators). No terminal theme can
  change those colors.
- **Theme palette.** The foreground is 15.6:1 and every ANSI color except
  black is at least 5.96:1.
- **Gaps.**
  - Text on the selection is weak for red (3.90:1) and brightBlack (3.39:1).
  - Dimmed colored text falls below 4.5:1.
  - The Codex approval prompt was not captured.

## Flashing (WCAG 2.3.1)

- **Design limit.** By design (SPR-1), no layer changes faster than every
  180 ms.
- **One-off analysis.** A throwaway script ran the WCAG definitions over
  every sequence the player can show and over `showcase.mp4`. The script is
  not kept in the repo.
  - All inputs passed.
  - The idle flame reaches exactly 3 flashes in one second at some pixels:
    the limit, with no margin.
  - There were no red flashes in the sprites.
- **PEAT.** Not run: it is a Windows program and none was available. To run
  it, convert the video with
  `ffmpeg -i showcase.mp4 -c:v rawvideo -pix_fmt bgr24 showcase.avi` and
  open it in PEAT (trace.umd.edu/peat).

## Idle CPU in the packaged macOS app

**Budget, set before measuring:** at most 0.5 percentage points of one core
above the default theme when idle. With reduced motion, at most 0.2.

| Variant | Window | CPU, % of one core |
|---|---|---|
| Default theme | partly visible | 0.17 |
| Halloween, animating (60×64 canvas) | partly visible | 3.23 |
| Halloween, resting | fully covered | 0.02 (0 ticks in 60 s) |

- **Animating.** Animation costs about 3% of a core, over budget. That is why
  the scene rests (SPR-8).
- **Not measured yet.**
  - Visible *and* resting. Run `bash scripts/halloween-cpu.sh` with the test
    window in front.
  - Reduced motion, which needs a system setting.
- **Isolation.** Each variant ran in isolation: its own bundle id, its own
  `HOME`, and its server on port 5184.

## Launch (proposal, not built)

| Date | Plan |
|---|---|
| Oct 22 | Release. |
| Oct 23 | Post the video on X, linking `termany.sh/demo?theme=halloween&utm_source=x`. |
| Oct 24–31 | A one-time sidebar card: "Try it" applies the theme and remembers the previous one; "Not now" hides it for the season. It never switches the theme by itself. |
| Nov 1–7 | One card for anyone still on Halloween: keep it, or go back to the remembered theme. |
| From Nov 8 | The theme stays in the bundle under "Seasonal". It is never removed and never switched away from. |

## What to watch after launch

Baselines (step 1 research):
- **Launch post on X.** Termany's July 21 launch post got 119 likes and 73
  replies.
- **Comparable posts.** An agent-aware pixel UI video got 2.7k–10.6k likes;
  terminal theme screenshots got 26–144.
- **GitHub stars.** The earlier theme releases brought +2 to +9 stars per
  day.

Metrics:
1. **The post.** Likes, reposts, replies and views at 24 h, 72 h and 7 d,
   against the launch post. If it does not beat 119 likes by 72 h, the frame
   did not work.
2. **Demo link.** Visits to the tagged link, if termany.sh has analytics
   (not checked).
3. **GitHub.** Stars per day and release downloads for the week after,
   against the earlier theme releases.
4. **Adoption and retention.** The share of installs on the theme (Oct 31)
   and still on it (Nov 8). This needs opt-in telemetry, which Termany does
   not have; that is a decision for the maintainers. Until then, report it
   as not measurable.
5. **Complaints.** Issues or replies about flicker, CPU or readability.
