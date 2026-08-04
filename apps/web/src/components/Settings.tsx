import { Bot, Brain, Info, Keyboard, Palette } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { apiPath } from "../api";
import { isTauri } from "../env";
import { LANGUAGES, useI18n, type Language } from "../i18n";
import { openExternal, revealPath } from "../openExternal";
import { type RailItemId } from "../rail-config";
import { useStore } from "../state/store";
import {
  checkForUpdate,
  installUpdate,
  isUpdateInstalled,
  relaunchApp,
  runningTaskCount,
} from "../updater";
import { BUILT_IN_THEMES } from "../themes";
import {
  codexThemeId,
  fetchCodexListings,
  registerCodexListing,
  type CodexListing,
} from "../themes/codex-packs";
import {
  loadFontConfig,
  saveFontConfig,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  DEFAULT_FONT_CONFIG,
  type FontConfig,
} from "../font-config";
import { applyFontFamily, applyFontSize } from "../terminal/manager";
import { AgentSettings } from "./AgentSettings";
import {
  ActivityIcon,
  AgentIcon,
  ChartIcon,
  ChatIcon,
  CloseIcon,
  ExternalOpenIcon,
  FilesIcon,
  GearIcon,
  GitBranchIcon,
  HistoryIcon,
  RevealFolderIcon,
  TerminalIcon,
  WebIcon,
} from "./icons";
import { KeyboardSettings } from "./KeyboardSettings";
import { ModelSettings } from "./ModelSettings";
import { UsageSelect } from "./Select";

/** Where users get more custom themes (the folder below is populated from it). */
const THEMES_SITE = "https://codexthemes.ai/themes";
const THEMES_SITE_LABEL = "codexthemes.ai/themes";

const REPO = "https://github.com/thinkany-ai/termany";

/** About-section destinations; `key` also names the i18n label (about.<key>). */
const ABOUT_LINKS = [
  { key: "website", url: "https://termany.sh?utm_source=termany_app&utm_medium=settings_about" },
  { key: "source", url: REPO },
  { key: "feedback", url: `${REPO}/issues` },
] as const;

export type SettingsSection = "general" | "appearance" | "models" | "agents" | "keyboard" | "about";

/** Left-nav entries, in display order. Labels come from i18n (settings.<id>). */
const NAV_SECTIONS: { id: SettingsSection; icon: ReactNode }[] = [
  { id: "general", icon: <GearIcon /> },
  { id: "appearance", icon: <Palette size={16} /> },
  { id: "models", icon: <Brain size={16} /> },
  { id: "agents", icon: <Bot size={16} /> },
  { id: "keyboard", icon: <Keyboard size={16} /> },
  { id: "about", icon: <Info size={16} /> },
];

const RAIL_SETTINGS: Array<{ id: RailItemId; labelKey: string; icon: ReactNode }> = [
  { id: "terminal", labelKey: "pane.view.terminal", icon: <TerminalIcon /> },
  { id: "files", labelKey: "pane.view.files", icon: <FilesIcon /> },
  { id: "git", labelKey: "pane.view.git", icon: <GitBranchIcon /> },
  { id: "agent", labelKey: "pane.view.agent", icon: <ChatIcon /> },
  { id: "web", labelKey: "pane.view.web", icon: <WebIcon /> },
  { id: "monitor", labelKey: "pane.view.monitor", icon: <ActivityIcon /> },
  { id: "agents", labelKey: "settings.rail.agents", icon: <AgentIcon /> },
  { id: "history", labelKey: "pane.view.history", icon: <HistoryIcon /> },
  { id: "usage", labelKey: "pane.view.usage", icon: <ChartIcon /> },
];

const CUSTOM_FONT_FAMILY = "__custom__";
const FONT_FAMILY_PRESETS = [
  { value: DEFAULT_FONT_CONFIG.family, label: "Menlo / SF Mono" },
  { value: "Menlo, monospace", label: "Menlo" },
  { value: '"SF Mono", SFMono-Regular, Menlo, monospace', label: "SF Mono" },
  { value: "Monaco, monospace", label: "Monaco" },
  { value: '"JetBrains Mono", monospace', label: "JetBrains Mono" },
  { value: '"Fira Code", monospace', label: "Fira Code" },
  { value: '"Cascadia Code", "Cascadia Mono", monospace', label: "Cascadia Code" },
  { value: 'Consolas, "Courier New", monospace', label: "Consolas" },
] as const;

