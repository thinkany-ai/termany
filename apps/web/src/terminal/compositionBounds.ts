import type { ITerminalAddon, Terminal } from "@xterm/xterm";

interface CompositionHelper {
  readonly isComposing: boolean;
  updateCompositionElements(dontRecurse?: boolean): void;
}

/** Private xterm 5.5 hooks, isolated until our dependency includes the fix. */
interface CompositionCore {
  _compositionHelper?: CompositionHelper;
  _renderService?: { dimensions: { css: { cell: { width: number } } } };
}

/**
 * Backport xtermjs/xterm.js@783c4a34 (Termany #67): long IME preedit text
 * expands both the composition view and its hidden textarea past the right
 * edge. Chromium then scrolls the pane to reveal the caret, shifting the TUI.
 *
 * Bound the view BEFORE xterm measures it to size the textarea. An onRender
 * listener would run too late and miss composition updates/deferred updates.
 * Keep xterm's positioning and input/commit handling intact.
 * Load after terminal.open(), which creates the helper and composition view.
 */
export class CompositionBoundsAddon implements ITerminalAddon {
  private restore?: () => void;

  activate(term: Terminal): void {
    this.dispose();
    const core = (term as unknown as { _core?: CompositionCore })._core;
    const helper = core?._compositionHelper;
    const view = term.element?.querySelector<HTMLElement>(".composition-view");
    if (!helper || typeof helper.updateCompositionElements !== "function" || !view) return;

    const original = helper.updateCompositionElements;
    const previous = {
      maxWidth: view.style.maxWidth,
      overflow: view.style.overflow,
      direction: view.style.direction,
    };
    const update = (dontRecurse?: boolean) => {
      if (helper.isComposing) {
        const cellWidth = core?._renderService?.dimensions.css.cell.width;
        if (cellWidth !== undefined && Number.isFinite(cellWidth) && cellWidth > 0) {
          const cursorX = Math.min(term.buffer.active.cursorX, term.cols - 1);
          view.style.maxWidth = `${(term.cols - cursorX) * cellWidth}px`;
          view.style.overflow = "hidden";
          // Keep the newest part of a long preedit visible, as upstream does.
          view.style.direction = "rtl";
        }
      }
      original.call(helper, dontRecurse);
    };
    helper.updateCompositionElements = update;
    this.restore = () => {
      if (helper.updateCompositionElements === update) {
        helper.updateCompositionElements = original;
        Object.assign(view.style, previous);
      }
    };
  }

  dispose(): void {
    this.restore?.();
    this.restore = undefined;
  }
}
