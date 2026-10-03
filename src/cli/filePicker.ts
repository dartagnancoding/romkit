/**
 * Windows "Select folder" / "Open file" dialogs for a terminal program.
 *
 * Runs a small PowerShell script (Windows Forms) and reads the chosen path from
 * its output. PowerShell 7 shows the modern folder dialog; Windows PowerShell 5.1
 * the older tree one. Arguments go through environment variables, so paths with
 * quotes or spaces need no escaping.
 */

import { logger } from "../logging/logger";

export interface PickFileOptions {
  title: string;
  /** Windows Forms filter, e.g. "7-Zip|7z.exe|All files|*.*". */
  filter?: string;
  initialPath?: string;
}

const COMMON_SETUP = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
# An invisible topmost owner keeps the dialog in front of the terminal.
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
`;

const FOLDER_SCRIPT = `${COMMON_SETUP}
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:ROMKIT_PICK_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:ROMKIT_PICK_INITIAL -and (Test-Path -LiteralPath $env:ROMKIT_PICK_INITIAL)) { $dialog.SelectedPath = $env:ROMKIT_PICK_INITIAL }
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
`;

const FILE_SCRIPT = `${COMMON_SETUP}
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:ROMKIT_PICK_TITLE
$dialog.Filter = $env:ROMKIT_PICK_FILTER
$initial = $env:ROMKIT_PICK_INITIAL
if ($initial) {
  if (Test-Path -LiteralPath $initial -PathType Container) { $dialog.InitialDirectory = $initial }
  elseif (Test-Path -LiteralPath $initial) { $dialog.InitialDirectory = Split-Path -LiteralPath $initial; $dialog.FileName = Split-Path -Leaf $initial }
}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
`;

/** True where the dialogs exist. */
export function canPickWithDialog(): boolean {
  return process.platform === "win32" && powerShellExecutable() !== null;
}

/** Opens the folder dialog; null when cancelled or unavailable. */
export function pickFolder(title: string, initialPath?: string): Promise<string | null> {
  return runDialog(FOLDER_SCRIPT, { ROMKIT_PICK_TITLE: title, ROMKIT_PICK_INITIAL: initialPath ?? "" });
}

/** Opens the file dialog; null when cancelled or unavailable. */
export function pickFile(options: PickFileOptions): Promise<string | null> {
  return runDialog(FILE_SCRIPT, {
    ROMKIT_PICK_TITLE: options.title,
    ROMKIT_PICK_FILTER: options.filter ?? "All files|*.*",
    ROMKIT_PICK_INITIAL: options.initialPath ?? "",
  });
}

async function runDialog(script: string, variables: Record<string, string>): Promise<string | null> {
  const executable = powerShellExecutable();
  if (process.platform !== "win32" || !executable) return null;
  // -STA: Windows Forms dialogs need a single-threaded apartment.
  const child = Bun.spawn([executable, "-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
    env: { ...process.env, ...variables },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errorText, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    logger.warn("Could not open the Windows dialog; type the path instead.");
    logger.debug(errorText.trim());
    return null;
  }
  const chosenPath = output.trim();
  return chosenPath === "" ? null : chosenPath;
}

/** PowerShell 7 (modern folder dialog) when installed, else the built-in Windows PowerShell. */
function powerShellExecutable(): string | null {
  return Bun.which("pwsh") ?? Bun.which("powershell");
}

export const PICKER_SCRIPTS_FOR_TESTS = { FOLDER_SCRIPT, FILE_SCRIPT };
