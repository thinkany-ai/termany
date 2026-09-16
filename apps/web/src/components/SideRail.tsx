import { useEffect, useRef } from "react";
import { agentCommand, type AgentConfig, useAgentConfigs } from "../agents";
import { useI18n } from "../i18n";
import { withShortcut } from "../keybindings";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { activeHtab, useStore, type PaneView } from "../state/store";
import { queueCommand } from "../terminal/manager";
import {
  ActivityIcon,
  AgentIcon,
  ChartIcon,
  ChatIcon,
  FilesIcon,
  GearIcon,
  GitBranchIcon,
  HistoryIcon,
  ProviderIcon,
  TerminalIcon,
  WebIcon,
} from "./icons";

const AGENT_MENU_OCCLUDER_ID = "side-rail-agent-menu";

/** One entry per pane kind this rail can quick-create. */
const RAIL_ITEMS: Array<{ view: PaneView; icon: () => JSX.Element }> = [
  { view: "terminal", icon: TerminalIcon },
  { view: "files", icon: FilesIcon },
  { view: "git", icon: GitBranchIcon },
  { view: "agent", icon: ChatIcon },
  { view: "web", icon: WebIcon },
  { view: "monitor", icon: ActivityIcon },
];

/** Dashboard shortcuts stay below the agent launcher, matching the rail's
 * existing visual order, but use the same new-pane path as every item above. */
const DASHBOARD_RAIL_ITEMS: Array<{ view: PaneView; icon: () => JSX.Element }> = [
  { view: "history", icon: HistoryIcon },
  { view: "usage", icon: ChartIcon },
  { view: "providers", icon: ProviderIcon },
];

/**
 * Workspace-level quick-action rail, sitting beside the pane card (like the
 * left sidebar's page tree, but for panes). Not tied to any one pane — each
 * button splits the currently focused pane and opens a fresh one directly in
 * that view, instead of switching an existing pane's view in place (that's
 * still the per-pane header button, toggled via togglePaneView). The settings
 * button is pinned to the bottom (margin-top: auto) so it stays reachable
 * regardless of how many quick-create buttons sit above it.
 */
export function SideRail({
  agentsOpen,
  onAgentsOpenChange,
  onOpenSettings,
  onOpenAgentsSettings,
}: {
  agentsOpen: boolean;
  onAgentsOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
  onOpenAgentsSettings: () => void;
}) {
  const addPane = useStore((s) => s.addPane);
  const setPaneView = useStore((s) => s.setPaneView);
  const setAgentRuntime = useStore((s) => s.setAgentRuntime);
  const railVisibility = useStore((s) => s.railVisibility);
  const { t } = useI18n();
  const agents = useAgentConfigs().filter((agent) => agent.enabled || agent.runtime);
  const agentsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentsOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!agentsRef.current?.contains(event.target as Node)) onAgentsOpenChange(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [agentsOpen, onAgentsOpenChange]);

  useEffect(() => {
    if (!railVisibility.agents && agentsOpen) onAgentsOpenChange(false);
  }, [agentsOpen, onAgentsOpenChange, railVisibility.agents]);


  // Only blanks the web/office preview pane(s) this dropdown actually
  // overlaps, not every native webview in the workspace (see nativeViewOcclusion).
  useEffect(() => {
    if (!agentsOpen) return;
    const el = menuRef.current;
    if (!el) return;
    const update = () => registerOccluder(AGENT_MENU_OCCLUDER_ID, el.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      unregisterOccluder(AGENT_MENU_OCCLUDER_ID);
    };
  }, [agentsOpen]);

  const runAgent = (agent: AgentConfig) => {
    const paneId = addPane("terminal", agent.id);
    const command = agentCommand(agent);
    if (paneId && command) queueCommand(paneId, command);
    onAgentsOpenChange(false);
  };

  const openAgent = (agent: AgentConfig) => {
    if (!agent.runtime) {
      runAgent(agent);
      return;
    }
    const paneId = addPane("agent", agent.name);
    if (paneId) setAgentRuntime(paneId, agent.id);
    onAgentsOpenChange(false);
  };

  const openAgentSettings = () => {
    onAgentsOpenChange(false);
    onOpenAgentsSettings();
  };

  const openPane = (view: PaneView) => {
    const paneId = addPane(view);
    if (paneId) return;
    const focused = activeHtab(useStore.getState())?.focused;
    if (focused) setPaneView(focused, view);
  };

  return (
    <div className="side-rail">
      {RAIL_ITEMS.filter(({ view }) => railVisibility[view]).map(({ view, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={t("rail.newPane", { view: t(`pane.view.${view}`) })} onClick={() => openPane(view)}>
          <Icon />
        </button>
      ))}
      {railVisibility.agents && (
        <div className="side-rail-agent" ref={agentsRef}>
          <button
            className={`side-rail-btn ${agentsOpen ? "active" : ""}`}
            title={t("rail.runAgent")}
            onClick={() => onAgentsOpenChange(!agentsOpen)}
          >
            <AgentIcon />
          </button>
          {agentsOpen && (
            <div className="agent-menu" ref={menuRef}>
              {agents.map((agent) => (
                <div key={agent.id} className="agent-menu-entry">
                  <button className="agent-menu-item" onClick={() => openAgent(agent)}>
                    {agent.icon ? (
                      <img className="agent-menu-icon" src={agent.icon} alt="" aria-hidden="true" />
                    ) : (
                      <span className="agent-menu-icon fallback">
                        <AgentIcon />
                      </span>
                    )}
                    <span>{agent.name}</span>
                    {agent.runtime && <ChatIcon />}
                  </button>
                  {agent.runtime && agent.enabled && agentCommand(agent) && (
                    <button
                      className="agent-menu-terminal"
                      title={`${t("agents.openTerminal")}: ${agent.name}`}
                      onClick={() => runAgent(agent)}
                    >
                      <TerminalIcon />
                    </button>
                  )}
                </div>
              ))}
              {agents.length === 0 && <div className="agent-menu-empty">{t("agents.noEnabled")}</div>}
              <div className="agent-menu-separator" />
              <button className="agent-menu-item agent-menu-settings" onClick={openAgentSettings}>
                <GearIcon />
                <span>{t("agents.settings")}</span>
              </button>
            </div>
          )}
        </div>
      )}
      {DASHBOARD_RAIL_ITEMS.filter(({ view }) => railVisibility[view]).map(({ view, icon: Icon }) => (
        <button
          key={view}
          className="side-rail-btn"
          title={t("rail.newPane", { view: t(`pane.view.${view}`) })}
          onClick={() => openPane(view)}
        >
          <Icon />
        </button>
      ))}
      <button
        className="side-rail-btn side-rail-settings"
        title={withShortcut(t("workspace.settings"), "openSettings")}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}
