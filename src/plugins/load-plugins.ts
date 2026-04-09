import path from "node:path";
import type { CypwPlugin } from "./types";

export async function loadPlugins(projectRoot: string, pluginModules: string[]): Promise<CypwPlugin[]> {
  const plugins: CypwPlugin[] = [];

  for (const pluginModule of pluginModules) {
    const resolvedPath = path.isAbsolute(pluginModule)
      ? pluginModule
      : path.resolve(projectRoot, pluginModule);

    let loaded: any;
    try {
      // Try ESM import first
      loaded = await import(resolvedPath);
    } catch {
      // Fall back to CJS require
      loaded = require(resolvedPath);
    }

    const candidate = (loaded.default ?? loaded) as CypwPlugin;
    if (!candidate?.name) {
      throw new Error(`Plugin at ${resolvedPath} does not export a valid cypw plugin.`);
    }

    plugins.push(candidate);
  }

  return plugins;
}
