/**
 * Shell arguments for a pane that should run a specific command instead of
 * dropping the user at an interactive prompt.
 *
 * The important difference from the interactive path is what gets sourced.
 * On POSIX, `-l -c` is a LOGIN but NON-interactive shell: it still runs
 * ~/.zprofile (PATH, Homebrew, fnm, pyenv, …) so the command resolves the same
 * way it would in the user's terminal, but it skips ~/.zshrc.
 *
 * Skipping ~/.zshrc is the point, not an accident. That file is where aliases
 * and shell functions live, so an interactive pane running `foo` may really be
 * running the user's wrapper around `foo`. A caller that asks for a specific
 * command wants that command. (The interactive path keeps ~/.zshrc precisely
 * because a human at a prompt does want their aliases.)
 */
export function shellArgsForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  windowsPromptHook = "",
): string[] {
  if (platform === "win32") {
    const script = windowsPromptHook ? `${windowsPromptHook}\n${command}` : command;
    return ["-NoLogo", "-NoProfile", "-Command", script];
  }
  return ["-l", "-c", command];
}