function isPresetFontFamily(family: string): boolean {
  return FONT_FAMILY_PRESETS.some((preset) => preset.value === family);
}

/**
 * App-wide settings, shown as an in-app overlay (works in both web and the
 * desktop build — no separate OS window to keep in sync). Left nav + right
 * content, mirroring the familiar terminal-settings layout. MVP: Appearance.
 */
export function Settings({
  initialSection = "general",
  onClose,
  onSectionChange,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
  /** Reported so the panel can reopen where the user left it. */
  onSectionChange?: (section: SettingsSection) => void;
}) {
  const { language, setLanguage, t } = useI18n();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const railVisibility = useStore((s) => s.railVisibility);
  const setRailItemVisible = useStore((s) => s.setRailItemVisible);

  const [fontConfig, setFontConfig] = useState<FontConfig>(loadFontConfig);
  const [customFontFamily, setCustomFontFamily] = useState(
    () => !isPresetFontFamily(fontConfig.family),
  );

  const [section, setSection] = useState<SettingsSection>(initialSection);

  const goto = (next: SettingsSection) => {
    setSection(next);
    onSectionChange?.(next);
  };
  const [importError, setImportError] = useState<string | null>(null);
  const [codexThemes, setCodexThemes] = useState<CodexListing[]>([]);
  const [codexThemesLoading, setCodexThemesLoading] = useState(false);
  const [codexThemesError, setCodexThemesError] = useState<string | null>(null);
  const [codexThemesReload, setCodexThemesReload] = useState(0);
  // Absolute path of ~/.codexthemes/themes, reported by the server so the
  // reveal button doesn't have to guess the home directory.
  const [themesRoot, setThemesRoot] = useState<string | null>(null);
  const [applyingCodex, setApplyingCodex] = useState<string | null>(null);
  const [version, setVersion] = useState("0.1.0");
  const [aboutError, setAboutError] = useState<string | null>(null);

  // Self-update flow (desktop only): idle → checking → (none | available) →
  // downloading → (waiting → ready | restarting). `updateVersion` is
  // global so badges stay in sync; the installed flag lives in updater.ts so
  // closing and reopening Settings does not offer to download it twice.
  const updateVersion = useStore((s) => s.updateVersion);
  const setUpdateVersion = useStore((s) => s.setUpdateVersion);
  const [updPhase, setUpdPhase] = useState<
    "idle" | "checking" | "none" | "downloading" | "waiting" | "ready" | "restarting"
  >(() => (isUpdateInstalled() ? "waiting" : "idle"));
  const [updPct, setUpdPct] = useState(0);
  const [runningTasks, setRunningTasks] = useState(0);
  const [updError, setUpdError] = useState<string | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  async function checkUpdates() {
    setUpdPhase("checking");
    setUpdError(null);
    try {
      const u = await checkForUpdate();
      setUpdateVersion(u?.version ?? null);
      setUpdPhase(u ? "idle" : "none");
    } catch (e) {
      setUpdError(e instanceof Error ? e.message : String(e));
      setUpdPhase("idle");
    }
  }

  async function finishUpdate() {
    setUpdPhase("restarting");
    setUpdError(null);
    try {
      const count = await relaunchApp();
      if (count > 0) {
        setRunningTasks(count);
        setUpdPhase("waiting");
      }
    } catch (e) {
      setUpdError(e instanceof Error ? e.message : String(e));
      setUpdPhase("ready");
    }
  }

  async function applyUpdate() {
    setUpdPhase("downloading");
    setUpdPct(0);
    setUpdError(null);
    try {
      await installUpdate(setUpdPct);
      await finishUpdate();
    } catch (e) {
      setUpdError(e instanceof Error ? e.message : String(e));
      setUpdPhase(isUpdateInstalled() ? "ready" : "idle");
    }
  }

  // Once installed, keep checking quietly while tasks finish. Restart remains
  // an explicit click so completing a task never makes the app vanish under
  // the user's hands.
  useEffect(() => {
    if (updPhase !== "waiting") return;
    let cancelled = false;
    const refresh = () => {
      runningTaskCount()
        .then((count) => {
          if (cancelled) return;
          setRunningTasks(count);
          if (count === 0) setUpdPhase("ready");
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [updPhase]);

  // The desktop app exposes the real bundle version; the browser keeps the default.
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Esc closes. Capture on `document` so the terminal/xterm cannot swallow the
  // key before this overlay sees it. Keyboard rebinding still wins because it
  // listens on `window` capture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The gallery of locally installed CodexThemes packages (~/.codexthemes),
  // refetched each time Appearance opens so newly created packages show up.
  useEffect(() => {
    if (section !== "appearance") return;
    const controller = new AbortController();
    setCodexThemesLoading(true);
    setCodexThemesError(null);
    fetchCodexListings({ signal: controller.signal })
      .then(({ themes, root }) => {
        setCodexThemes(themes);
        setThemesRoot(root);
        setCodexThemesLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setCodexThemesError(error instanceof Error ? error.message : String(error));
        setCodexThemesLoading(false);
      });
    return () => controller.abort();
  }, [section, codexThemesReload]);

  /** One-click apply. The theme is registered in memory only — the folder on
   *  disk stays the source of truth and is re-read on the next launch. */
  async function applyCodexTheme(item: CodexListing) {
    setImportError(null);
    setApplyingCodex(item.manifest.id);
    try {
      const created = await registerCodexListing(item);
      setTheme(created.id);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingCodex(null);
    }
  }

  /** Open ~/.codexthemes/themes in Finder/Explorer (desktop only). */
  async function revealThemesFolder() {
    if (!themesRoot) return;
    setImportError(await revealPath(themesRoot));
  }


  // The empty-state sentence wraps a link, so it's split on the {site}
  // placeholder instead of concatenated — each language keeps its own word
  // order and spacing around the link.
  const [emptyBefore, emptyAfter] = t("theme.empty").split("{site}");

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-window"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-title">{t("settings.title")}</div>
          {NAV_SECTIONS.map(({ id, icon }) => (
            <div
              key={id}
              className={`settings-nav-item ${section === id ? "active" : ""}`}
              onClick={() => goto(id)}
            >
              <span className="settings-nav-icon">{icon}</span>
              {t(`settings.${id}`)}
            </div>
          ))}
        </aside>

        <div className="settings-body">
          {section === "models" && <ModelSettings />}
          {section === "agents" && <AgentSettings />}
          {section === "keyboard" && <KeyboardSettings />}
          {section === "general" && (
            <>
              <div className="settings-section-title">{t("settings.language.title")}</div>
              <div className="language-setting">
                <span>{t("settings.language.label")}</span>
                {/* Custom select — the native popup can't be themed and looks
                    out of place in the desktop (WKWebView) build. */}
                <UsageSelect
                  value={language}
                  width={200}
                  options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                  onChange={(v) => setLanguage(v as Language)}
                />
              </div>

              <div className="settings-section-title">{t("settings.rail.title")}</div>
              <div className="rail-icons-setting">
                <p>{t("settings.rail.description")}</p>
                <div className="rail-icons-grid">
                  {RAIL_SETTINGS.map(({ id, labelKey, icon }) => (
                    <label
                      key={id}
                      className={`rail-icon-option ${railVisibility[id] ? "active" : ""}`}
                    >
                      <span className="rail-icon-option-icon">{icon}</span>
                      <span className="rail-icon-option-label">{t(labelKey)}</span>
                      <input
                        type="checkbox"
                        checked={railVisibility[id]}
                        onChange={(event) => setRailItemVisible(id, event.target.checked)}
                      />
                    </label>
                  ))}
                </div>
                <span className="rail-icons-note">{t("settings.rail.note")}</span>
              </div>
            </>
          )}
          {section === "appearance" && (
          <>
          <div className="settings-section-title">{t("theme.title")}</div>
          <div className="theme-grid">
            {BUILT_IN_THEMES.map((item) => (
              <div key={item.id} className={`theme-card ${item.id === theme ? "selected" : ""}`}>
                <div className="theme-preview-wrap">
                  <button
                    className="theme-preview"
                    onClick={() => setTheme(item.id)}
                    style={{
                      background: item.term.background as string,
                      borderColor: item.colors.border,
                      borderRadius: item.radius.lg,
                    }}
                  >
                    <span className="theme-preview-side" style={{ background: item.colors.bg2 }} />
                    <span className="theme-preview-dot" style={{ background: item.colors.accent }} />
                    <span className="theme-preview-line lg" style={{ background: item.colors.fg }} />
                    <span className="theme-preview-line" style={{ background: item.colors.fgDim }} />
                    <span className="theme-preview-line sm" style={{ background: item.colors.fgDim }} />
                  </button>
                </div>
                <span className="theme-card-name">{item.name}</span>
              </div>
            ))}
          </div>

          <div className="settings-section-title custom-themes-head">
            <span>
              {t("theme.custom")} <span className="codex-themes-hint">~/.codexthemes</span>
            </span>
            <span className="custom-themes-actions">
              <button
                className="ws-dialog-btn"
                title={t("theme.openFolder")}
                onClick={() => void revealThemesFolder()}
              >
                <RevealFolderIcon />
              </button>
              <button
                className="ws-dialog-btn"
                title={THEMES_SITE}
                onClick={() => void openExternal(THEMES_SITE)}
              >
                <ExternalOpenIcon /> {t("theme.browse")}
              </button>
            </span>
          </div>
          {importError && <div className="ai-theme-error">{importError}</div>}
          {codexThemesLoading ? (
            <div className="custom-themes-status">{t("theme.loading")}</div>
          ) : codexThemesError ? (
            <div className="custom-themes-status custom-themes-load-error">
              <span>{t("theme.loadFailed", { error: codexThemesError })}</span>
              <button className="ws-dialog-btn" onClick={() => setCodexThemesReload((value) => value + 1)}>
                {t("theme.retry")}
              </button>
            </div>
          ) : codexThemes.length === 0 ? (
            <div className="custom-themes-empty">
              {emptyBefore}
              <button className="link-btn" onClick={() => void openExternal(THEMES_SITE)}>
                {THEMES_SITE_LABEL}
              </button>
              {emptyAfter}
            </div>
          ) : (
            <>
              <div className="codex-theme-grid">
                {codexThemes.map((item) => {
                  const active = theme === codexThemeId(item.manifest.id);
                  const shot = item.previewPath ?? item.artPath;
                  return (
                    <button
                      key={item.manifest.id}
                      type="button"
                      className={`codex-theme-card ${active ? "selected" : ""}`}
                      disabled={applyingCodex !== null}
                      onClick={() => void applyCodexTheme(item)}
                    >
                      {shot && (
                        <img
                          className="codex-theme-shot"
                          src={apiPath(`/api/fs/media?path=${encodeURIComponent(shot)}`)}
                          alt=""
                          loading="lazy"
                        />
                      )}
                      <div className="codex-theme-body">
                        <div className="codex-theme-title">
                          <span className="codex-theme-name">{item.manifest.displayName ?? item.manifest.id}</span>
                          <span className="codex-theme-mode">
                            {t(item.manifest.mode === "dark" ? "theme.mode.dark" : "theme.mode.light")}
                          </span>
                        </div>
                        {item.manifest.description && (
                          <div className="codex-theme-desc">{item.manifest.description}</div>
                        )}
                        {(active || applyingCodex === item.manifest.id) && (
                          <div className="codex-theme-actions">
                            <span className="codex-theme-active">
                              {t(applyingCodex === item.manifest.id ? "theme.applying" : "theme.active")}
                            </span>
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className="settings-section-title font-settings-title">{t("font.title")}</div>

          <div className="font-setting">
            <span>{t("font.family")}</span>
            <div className="font-family-control">
              <div className="font-family-picker">
                <UsageSelect
                  value={customFontFamily ? CUSTOM_FONT_FAMILY : fontConfig.family}
                  width={240}
                  options={[
                    {
                      value: DEFAULT_FONT_CONFIG.family,
                      label: t("font.default", { font: FONT_FAMILY_PRESETS[0].label }),
                    },
                    ...FONT_FAMILY_PRESETS.slice(1),
                    { value: CUSTOM_FONT_FAMILY, label: t("font.custom") },
                  ]}
                  onChange={(value) => {
                    if (value === CUSTOM_FONT_FAMILY) {
                      setCustomFontFamily(true);
                      return;
                    }
                    const next = { ...fontConfig, family: value };
                    setCustomFontFamily(false);
                    setFontConfig(next);
                    saveFontConfig(next);
                    applyFontFamily(value);
                  }}
                />
                <button
                  className="font-size-reset"
                  disabled={fontConfig.family === DEFAULT_FONT_CONFIG.family && !customFontFamily}
                  onClick={() => {
                    const next = { ...fontConfig, family: DEFAULT_FONT_CONFIG.family };
                    setCustomFontFamily(false);
                    setFontConfig(next);
                    saveFontConfig(next);
                    applyFontFamily(next.family);
                  }}
                >
                  {t("font.reset")}
                </button>
              </div>
              {customFontFamily && (
                <input
                  className="font-family-input"
                  type="text"
                  autoFocus
                  spellCheck={false}
                  placeholder={DEFAULT_FONT_CONFIG.family}
                  value={fontConfig.family}
                  onChange={(e) => {
                    const next = { ...fontConfig, family: e.target.value };
                    setFontConfig(next);
                  }}
                  onBlur={(e) => {
                    const family = e.target.value.trim() || DEFAULT_FONT_CONFIG.family;
                    const next = { ...fontConfig, family };
                    setCustomFontFamily(!isPresetFontFamily(family));
                    setFontConfig(next);
                    saveFontConfig(next);
                    applyFontFamily(family);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              )}
            </div>
          </div>

          <div className="font-setting">
            <span>{t("font.size")}</span>
            <div className="font-size-control">
              <button
                className="font-size-btn"
                disabled={fontConfig.size <= MIN_FONT_SIZE}
                onClick={() => {
                  const next = { ...fontConfig, size: fontConfig.size - 1 };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                −
              </button>
              <span className="font-size-value">{fontConfig.size}px</span>
              <button
                className="font-size-btn"
                disabled={fontConfig.size >= MAX_FONT_SIZE}
                onClick={() => {
                  const next = { ...fontConfig, size: fontConfig.size + 1 };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                +
              </button>
              <button
                className="font-size-reset"
                disabled={fontConfig.size === DEFAULT_FONT_CONFIG.size}
                onClick={() => {
                  const next = { ...fontConfig, size: DEFAULT_FONT_CONFIG.size };
                  setFontConfig(next);
                  saveFontConfig(next);
                  applyFontSize(next.size);
                }}
              >
                {t("font.reset")}
              </button>
            </div>
          </div>
          </>
          )}
          {section === "about" && (
            <>
              <div className="settings-section-title">{t("about.title")}</div>
              <div className="about">
                <div className="about-hero">
                  <img className="about-logo" src="/favicon.png" alt="" />
                  <div className="about-hero-meta">
                    <div className="about-name">Termany</div>
                    <div className="about-version">
                      {t("about.version")} {version}
                    </div>
                  </div>
                </div>
                {isTauri && (
                  <div className="about-update">
                    {updateVersion ? (
                      updPhase === "downloading" ? (
                        <div className="update-progress">
                          <div className="update-progress-track">
                            <div className="update-progress-fill" style={{ width: `${updPct}%` }} />
                          </div>
                          <span>
                            {t("about.downloading")} {updPct}%
                          </span>
                        </div>
                      ) : updPhase === "restarting" ? (
                        <span className="update-status">{t("about.restarting")}</span>
                      ) : updPhase === "waiting" ? (
                        <span className="update-status">
                          {t("about.waitingForTasks", { count: runningTasks })}
                        </span>
                      ) : updPhase === "ready" ? (
                        <button className="update-btn" onClick={finishUpdate}>
                          {t("about.restartReady")}
                        </button>
                      ) : (
                        <button className="update-btn" onClick={applyUpdate}>
                          {t("about.updateRestart", { version: updateVersion })}
                        </button>
                      )
                    ) : (
                      <button
                        className="update-check-btn"
                        onClick={checkUpdates}
                        disabled={updPhase === "checking"}
                      >
                        {updPhase === "checking"
                          ? t("about.checking")
                          : updPhase === "none"
                            ? t("about.upToDate")
                            : t("about.checkUpdates")}
                      </button>
                    )}
                    {updError && (
                      <div className="ai-theme-error">
                        {t("about.updateFailed")}: {updError}
                      </div>
                    )}
                  </div>
                )}
                <p className="about-desc">{t("about.desc")}</p>
                <div className="about-links">
                  {ABOUT_LINKS.map(({ key, url }) => (
                    <button
                      className="about-link-row"
                      key={key}
                      title={t("about.open")}
                      onClick={async () => setAboutError(await openExternal(url))}
                    >
                      <span>{t(`about.${key}`)}</span>
                      <ExternalOpenIcon />
                    </button>
                  ))}
                </div>
                {aboutError && (
                  <div className="ai-theme-error">
                    {t("about.openerFailed")}: {aboutError}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

    </div>
  );
}
