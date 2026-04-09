import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, content, "utf8");
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function emptyDirectory(dirPath: string): Promise<void> {
  if (await pathExists(dirPath)) {
    await rm(dirPath, { recursive: true, force: true });
  }

  await ensureDirectory(dirPath);
}

export function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}
