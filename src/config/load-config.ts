import path from "node:path";
import { parse } from "jsonc-parser";
import { CYPW_CONFIG_FILENAME } from "../shared/constants";
import { pathExists, readTextFile, writeTextFile } from "../shared/fs";
import { createDefaultConfig } from "./default-config";
import type { CypwConfig, LoadedConfig } from "./types";

function mergeConfig(partial: Partial<CypwConfig>): CypwConfig {
  const defaults = createDefaultConfig();

  return {
    ...defaults,
    ...partial,
    customCommandMap: {
      ...defaults.customCommandMap,
      ...(partial.customCommandMap ?? {})
    },
    wrapperMap: {
      aliasHelpers: partial.wrapperMap?.aliasHelpers ?? defaults.wrapperMap.aliasHelpers,
      mappings: {
        ...defaults.wrapperMap.mappings,
        ...(partial.wrapperMap?.mappings ?? {})
      }
    },
    taskMap: {
      ...defaults.taskMap,
      ...(partial.taskMap ?? {})
    },
    interceptPolicies: {
      ...defaults.interceptPolicies,
      ...(partial.interceptPolicies ?? {})
    },
    pomRules: {
      ...defaults.pomRules,
      ...(partial.pomRules ?? {})
    },
    pluginModules: partial.pluginModules ?? defaults.pluginModules,
    runtimeRecipeModules: partial.runtimeRecipeModules ?? defaults.runtimeRecipeModules,
    typeFallbacks: {
      ...defaults.typeFallbacks,
      ...(partial.typeFallbacks ?? {})
    },
    reporting: {
      ...defaults.reporting,
      ...(partial.reporting ?? {})
    }
  };
}

export async function loadConfig(projectRoot: string, explicitConfigPath?: string): Promise<LoadedConfig> {
  const configPath = explicitConfigPath
    ? path.resolve(projectRoot, explicitConfigPath)
    : path.resolve(projectRoot, CYPW_CONFIG_FILENAME);

  if (!(await pathExists(configPath))) {
    throw new Error(`Config file not found at ${configPath}. Run "cypw init" first.`);
  }

  const raw = await readTextFile(configPath);
  const parsed = parse(raw) as Partial<CypwConfig>;

  return {
    projectRoot,
    configPath,
    config: mergeConfig(parsed)
  };
}

export async function writeDefaultConfig(projectRoot: string, explicitConfigPath?: string): Promise<string> {
  const configPath = explicitConfigPath
    ? path.resolve(projectRoot, explicitConfigPath)
    : path.resolve(projectRoot, CYPW_CONFIG_FILENAME);

  const defaultConfig = createDefaultConfig();
  const content = `${JSON.stringify(defaultConfig, null, 2)}\n`;
  await writeTextFile(configPath, content);
  return configPath;
}
