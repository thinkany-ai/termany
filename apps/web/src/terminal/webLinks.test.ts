import assert from "node:assert/strict";
import test from "node:test";
import type { IBufferCell, ILinkProvider, Terminal } from "@xterm/xterm";
import { registerWebLinks } from "./webLinks";

class MockCell {
  chars = " ";
  width = 1;
  getChars() {
    return this.chars;
  }
  getWidth() {
    return this.width;
  }
}

class MockLine {
  readonly isWrapped: boolean;
  readonly length: number;
  private readonly text: string;

  constructor(text: string, cols: number, isWrapped = false) {
    this.text = text.padEnd(cols);
    this.length = cols;
    this.isWrapped = isWrapped;
  }

  getCell(x: number, cell: MockCell) {
    cell.chars = this.text[x] ?? " ";
    cell.width = 1;
    return cell;
  }
}

function mockTerminal(lines: MockLine[], cols: number) {
  let provider: ILinkProvider | undefined;
  const cell = new MockCell();
  const terminal = {
    cols,
    options: {},
    buffer: {
      active: {
        getLine: (y: number) => lines[y],
        getNullCell: () => cell as unknown as IBufferCell,
      },
    },
    registerLinkProvider(value: ILinkProvider) {
      provider = value;
      return { dispose() {} };
    },
  } as unknown as Terminal;
  return { terminal, getProvider: () => provider! };
}

function provide(provider: ILinkProvider, y: number) {
  return new Promise<NonNullable<Parameters<Parameters<ILinkProvider["provideLinks"]>[1]>[0]>>(
    (resolve) => provider.provideLinks(y, (links) => resolve(links ?? []))
  );
}

test("recognizes one URL split by a CLI hard wrap and opens it on Cmd+click", async () => {
  const cols = 50;
  const url = "https://github.com/thinkany-ai/termany/issues/6#issuecomment-5031460690";
  const prefix = "PR ";
  const cut = cols - prefix.length;
  const first = prefix + url.slice(0, cut);
  const second = url.slice(cut) + ") published";
  const mock = mockTerminal([new MockLine(first, cols), new MockLine(second, cols)], cols);
  let opened = "";
  registerWebLinks(mock.terminal, async (value) => {
    opened = value;
    return null;
  });

  const links = await provide(mock.getProvider(), 2);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, url);
  assert.deepEqual(links[0].range.start, { x: prefix.length + 1, y: 1 });
  assert.equal(links[0].range.end.y, 2);

  links[0].activate({ metaKey: false, preventDefault() {} } as unknown as MouseEvent, url);
  await Promise.resolve();
  assert.equal(opened, "");

  let prevented = false;
  links[0].activate(
    { metaKey: true, preventDefault: () => (prevented = true) } as unknown as MouseEvent,
    url
  );
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.equal(opened, url);
});

test("OSC 8 rich-text links use the external opener on Cmd+click", async () => {
  const mock = mockTerminal([], 80);
  const opened: string[] = [];
  registerWebLinks(mock.terminal, async (url) => {
    opened.push(url);
    return null;
  });
  const handler = mock.terminal.options.linkHandler!;
  assert.equal(handler.allowNonHttpProtocols, false);
  const url = "https://github.com/maxgent-ai/fleet/pull/111";
  const range = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } };
  let prevented = 0;
  const event = (metaKey: boolean) => ({
    metaKey,
    preventDefault() { prevented++; },
  }) as MouseEvent;

  handler.activate(event(false), url, range);
  assert.deepEqual(opened, []);
  handler.activate(event(true), url, range);
  await Promise.resolve();
  assert.deepEqual(opened, [url]);
  assert.equal(prevented, 1);

  for (const unsafe of ["javascript:alert(1)", "file:///tmp/example", "not a URL"]) {
    handler.activate(event(true), unsafe, range);
  }
  assert.deepEqual(opened, [url]);
  assert.equal(prevented, 1);
});

test("does not concatenate unrelated short physical lines", async () => {
  const cols = 40;
  const mock = mockTerminal(
    [new MockLine("See https://example.com", cols), new MockLine("next", cols)],
    cols
  );
  registerWebLinks(mock.terminal, async () => null);

  const links = await provide(mock.getProvider(), 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
});
