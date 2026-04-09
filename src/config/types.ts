export interface CustomCommandMapping {
  target: string;
  importPath?: string;
  includePageArgument?: boolean;
  isAsync?: boolean;
  notes?: string;
}

export interface WrapperMapping {
  target: string;
  importPath?: string;
  notes?: string;
}

export interface WrapperMapConfig {
  aliasHelpers?: string[];
  mappings: Record<string, WrapperMapping>;
}

export interface TaskMapping {
  handlerImport?: string;
  exportName?: string;
  notes?: string;
}

export interface PomRules {
  preserve: string[];
  upgrade: string[];
  regenerate: string[];
}

export interface ReportingConfig {
  unresolvedThreshold: number;
  inlineTodoPrefix: string;
  strictControlFlow: boolean;
  maxBestEffortDepth: number;
}

export interface TypeFallbackConfig {
  externalModulesAsAny: boolean;
}

export type LocatorStrategy = "css" | "testid" | "semantic";

export interface CypwConfig {
  version: string;
  sourceRoots: string[];
  specGlobs: string[];
  supportFile?: string;
  tsconfigPath?: string;
  outputRoot: string;
  customCommandMap: Record<string, CustomCommandMapping>;
  wrapperMap: WrapperMapConfig;
  taskMap: Record<string, TaskMapping>;
  interceptPolicies: Record<string, string>;
  pomRules: PomRules;
  pluginModules: string[];
  runtimeRecipeModules?: string[];
  typeFallbacks?: TypeFallbackConfig;
  reporting: ReportingConfig;
  locatorStrategy?: LocatorStrategy;
  envMapping?: Record<string, string>;
  copyFixtures?: boolean;
  generateGlobalSetup?: boolean;
}

export interface LoadedConfig {
  projectRoot: string;
  configPath: string;
  config: CypwConfig;
}
