import { analyzeProject } from "../analysis/analyze-project";
import { loadConfig } from "../config/load-config";
import { discoverProject } from "../discovery/discover-project";
import { loadPlugins } from "../plugins/load-plugins";
import { buildProjectGraph } from "../project-graph/build-project-graph";
import { buildPathResolution } from "../shared/path-resolution";
import type { CompilerRuntime } from "../shared/runtime";

export async function createRuntime(projectRoot: string, configPath?: string): Promise<CompilerRuntime> {
  const loadedConfig = await loadConfig(projectRoot, configPath);
  const discoveryRuntime = await discoverProject(projectRoot, loadedConfig.config);
  const plugins = await loadPlugins(
    projectRoot,
    [...loadedConfig.config.pluginModules, ...(loadedConfig.config.runtimeRecipeModules ?? [])]
  );

  const runtime: CompilerRuntime = {
    projectRoot,
    configPath: loadedConfig.configPath,
    config: loadedConfig.config,
    project: discoveryRuntime.project,
    sourceFileMap: discoveryRuntime.sourceFileMap,
    discovery: discoveryRuntime.discovery,
    graph: buildProjectGraph(discoveryRuntime.discovery, discoveryRuntime.sourceFileMap),
    plugins,
    pathResolution: buildPathResolution({
      projectRoot,
      config: loadedConfig.config,
      discovery: discoveryRuntime.discovery
    })
  };

  runtime.analysis = analyzeProject(runtime);
  return runtime;
}
