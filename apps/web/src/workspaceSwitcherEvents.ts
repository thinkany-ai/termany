export const TOGGLE_WORKSPACE_SWITCHER_EVENT = "termany:toggle-workspace-switcher";

/** Toggles the shared workspace menu from any navigation entry point. */
export function toggleWorkspaceSwitcher() {
  window.dispatchEvent(new Event(TOGGLE_WORKSPACE_SWITCHER_EVENT));
}

export const OPEN_WORKSPACE_IMPORT_EVENT = "termany:open-workspace-import";

/** Opens the "import workspace" dialog with `deviceId` already picked. */
export function openWorkspaceImport(deviceId: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_WORKSPACE_IMPORT_EVENT, { detail: deviceId }));
}
