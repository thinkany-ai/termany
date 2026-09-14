import path from "node:path";

/** Chat agents use the server's Node (bundled in the desktop app). Keep the
 * user's remaining PATH for their CLIs, Bun, Python, and other subprocesses.
 * Terminal panes deliberately keep their own shell environment. */
export function agentEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  // Windows environment keys are case-insensitive; avoid passing both Path
  // and PATH, since Node may otherwise choose the one without our runtime.
  const pathKey = process.platform === "win32"
    ? Object.keys(env).find((key) => key.toUpperCase() === "PATH")
    : "PATH";
  const currentPath = pathKey ? env[pathKey] : undefined;
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
  }
  const nodeDirectory = path.dirname(process.execPath);
  const directories = currentPath ? currentPath.split(path.delimiter) : [];
  env.PATH = [nodeDirectory, ...directories.filter((directory) => directory !== nodeDirectory)].join(path.delimiter);
  return env;
}
