import type { Project, SourceFile } from "ts-morph";
import type { CypwConfig } from "../config/types";
import type { CypwPlugin } from "../plugins/types";
import type { ProjectAnalysis, ProjectDiscovery, ProjectGraph } from "./types";

export interface PathResolution {
  sourceToOutput: Map<string, string>;
  outputToSource: Map<string, string>;
}

export interface CompilerRuntime {
  projectRoot: string;
  configPath: string;
  config: CypwConfig;
  project: Project;
  sourceFileMap: Map<string, SourceFile>;
  discovery: ProjectDiscovery;
  graph: ProjectGraph;
  plugins: CypwPlugin[];
  pathResolution: PathResolution;
  analysis?: ProjectAnalysis;
}
