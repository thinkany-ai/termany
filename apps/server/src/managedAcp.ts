import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { agentEnvironment } from "./agentEnvironment.js";
import type { AgentConfig } from "./agentConfig.js";
import { resolveExecutable } from "./shellPath.js";

type ManagedAcpDefinition = {
  packageName: string;
  packageEntry: string;
  bundleName: string;
  cliEnvironmentVariable: "CLAUDE_CODE_EXECUTABLE" | "CODEX_PATH";
};

const DEFINITIONS: Record<string, ManagedAcpDefinition> = {
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    packageEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    bundleName: "claude-agent-acp.mjs",
    cliEnvironmentVariable: "CLAUDE_CODE_EXECUTABLE",
  },
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    packageEntry: "@agentclientprotocol/codex-acp",
    bundleName: "codex-acp.mjs",
    cliEnvironmentVariable: "CODEX_PATH",
  },
};

export type ManagedAcpLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  adapterPath: string;
  cliPath: string;
};

export function managedAcpDefinition(agentId: string): ManagedAcpDefinition | undefined {
  return DEFINITIONS[agentId];
}

/** Resolve the packaged bridge in production and its npm dependency in dev. */
export function managedAcpAdapterPath(agentId: string): string | undefined {
  const definition = managedAcpDefinition(agentId);
  if (!definition) return undefined;

  const bundled = path.join(path.dirname(process.execPath), "acp", definition.bundleName);
  if (fs.existsSync(bundled)) return bundled;

  try {
    const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
    return requireFromCwd.resolve(definition.packageEntry);
  } catch {
    return undefined;
  }
}

/**
 * A managed bridge belongs to Termany, while the authenticated agent CLI
 * belongs to the user. Point the bridge at that exact CLI so its optional npm
 * dependency never downloads or launches a duplicate vendor binary.
 */
export async function prepareManagedAcpLaunch(
  agent: AgentConfig,
  baseEnv: NodeJS.ProcessEnv,
  adapterArgs: string[] = []
): Promise<ManagedAcpLaunch> {
  const definition = managedAcpDefinition(agent.id);
  if (!definition) throw new Error(`Termany has no managed ACP bridge for ${agent.name}`);

  const cliPath = await resolveExecutable(agent.command);
  if (!cliPath) throw new Error(`${agent.name} is not installed. Install its CLI first, then detect it again.`);

  const adapterPath = managedAcpAdapterPath(agent.id);
  if (!adapterPath) throw new Error(`Termany's ${agent.name} ACP bridge is missing. Reinstall or update Termany.`);

  return {
    command: process.execPath,
    args: [adapterPath, ...adapterArgs],
    adapterPath,
    cliPath,
    env: {
      ...agentEnvironment(baseEnv),
      [definition.cliEnvironmentVariable]: cliPath,
    },
  };
}
