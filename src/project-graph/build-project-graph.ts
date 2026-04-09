import type { SourceFile } from "ts-morph";
import type { ProjectDiscovery, ProjectGraph } from "../shared/types";

export function buildProjectGraph(
  discovery: ProjectDiscovery,
  sourceFileMap: Map<string, SourceFile>
): ProjectGraph {
  const nodes: ProjectGraph["nodes"] = {};

  for (const file of discovery.allFiles) {
    nodes[file.path] = {
      path: file.path,
      category: file.category,
      dependencies: [],
      dependents: []
    };
  }

  for (const file of discovery.allFiles) {
    const sourceFile = sourceFileMap.get(file.path);
    if (!sourceFile) {
      continue;
    }

    for (const importDeclaration of sourceFile.getImportDeclarations()) {
      const dependency = importDeclaration.getModuleSpecifierSourceFile();
      if (!dependency) {
        continue;
      }

      const dependencyPath = dependency.getFilePath();
      if (!nodes[dependencyPath]) {
        continue;
      }

      nodes[file.path].dependencies.push(dependencyPath);
      nodes[dependencyPath].dependents.push(file.path);
    }
  }

  return { nodes };
}
