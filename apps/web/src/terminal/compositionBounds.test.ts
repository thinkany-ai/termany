import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { CompositionBoundsAddon } from "./compositionBounds";

interface ViewStyle {
  maxWidth: string;
  overflow: string;
  direction: string;
}

interface FakeHelper {
  isComposing: boolean;
  updateCompositionElements(dontRecurse?: boolean): void;
}

interface FakeTerminal {
  cols: number;
  buffer: { active: { cursorX: number } };
  element?: { querySelector(selector: string): unknown };
  _core?: {
    _compositionHelper?: FakeHelper;
    _renderService?: { dimensions: { css: { cell: { width: number } } } };
  };
}

function harness(initialStyle: Partial<ViewStyle> = {}) {
  const view = {
    style: { maxWidth: "", overflow: "", direction: "", ...initialStyle },
  };
  const textarea = { width: 0 };
  const calls: { receiver: unknown; dontRecurse: boolean | undefined; style: ViewStyle }[] = [];
  const deferred: (() => void)[] = [];
  const helper: FakeHelper = {
    isComposing: true,
    updateCompositionElements(dontRecurse?: boolean) {
      calls.push({ receiver: this, dontRecurse, style: { ...view.style } });
      if (!this.isComposing) return;
      // Model the consequential part of xterm: measure the view now, copy its
      // width to the textarea, then schedule another update via the helper.
      const limit = Number.parseFloat(view.style.maxWidth);
      textarea.width = Math.min(600, Number.isFinite(limit) ? limit : Infinity);
      if (!dontRecurse) deferred.push(() => this.updateCompositionElements(true));
    },
  };
  const original = helper.updateCompositionElements;
  const metrics = { dimensions: { css: { cell: { width: 10 } } } };
  const term: FakeTerminal = {
    cols: 10,
    buffer: { active: { cursorX: 8 } },
    element: {
      querySelector(selector) {
        assert.equal(selector, ".composition-view");
        return view;
      },
    },
    _core: { _compositionHelper: helper, _renderService: metrics },
  };
  const addon = new CompositionBoundsAddon();
  const activate = () => addon.activate(term as unknown as Terminal);
  return { view, textarea, calls, deferred, helper, original, metrics, term, addon, activate };
}

test("bounds the view before xterm measures it for the hidden textarea", () => {
  const h = harness();
  h.activate();

  h.helper.updateCompositionElements();

  assert.equal(h.textarea.width, 20, "the original measurement must already see the bound");
  assert.deepEqual(h.calls[0].style, { maxWidth: "20px", overflow: "hidden", direction: "rtl" });
  assert.equal(h.calls[0].receiver, h.helper);
  assert.equal(h.calls[0].dontRecurse, undefined);
  assert.equal(h.deferred.length, 1);

  h.term.buffer.active.cursorX = 7;
  h.deferred.shift()!();

  assert.equal(h.textarea.width, 30, "xterm's deferred update must also pass through the bound");
  assert.equal(h.calls[1].receiver, h.helper);
  assert.equal(h.calls[1].dontRecurse, true);
  assert.equal(h.deferred.length, 0, "the recursion guard is forwarded intact");
});

test("pending wrap retains the final cell, including fractional cell widths", () => {
  const h = harness();
  h.term.buffer.active.cursorX = h.term.cols;
  h.metrics.dimensions.css.cell.width = 7.25;
  h.activate();

  h.helper.updateCompositionElements(true);

  assert.equal(h.textarea.width, 7.25, "pending wrap must not collapse the IME target to zero width");
  assert.equal(h.calls[0].dontRecurse, true);
  assert.equal(h.deferred.length, 0);
});

test("uses current terminal geometry after resize, cursor movement and font changes", () => {
  const h = harness();
  h.activate();
  h.helper.updateCompositionElements(true);
  assert.equal(h.textarea.width, 20);

  h.term.cols = 14;
  h.term.buffer.active.cursorX = 10;
  h.metrics.dimensions.css.cell.width = 8.5;
  h.helper.updateCompositionElements(true);

  assert.equal(h.textarea.width, 34, "geometry must not be captured at addon activation");
});

test("leaves inactive compositions alone while still delegating to xterm", () => {
  const initial = { maxWidth: "77px", overflow: "clip", direction: "ltr" };
  const h = harness(initial);
  h.helper.isComposing = false;
  h.activate();

  h.helper.updateCompositionElements(false);

  assert.deepEqual(h.view.style, initial);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].dontRecurse, false);
  assert.equal(h.textarea.width, 0);
});

test("dispose restores the original method and inline styles and is idempotent", () => {
  const initial = { maxWidth: "77px", overflow: "clip", direction: "ltr" };
  const h = harness(initial);
  h.activate();
  h.helper.updateCompositionElements(true);

  h.addon.dispose();
  h.addon.dispose();

  assert.equal(h.helper.updateCompositionElements, h.original);
  assert.deepEqual(h.view.style, initial);
  h.helper.updateCompositionElements(true);
  assert.equal(h.textarea.width, 77);
});

test("dispose does not overwrite a wrapper installed by another owner", () => {
  const h = harness();
  h.activate();
  h.helper.updateCompositionElements(true);
  const bounded = h.helper.updateCompositionElements;
  const later = (dontRecurse?: boolean) => bounded(dontRecurse);
  h.helper.updateCompositionElements = later;
  h.view.style.direction = "ltr";
  const laterStyle = { ...h.view.style };

  h.addon.dispose();

  assert.equal(h.helper.updateCompositionElements, later);
  assert.deepEqual(h.view.style, laterStyle);
});

test("repeated activation restores the first installation instead of stacking wrappers", () => {
  const initial = { maxWidth: "77px", overflow: "clip", direction: "ltr" };
  const h = harness(initial);
  h.activate();
  h.helper.updateCompositionElements(true);
  h.activate();
  h.helper.updateCompositionElements(true);

  assert.equal(h.calls.length, 2, "each update reaches the original exactly once");
  h.addon.dispose();
  assert.equal(h.helper.updateCompositionElements, h.original);
  assert.deepEqual(h.view.style, initial, "reactivation must not save the patched style as the original");
});

test("missing private hooks or a missing composition view leave terminal setup usable", () => {
  for (const shape of [
    {},
    { _core: {} },
    { _core: { _compositionHelper: {} }, element: { querySelector: () => ({}) } },
    { _core: { _compositionHelper: { updateCompositionElements() {} } } },
    {
      _core: { _compositionHelper: { updateCompositionElements() {} } },
      element: { querySelector: () => null },
    },
  ]) {
    const addon = new CompositionBoundsAddon();
    assert.doesNotThrow(() => addon.activate(shape as unknown as Terminal));
    assert.doesNotThrow(() => addon.dispose());
  }
});

test("unavailable or invalid renderer metrics still allow the original update", () => {
  for (const width of [undefined, 0, -1, NaN, Infinity]) {
    const h = harness();
    if (width === undefined) {
      h.term._core!._renderService = undefined;
    } else {
      h.metrics.dimensions.css.cell.width = width;
    }
    h.activate();

    assert.doesNotThrow(() => h.helper.updateCompositionElements(true));

    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.view.style, { maxWidth: "", overflow: "", direction: "" });
    assert.equal(h.textarea.width, 600);
  }
});
