/** File system helpers used across modules. */

import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export type TransferMode = "move" | "copy";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Lists every file (not folder) under a directory, at any depth. */
export async function listFilesRecursive(directory: string): Promise<string[]> {
  const collectedFiles: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectedFiles.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      collectedFiles.push(entryPath);
    }
  }
  return collectedFiles;
}

/** Lists files directly inside a directory (no subfolders). */
export async function listFilesShallow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
}

/**
 * Moves or copies a file.
 * A plain rename fails across drives (EXDEV, e.g. %TEMP% on C: → library on E:),
 * so moves fall back to copy + delete in that case.
 */
export async function transferFile(sourcePath: string, targetPath: string, mode: TransferMode): Promise<void> {
  if (mode === "copy") {
    await copyFile(sourcePath, targetPath);
    return;
  }
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(sourcePath, targetPath);
    await unlink(sourcePath);
  }
}

/** Windows paths are case-insensitive: "E:\ROM\a.gba" and "e:\rom\A.GBA" are the same file. */
export function isSamePath(firstPath: string, secondPath: string): boolean {
  return resolve(firstPath).toLowerCase() === resolve(secondPath).toLowerCase();
}

/** "Mega Man.gba" → "Mega Man" */
export function fileStem(filePath: string): string {
  const name = basename(filePath);
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** "Mega Man.GBA" → ".gba" */
export function lowercaseExtension(filePath: string): string {
  return extname(filePath).toLowerCase();
}
