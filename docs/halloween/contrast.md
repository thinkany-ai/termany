# Halloween theme: contrast with real Claude Code and Codex output

Measured on 2026-10-19. Every number below comes from real CLI output, not
from a mock-up.

## Method

1. Claude Code v2.1.303 (its `dark` theme) and Codex v0.154.0 / v0.163.0 ran
   in tmux with `TERM=xterm-256color`, the value Termany's PTY sets.
   - Each tool ran twice: once without `COLORTERM` (how the packaged app
     starts, from Finder) and once with `COLORTERM=truecolor` (how a dev
     build started from a terminal inherits it).
2. `tmux capture-pane -e` saved each screen with its SGR colors. The screens
   are: the folder-trust dialog, a file edit with its diff, a Bash permission
   prompt ("Do you want to proceed?"), the status line, and the Codex start
   screen.
3. Each capture is replayed in `@xterm/headless`. For every drawn glyph, the
   script resolves the colors the way xterm.js paints them:
   - the theme palette for ANSI 0–15, the xterm cube for 16–255, RGB as is;
   - bold ANSI 0–7 shown as bright;
   - inverse swaps fg and bg;
   - dim is fg mixed 50% into bg.
4. It computes the WCAG 2.x contrast ratio per glyph. The same captures are
   scored under `default-dark` for comparison.

## Results

Share of glyphs below 4.5:1 (WCAG 1.4.3 AA for normal text):

| Source | Glyphs | Halloween | Default dark |
|---|---|---|---|
| Claude Code, 256 colors | 7119 | 7.3% | 8.7% |
| Claude Code, truecolor | 4190 | 9.3% | 11.0% |
| Codex, 256 colors | 311 | 0.0% | 32.2% |
| Codex, truecolor | 919 | 0.0% | 67.5% |

Every glyph that stays below 4.5:1 under Halloween uses a color that Claude
Code chooses itself from the fixed xterm 256-color cube. A terminal theme
cannot change those colors. Only the default background under them is the
theme's, and Halloween's `#110c18` is darker than `default-dark`'s, which is
why it scores a little better.

| Ratio | Claude Code color | Where |
|---|---|---|
| 2.32 | 239 on default bg | dashed rules around the command |
| 3.67 | 242 on default bg | unchanged lines in a diff |
| 2.43 | 246, dim | status line separators |
| 3.13 | 186 on 28 | added text in a diff (Claude's own green background) |
| 2.05 | 197 on 22 | syntax color inside an added line |
| 3.83 | 167 on 52 | removed-line marker |

## The theme's own palette

The terminal palette is in `apps/web/src/themes/halloween.ts`. All 16 slots
were checked against the background `#110c18`:

- Foreground `#f1e6d6`: 15.63:1. Dimmed: 4.53:1.
- Every ANSI color except black: 5.96:1 or more (`brightBlack`, the lowest).
- ANSI black `#2a2039` is 1.25:1. It is meant as a background, as in most dark
  palettes.

## Open gaps

- **Codex approval prompt not captured.** The Codex approval prompt was not
  captured. Codex v0.163 asks to trust the folder first, and answering would
  have written to the user's `~/.codex/config.toml`.
- **Other Claude Code themes not tested.** The light theme and "dark mode
  (ANSI colors only)" were not tested.
- **Text on the selection is weak.** Text on the selection `#43365a` is weak
  for red (3.90:1) and brightBlack (3.39:1). No captured screen had a
  selection.
- **Dimmed colored text fails.** Dimmed colored text (dim + ANSI color) is
  below 4.5:1 for every color. The captures used dim only on the default
  foreground (4.53:1) and on Claude Code's own 256 colors.
