export const TOGGLE_WORKSPACE_SWITCHER_EVENT = "termany:toggle-workspace-switcher";

/** Toggles the shared workspace menu from any navigation entry point. */
export function toggleWorkspaceSwitcher() {
  window.dispatchEvent(new Event(TOGGLE_WORKSPACE_SWITCHER_EVENT));
}
