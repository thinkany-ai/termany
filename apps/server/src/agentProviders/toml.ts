/**
 * Text-level TOML editing.
 *
 * Switching a provider must touch `model_provider` and one
 * `[model_providers.x]` section — and nothing else. A real parse/serialise
 * round-trip cannot promise that: it drops comments, reorders tables and
 * rewrites every value's formatting, so a user who hand-wrote their
 * ~/.codex/config.toml would find it silently reformatted on the first switch.
 *
 * cc-switch avoids the problem by storing a whole config.toml snapshot per
 * provider, which trades formatting loss for data loss: any section the
 * snapshot predates (a new [projects."…"] trust level, an [mcp_servers.x]) is
 * erased when that provider is selected again.
 *
 * So we edit the bytes. Everything outside the lines we own is passed through
 * untouched.
 */

/** A line that opens a table or array-of-tables, e.g. `[a.b]` or `[[a.b]]`. */
const SECTION_LINE = /^[ \t]*\[/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Serialise a JS value as a TOML scalar. Only the types a provider needs. */
export function formatValue(value: string | number | boolean): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Decode a TOML scalar back to JS. Unquoted words stay strings. */
export function parseValue(raw: string): string | number | boolean {
  const value = raw.trim().replace(/\s*#.*$/, "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  return value;
}

/** Index of the first section header, i.e. the end of the top-level region. */
function preambleEnd(lines: string[]): number {
  const index = lines.findIndex((line) => SECTION_LINE.test(line));
  return index === -1 ? lines.length : index;
}

/** Read a bare top-level key (one that sits above every section header). */
export function readTopLevelKey(source: string, key: string): string | number | boolean | null {
  const lines = source.split("\n");
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=(.*)$`);
  for (const line of lines.slice(0, preambleEnd(lines))) {
    const match = pattern.exec(line);
    if (match) return parseValue(match[1]);
  }
  return null;
}

/**
 * Set a bare top-level key, or remove it when `value` is null. New keys are
 * appended to the end of the top-level region so they stay above every
 * section — a key written after a `[table]` header would belong to that table.
 */
export function setTopLevelKey(
  source: string,
  key: string,
  value: string | number | boolean | null
): string {
  const lines = source.split("\n");
  const end = preambleEnd(lines);
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=`);
  const at = lines.slice(0, end).findIndex((line) => pattern.test(line));

  if (value === null) {
    if (at === -1) return source;
    lines.splice(at, 1);
    return lines.join("\n");
  }
  const rendered = `${key} = ${formatValue(value)}`;
  if (at !== -1) {
    lines[at] = rendered;
    return lines.join("\n");
  }
  // Keep one blank line between the preamble and the first section.
  let insert = end;
  while (insert > 0 && lines[insert - 1].trim() === "") insert--;
  lines.splice(insert, 0, rendered);
  return lines.join("\n");
}

/** Line range [start, end) of a section including its header, or null. */
function sectionRange(lines: string[], header: string): { start: number; end: number } | null {
  const pattern = new RegExp(`^[ \\t]*\\[[ \\t]*${escapeRegExp(header)}[ \\t]*\\][ \\t]*$`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !SECTION_LINE.test(lines[end])) end++;
  return { start, end };
}

/** A section's body as `{ key: value }`. Null when the section is absent. */
export function readSection(
  source: string,
  header: string
): Record<string, string | number | boolean> | null {
  const lines = source.split("\n");
  const range = sectionRange(lines, header);
  if (!range) return null;
  const body: Record<string, string | number | boolean> = {};
  for (const line of lines.slice(range.start + 1, range.end)) {
    const match = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=(.*)$/.exec(line);
    if (match) body[match[1]] = parseValue(match[2]);
  }
  return body;
}

/** Every `[<prefix>.<name>]` section name present in the document. */
export function sectionNames(source: string, prefix: string): string[] {
  const pattern = new RegExp(`^[ \\t]*\\[[ \\t]*${escapeRegExp(prefix)}\\.([^\\]]+?)[ \\t]*\\][ \\t]*$`);
  return source
    .split("\n")
    .map((line) => pattern.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Replace a section's body wholesale, or append the section when it's new. */
export function upsertSection(
  source: string,
  header: string,
  body: Record<string, string | number | boolean>
): string {
  const rendered = [`[${header}]`, ...Object.entries(body).map(([k, v]) => `${k} = ${formatValue(v)}`)];
  const lines = source.split("\n");
  const range = sectionRange(lines, header);
  if (range) {
    // Keep the blank lines that separated this section from the next one.
    let tail = range.end;
    while (tail > range.start + 1 && lines[tail - 1].trim() === "") tail--;
    lines.splice(range.start, tail - range.start, ...rendered);
    return lines.join("\n");
  }
  const trimmed = source.replace(/\n+$/, "");
  return `${trimmed ? `${trimmed}\n\n` : ""}${rendered.join("\n")}\n`;
}

/** Drop a section and its body. Unknown sections are left alone. */
export function removeSection(source: string, header: string): string {
  const lines = source.split("\n");
  const range = sectionRange(lines, header);
  if (!range) return source;
  let end = range.end;
  // Absorb the blank separator so repeated switches don't stack empty lines.
  while (end > range.start && lines[end - 1].trim() === "") end--;
  if (end < lines.length && lines[end]?.trim() === "") end++;
  lines.splice(range.start, end - range.start);
  return lines.join("\n");
}
