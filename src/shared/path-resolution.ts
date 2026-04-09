import path from "node:path";
import type { CompilerRuntime, PathResolution } from "./runtime";
import type { DiscoveredFile } from "./types";

function getRelativeFromAnchor(filePath: string, anchor: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const marker = `/${anchor}/`;
  const index = normalizedFilePath.lastIndexOf(marker);

  if (index >= 0) {
    return normalizedFilePath.slice(index + marker.length);
  }

  return path.basename(filePath);
}

function toTypeScriptPath(relativePath: string): string {
  return relativePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ".ts");
}

function getOutputRelativePath(file: DiscoveredFile): string | undefined {
  switch (file.category) {
    case "spec":
      return toTypeScriptPath(path.join("tests", getRelativeFromAnchor(file.path, "e2e")));
    case "page-object":
      return toTypeScriptPath(path.join("page-objects", getRelativeFromAnchor(file.path, "page-objects")));
    case "support":
      return toTypeScriptPath(path.join("support", getRelativeFromAnchor(file.path, "support")));
    case "helper":
      return toTypeScriptPath(path.join("helpers", path.basename(file.path)));
    case "other":
      if (file.metadata.hasCypress) {
        return toTypeScriptPath(path.join("helpers", path.basename(file.path)));
      }

      return toTypeScriptPath(path.join("misc", path.basename(file.path)));
    default:
      return undefined;
  }
}

export function buildPathResolution(runtime: Pick<CompilerRuntime, "config" | "discovery" | "projectRoot">): PathResolution {
  const sourceToOutput = new Map<string, string>();
  const outputToSource = new Map<string, string>();

  for (const file of runtime.discovery.allFiles) {
    const outputRelativePath = getOutputRelativePath(file);
    if (!outputRelativePath) {
      continue;
    }

    const absoluteOutputPath = path.resolve(runtime.projectRoot, runtime.config.outputRoot, outputRelativePath);
    sourceToOutput.set(file.path, absoluteOutputPath);
    outputToSource.set(absoluteOutputPath, file.path);
  }

  return {
    sourceToOutput,
    outputToSource
  };
}
