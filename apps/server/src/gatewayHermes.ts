import { isMap, parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";

const MODEL_KEYS = ["provider", "default", "base_url", "api_mode", "api_key"];
const providerId = (id: string) => `termany_gateway_${id.replaceAll("-", "")}`;

function document(content: string) {
  const doc = parseDocument(content);
  if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error("Hermes config.yaml must be a valid YAML mapping. Your configuration has been preserved.");
  return doc;
}

export function gatewayHermesBaseUrl(content: string) {
  const value = document(content).getIn(["model", "base_url"]);
  if (typeof value !== "string") throw new Error("Hermes gateway endpoint is missing.");
  return value;
}

export function applyHermesGateway(content: string, id: string, baseUrl: string, token: string, model: string) {
  const doc = document(content);
  for (const key of ["model", "providers"]) {
    const value = doc.get(key, true);
    if (!isMap(value)) {
      if (value && ![null, ""].includes(doc.get(key) as null | string)) throw new Error(`Hermes ${key} must be a YAML mapping.`);
      doc.set(key, doc.createNode({}));
    }
  }
  const provider = providerId(id);
  doc.setIn(["providers", provider], doc.createNode({ name: "Termany Model Gateway", api: baseUrl, api_key: token, transport: "chat_completions", default_model: model }));
  for (const [key, value] of Object.entries({ provider, default: model, base_url: baseUrl, api_mode: "chat_completions", api_key: token })) doc.setIn(["model", key], value);
  return doc.toString();
}

/** Restore only fields owned by this connection; preserve unrelated YAML and comments. */
export function restoreHermesGateway(before: string, after: string, live: string, id: string) {
  const old = document(before), applied = document(after), current = document(live);
  const paths = [...MODEL_KEYS.map((key) => ["model", key]), ["providers", providerId(id)]];
  for (const keys of paths) {
    const previous = old.getIn(keys), expected = applied.getIn(keys), value = current.getIn(keys);
    const json = (v: unknown) => v && typeof v === "object" && "toJSON" in v ? (v as { toJSON(): unknown }).toJSON() : v;
    if (isDeepStrictEqual(json(previous), json(expected))) continue;
    if (!isDeepStrictEqual(json(value), json(expected))) throw new Error("Hermes gateway settings changed after connecting. Your changes have been preserved; restore the gateway settings before disconnecting.");
    if (old.hasIn(keys)) current.setIn(keys, old.getIn(keys, true));
    else current.deleteIn(keys);
  }
  for (const key of ["model", "providers"]) {
    const value = current.get(key, true);
    if (isMap(value) && value.items.length === 0) {
      if (old.has(key)) current.set(key, old.get(key, true));
      else current.delete(key);
    }
  }
  return current.toString();
}
