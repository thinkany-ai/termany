import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Escape a string into an AppleScript double-quoted literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Open the OS-native "choose files" dialog and return the picked absolute
 * paths, or null when the user cancels. Like pickFolder, the dialog belongs
 * to the machine the server runs on (Tauri shell or `pnpm dev:web`), so it
 * appears locally even when the UI itself lives in a browser tab.
 */
export async function pickFiles(prompt: string): Promise<string[] | null> {
  if (process.platform === "darwin") {
    const script = [
      `set chosenFiles to choose file with prompt ${appleScriptString(prompt)} with multiple selections allowed`,
      "set outList to {}",
      "if class of chosenFiles is list then",
      "  repeat with f in chosenFiles",
      "    set end of outList to POSIX path of f",
      "  end repeat",
      "else",
      "  set end of outList to POSIX path of chosenFiles",
      "end if",
      "set AppleScript's text item delimiters to linefeed",
      "return outList as text",
    ].join("\n");
    try {
      const pending = execFileAsync("osascript", ["-e", script], { timeout: 300_000 });
      execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to set frontmost of (first process whose name is "osascript") to true',
      ]).catch(() => undefined);
      const { stdout } = await pending;
      const paths = stdout.split("\n").map((p) => p.trim()).filter(Boolean);
      return paths.length ? paths : null;
    } catch (error) {
      const detail =
        error instanceof Error ? String((error as { stderr?: string }).stderr ?? error.message) : String(error);
      if (detail.includes("-128")) return null; // user canceled
      throw new Error(`File dialog failed: ${detail.trim()}`);
    }
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.OpenFileDialog;",
      "$d.Multiselect = $true;",
      `$d.Title = '${prompt.replace(/'/g, "''")}';`,
      "if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join [char]10 }",
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 300_000,
    });
    const paths = stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    return paths.length ? paths : null;
  }

  // Linux: best effort via zenity; a missing binary surfaces as a clear error.
  try {
    const args = ["--file-selection", "--multiple", "--separator=\n", `--title=${prompt}`];
    const { stdout } = await execFileAsync("zenity", args, { timeout: 300_000 });
    const paths = stdout.split("\n").map((p) => p.trim()).filter(Boolean);
    return paths.length ? paths : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 1) {
      return null; // canceled
    }
    throw new Error("File dialog needs zenity on this system");
  }
}
