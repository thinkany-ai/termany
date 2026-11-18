import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useI18n } from "../i18n";
import { workspaceApiPath } from "../state/devices";
import { markdownMediaUrl } from "../markdownLocalMedia";

/** Fences that read as shell commands get a run button; the rest copy only. */
const SHELL_LANGS = new Set(["", "sh", "bash", "zsh", "shell", "console", "cmd", "powershell"]);

// Inline SVG (lucide outlines) because these buttons live inside sanitized
// innerHTML, where React components can't render.
const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const run = SHELL_LANGS.has(language) ? `<button class="md-code-btn" data-action="run">${ICONS.run}</button>` : "";
      return (
        `<div class="md-code">` +
        `<div class="md-code-actions">${run}<button class="md-code-btn" data-action="copy">${ICONS.copy}</button></div>` +
        `<pre><code>${escapeHtml(text)}</code></pre>` +
        `</div>`
      );
    },
  },
});

// Agent tools often save screenshots locally and return their absolute path in
// ordinary Markdown instead of an ACP image block. Rewrite those paths before
// sanitization so images render inline and file links open through the same
// local media endpoint used by structured attachments.
DOMPurify.addHook("beforeSanitizeAttributes", (node) => {
  const attribute = node.tagName === "IMG" ? "src" : node.tagName === "A" ? "href" : undefined;
  if (!attribute) return;
  const value = node.getAttribute(attribute);
  if (!value) return;
  const mediaUrl = markdownMediaUrl(value, workspaceApiPath("/api/fs/media"));
  if (mediaUrl) node.setAttribute(attribute, mediaUrl);
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
});

export function Markdown({
  text,
  onRun,
  inline = false,
}: {
  text: string;
  onRun?: (code: string) => void;
  inline?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => DOMPurify.sanitize(inline
      ? marked.parseInline(text, { async: false })
      : marked.parse(text, { async: false })),
    [inline, text]
  );

  // Button titles are stamped after render — keeps the translatable strings
  // out of the sanitized HTML, which is memoized on `text` alone.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLButtonElement>(".md-code-btn").forEach((button) => {
      const label = button.dataset.action === "run" ? t("markdown.run") : t("markdown.copy");
      button.title = label;
      button.setAttribute("aria-label", label);
    });
  }, [html, t]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".md-code-btn");
    if (!button) return;
    const code = button.closest(".md-code")?.querySelector("pre code")?.textContent?.trim() ?? "";
    if (!code) return;
    if (button.dataset.action === "run") {
      onRun?.(code);
      return;
    }
    navigator.clipboard
      .writeText(code)
      .then(() => {
        button.innerHTML = ICONS.check;
        window.setTimeout(() => {
          button.innerHTML = ICONS.copy;
        }, 1400);
      })
      .catch(() => {
        // Clipboard denied — leave the icon as is.
      });
  };

  return (
    <div
      className={`markdown-body${inline ? " markdown-inline" : ""}${onRun ? "" : " md-no-run"}`}
      ref={ref}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
