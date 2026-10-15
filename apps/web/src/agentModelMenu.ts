/**
 * Turning an ACP agent's model selector into composer-menu rows.
 *
 * Agents disagree wildly on scale: Claude and Codex offer a handful of models
 * by bare name, while OpenCode reports every model of every provider it knows —
 * 400 of them, named "vendor/model". So the shape of the menu has to come from
 * the data rather than from a fixed layout.
 */

/** One value of an ACP session selector. */
export interface AcpConfigValue {
  value: string;
  name: string;
}

export interface AcpConfigGroup {
  group: string;
  name: string;
  options: AcpConfigValue[];
}

/**
 * A selector an ACP agent exposes for its session — the model, but also its
 * permission mode, reasoning effort and so on. Only the model is surfaced in
 * the composer; the rest already have homes in the agent's own config.
 */
export interface AcpConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean";
  category?: string | null;
  currentValue?: string;
  options?: Array<AcpConfigValue | AcpConfigGroup>;
}

export interface ModelMenuItem {
  id: string;
  label: string;
  checked: boolean;
  items?: ModelMenuItem[];
}

/**
 * A native select does not include its optgroup label when it renders the
 * selected value. Flatten grouped model choices and qualify every child with
 * its provider so two providers offering the same model remain distinguishable
 * both while choosing and after the control closes.
 */
export function modelSelectItems(choices: ModelMenuItem[]): ModelMenuItem[] {
  return choices.flatMap((choice) => choice.items
    ? choice.items.map((item) => ({ ...item, label: `${item.label} · ${choice.label}` }))
    : [choice]
  );
}

/** Flatten a selector's values, whichever of the two shapes ACP sent. */
export function modelValues(option: AcpConfigOption | undefined): AcpConfigValue[] {
  return (option?.options ?? []).flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

/**
 * Just the model, without the provider that qualifies it.
 *
 * "Google/Gemini 2.5 Flash" is what the agent calls it, but the provider is
 * only there to disambiguate a 400-model list — in a composer chip, or in a
 * submenu already titled with that provider, it is the part with no news in it.
 */
export function shortModelName(name: string): string {
  const cut = name.lastIndexOf("/");
  const tail = cut === -1 ? name : name.slice(cut + 1).trim();
  return tail || name;
}

/** Display name for a value id, falling back to the id itself. */
export function modelLabelFor(option: AcpConfigOption | undefined, value: string): string {
  return modelValues(option).find((entry) => entry.value === value)?.name ?? value;
}

/** Below this a flat list is easier to scan than a tree of submenus. */
const GROUPING_THRESHOLD = 12;

export function modelMenuItems(option: AcpConfigOption, current: string): ModelMenuItem[] {
  const entries = option.options ?? [];
  const groups = entries.filter((entry): entry is AcpConfigGroup => "group" in entry);
  if (groups.length) {
    return groups.map((group) => ({
      id: group.group,
      label: group.name,
      checked: group.options.some((child) => child.value === current),
      items: group.options.map((child) => ({
        id: child.value,
        label: child.name,
        checked: child.value === current,
      })),
    }));
  }

  const flat = entries.filter((entry): entry is AcpConfigValue => !("group" in entry));
  // A long "vendor/model" list is split by vendor rather than left as an
  // unnavigable wall. Both conditions matter: a long list without a common
  // separator has nothing to split on, and a short one reads better flat.
  if (flat.length > GROUPING_THRESHOLD && flat.every((entry) => entry.value.includes("/"))) {
    const byVendor = new Map<string, AcpConfigValue[]>();
    for (const entry of flat) {
      const vendor = entry.value.slice(0, entry.value.indexOf("/"));
      byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), entry]);
    }
    return [...byVendor].map(([vendor, values]) => ({
      id: vendor,
      label: vendor,
      checked: values.some((entry) => entry.value === current),
      items: values.map((entry) => ({
        id: entry.value,
        label: shortModelName(entry.name),
        checked: entry.value === current,
      })),
    }));
  }

  return flat.map((entry) => ({
    id: entry.value,
    label: entry.name,
    checked: entry.value === current,
  }));
}
