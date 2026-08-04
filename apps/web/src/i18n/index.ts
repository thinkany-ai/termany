import { useCallback, useEffect, useMemo, useState } from "react";

import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";
import ja from "./locales/ja";
import ko from "./locales/ko";
import es from "./locales/es";
import fr from "./locales/fr";
import de from "./locales/de";
import ptBR from "./locales/pt-BR";
import ru from "./locales/ru";
import it from "./locales/it";
import hi from "./locales/hi";

const STORAGE_KEY = "termany.language";
const LANGUAGE_CHANGED_EVENT = "termany:language-changed";

export type Language =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "pt-BR"
  | "ru"
  | "it"
  | "hi";

/**
 * Every shipped language, in the order the Settings picker shows them. Labels
 * are the language's own endonym rather than a translated name: someone who
 * lands in the wrong language still has to find their way out of this list.
 */
export const LANGUAGES: ReadonlyArray<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "ru", label: "Русский" },
  { value: "it", label: "Italiano" },
  { value: "hi", label: "हिन्दी" },
];

/** English is the source locale; the rest may lag behind it and fall back. */
type TranslationKey = keyof typeof en;
type Dictionary = Partial<Record<TranslationKey, string>>;

export const dictionaries: Record<Language, Dictionary> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
  "pt-BR": ptBR,
  ru,
  it,
  hi,
};

const SUPPORTED = new Set<string>(LANGUAGES.map((l) => l.value));

/**
 * Map an arbitrary BCP-47 tag onto a shipped language. Exact match wins, then
 * the base subtag ("fr-CA" → "fr"). Chinese is special-cased: the script, not
 * the region, decides between Simplified and Traditional, so Hong Kong/Macau
 * and an explicit `Hant` both land on zh-TW.
 */
export function matchLanguage(tag: string): Language | null {
  const normalized = tag.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();

  if (lower.startsWith("zh")) {
    return /hant|-tw|-hk|-mo/.test(lower) ? "zh-TW" : "zh-CN";
  }
  // Brazilian is the only Portuguese we ship, so pt-PT lands here too — closer
  // than falling through to English. Revisit if a pt-PT dictionary is added.
  if (lower.startsWith("pt")) return "pt-BR";

  const exact = LANGUAGES.find((l) => l.value.toLowerCase() === lower);
  if (exact) return exact.value;

  const base = lower.split("-")[0];
  const byBase = LANGUAGES.find((l) => l.value.toLowerCase().split("-")[0] === base);
  return byBase?.value ?? null;
}

function normalizeLanguage(value: string | null | undefined): Language {
  if (!value) return "en";
  if (SUPPORTED.has(value)) return value as Language;
  return matchLanguage(value) ?? "en";
}

/**
 * The language to use when nothing has been picked yet. `navigator.languages`
 * is ordered by preference, so the first entry we actually ship wins — a
 * fr-CA/en user gets French, not English.
 */
function detectLanguage(): Language {
  try {
    const candidates = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
    for (const tag of candidates) {
      const match = matchLanguage(tag);
      if (match) return match;
    }
  } catch {
    // Non-browser context (tests, SSR) — fall through to English.
  }
  return "en";
}

export function getLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeLanguage(stored) : detectLanguage();
  } catch {
    return "en";
  }
}

export function setLanguage(language: Language) {
  localStorage.setItem(STORAGE_KEY, language);
  window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT));
}

/**
 * Look up `key`, falling back to English then to the key itself, and fill any
 * `{placeholder}` from `params`. Placeholders (rather than string concatenation
 * at the call site) let a translation reorder the sentence around its values —
 * e.g. "24 GB of 32 GB" vs "共 32 GB，已用 24 GB".
 */
export function translate(language: Language, key: string, params?: Record<string, string | number>) {
  const k = key as TranslationKey;
  const raw = dictionaries[language][k] ?? en[k] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function useI18n() {
  const [language, setCurrentLanguage] = useState(getLanguage);

  useEffect(() => {
    const onChange = () => setCurrentLanguage(getLanguage());
    window.addEventListener(LANGUAGE_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // `t` is memoized on the language, not rebuilt per render: callers put it in
  // useMemo/useEffect dependency lists, and an unstable identity there silently
  // turns those into "runs every render" (it once reset the ⌘P palette's
  // selection on every keystroke, so the arrow keys appeared dead).
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    [language]
  );

  return useMemo(() => ({ language, setLanguage, t }), [language, t]);
}
