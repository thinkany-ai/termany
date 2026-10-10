import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  modelLabelFor,
  modelMenuItems,
  modelSelectItems,
  modelValues,
  shortModelName,
  type AcpConfigOption,
} from "../src/agentModelMenu.js";

/** Shaped after what `claude-agent-acp` actually returns from `session/new`. */
const CLAUDE: AcpConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus[1m]",
  options: [
    { value: "default", name: "Default (recommended)" },
    { value: "opus[1m]", name: "Opus (1M context)" },
    { value: "claude-fable-5[1m]", name: "Fable (1M context)" },
    { value: "sonnet", name: "Sonnet" },
    { value: "haiku", name: "Haiku" },
  ],
};

/** OpenCode's list, cut down: 400 entries across anthropic/google/openrouter. */
const OPENCODE: AcpConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opencode/big-pickle",
  options: [
    { value: "anthropic/claude-fable-5", name: "Anthropic/Claude Fable 5" },
    { value: "anthropic/claude-haiku-4-5", name: "Anthropic/Claude Haiku 4.5 (latest)" },
    ...Array.from({ length: 11 }, (_, i) => ({
      value: `google/gemini-${i}`,
      name: `Google/Gemini ${i}`,
    })),
    { value: "opencode/big-pickle", name: "OpenCode/Big Pickle" },
  ],
};

const GROUPED: AcpConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "b/two",
  options: [
    { group: "a", name: "Vendor A", options: [{ value: "a/one", name: "One" }] },
    { group: "b", name: "Vendor B", options: [{ value: "b/two", name: "Two" }] },
  ],
};

describe("modelMenuItems", () => {
  test("keeps a short list flat and marks the current model", () => {
    const items = modelMenuItems(CLAUDE, "opus[1m]");
    assert.equal(items.length, 5);
    assert.ok(items.every((item) => !item.items), "no submenus for a short list");
    assert.deepEqual(
      items.filter((item) => item.checked).map((item) => item.id),
      ["opus[1m]"]
    );
    assert.equal(items[0].label, "Default (recommended)");
  });

  test("splits a long vendor-prefixed list into one submenu per vendor", () => {
    const items = modelMenuItems(OPENCODE, "opencode/big-pickle");
    assert.deepEqual(
      items.map((item) => item.id),
      ["anthropic", "google", "opencode"]
    );
    // Every model must survive the regrouping — a menu that quietly drops
    // models is worse than one that is hard to scan.
    assert.equal(
      items.reduce((total, item) => total + (item.items?.length ?? 0), 0),
      OPENCODE.options!.length
    );
  });

  test("marks the vendor holding the current model, and only that one", () => {
    const items = modelMenuItems(OPENCODE, "google/gemini-3");
    assert.deepEqual(
      items.filter((item) => item.checked).map((item) => item.id),
      ["google"]
    );
    const google = items.find((item) => item.id === "google")!;
    assert.deepEqual(
      google.items!.filter((item) => item.checked).map((item) => item.id),
      ["google/gemini-3"]
    );
  });

  test("drops the vendor prefix from rows already filed under it", () => {
    const items = modelMenuItems(OPENCODE, "");
    const anthropic = items.find((item) => item.id === "anthropic")!;
    assert.deepEqual(
      anthropic.items!.map((item) => item.label),
      ["Claude Fable 5", "Claude Haiku 4.5 (latest)"]
    );
  });

  test("uses the groups the agent supplied rather than re-deriving them", () => {
    const items = modelMenuItems(GROUPED, "b/two");
    assert.deepEqual(
      items.map((item) => item.label),
      ["Vendor A", "Vendor B"]
    );
    assert.deepEqual(
      items.filter((item) => item.checked).map((item) => item.id),
      ["b"]
    );
  });

  test("stays flat when a long list has no shared separator to split on", () => {
    const many: AcpConfigOption = {
      ...CLAUDE,
      options: Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, name: `Model ${i}` })),
    };
    assert.ok(modelMenuItems(many, "m0").every((item) => !item.items));
  });

  test("survives an agent that offers no values at all", () => {
    assert.deepEqual(modelMenuItems({ ...CLAUDE, options: undefined }, ""), []);
  });
});

describe("shortModelName", () => {
  test("keeps only the model, dropping the provider that qualifies it", () => {
    assert.equal(shortModelName("Google/Gemini 2.5 Computer Use Preview 10-2025"),
      "Gemini 2.5 Computer Use Preview 10-2025");
    assert.equal(shortModelName("Anthropic/Claude Fable 5"), "Claude Fable 5");
  });

  test("takes the last segment when a provider is itself qualified", () => {
    assert.equal(shortModelName("OpenRouter/anthropic/claude-sonnet-5"), "claude-sonnet-5");
  });

  test("leaves an unqualified name alone", () => {
    assert.equal(shortModelName("Opus (1M context)"), "Opus (1M context)");
  });

  test("keeps the original rather than emptying a name that ends in a slash", () => {
    assert.equal(shortModelName("Anthropic/"), "Anthropic/");
  });
});

describe("modelLabelFor", () => {
  test("names the current model for the composer trigger", () => {
    assert.equal(modelLabelFor(CLAUDE, "sonnet"), "Sonnet");
    assert.equal(modelLabelFor(GROUPED, "b/two"), "Two");
  });

  test("falls back to the raw id for a model the agent no longer lists", () => {
    assert.equal(modelLabelFor(CLAUDE, "opus-3"), "opus-3");
  });

  test("has nothing to say before any session has reported options", () => {
    assert.deepEqual(modelValues(undefined), []);
    assert.equal(modelLabelFor(undefined, "sonnet"), "sonnet");
  });
});

describe("modelSelectItems", () => {
  test("includes the provider in every grouped model label", () => {
    const choices = [
      {
        id: "local",
        label: "grouter-local",
        checked: true,
        items: [{ id: "local/deepseek", label: "deepseek-v4-flash-vision-exp", checked: true }],
      },
      {
        id: "deepseek",
        label: "DeepSeek",
        checked: false,
        items: [{ id: "deepseek/deepseek", label: "deepseek-v4-flash-vision-exp", checked: false }],
      },
    ];

    assert.deepEqual(
      modelSelectItems(choices).map(({ id, label }) => ({ id, label })),
      [
        { id: "local/deepseek", label: "deepseek-v4-flash-vision-exp · grouter-local" },
        { id: "deepseek/deepseek", label: "deepseek-v4-flash-vision-exp · DeepSeek" },
      ]
    );
  });

  test("keeps an ungrouped agent-managed model unchanged", () => {
    const choices = [{ id: "sonnet", label: "Sonnet", checked: true }];
    assert.deepEqual(modelSelectItems(choices), choices);
  });
});
