import { Node, type MethodDeclaration, type SourceFile } from "ts-morph";
import type { MethodIR, PageObjectIR } from "../ir/types";
import type { CompilerRuntime } from "../shared/runtime";
import type { FileAnalysis } from "../shared/types";
import { createIssue, createTransformState, getHelperImportsNeedingPage, getPageObjectClassNames } from "./transform-utils";
import { translateStatements } from "./cypress-command-transformer";
import type { TransformContext } from "./transform-utils";

function createContext(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): TransformContext {
  return {
    runtime,
    sourceFile,
    pageIdentifier: "this.page",
    requestIdentifier: "request",
    loadFixtureIdentifier: "loadFixture",
    runTaskIdentifier: "runTask",
    migrationStateIdentifier: "migrationState",
    fileAnalysis: analysis,
    pluginHits: new Set<string>(),
    helperCallNamesNeedingPage: getHelperImportsNeedingPage(sourceFile, runtime),
    pageObjectClassNames: getPageObjectClassNames(runtime),
    state: createTransformState(),
    controlFlowDepth: 0,
    hoistedAliases: new Map()
  };
}

function transformMethod(method: MethodDeclaration, context: TransformContext): MethodIR {
  const body = method.getBody();
  if (!body) {
    return {
      name: method.getName(),
      parameters: method.getParameters().map((parameter) => parameter.getText()),
      body: { statements: [], issues: [] },
      isAsync: method.isAsync(),
      isGetter: false,
      returnType: method.getReturnTypeNode()?.getText()
    };
  }

  const statements = Node.isBlock(body) ? translateStatements(body, context) : [];
  return {
    name: method.getName(),
    parameters: method.getParameters().map((parameter) => parameter.getText()),
    body: {
      statements,
      issues: statements.flatMap((statement) => statement.issues)
    },
    isAsync: method.isAsync() || statements.some((statement) => statement.code.includes("await ")),
    isGetter: false,
    returnType: method.getReturnTypeNode()?.getText()
  };
}

export function transformPageObject(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): PageObjectIR {
  const outputPath = runtime.pathResolution.sourceToOutput.get(sourceFile.getFilePath());
  if (!outputPath) {
    throw new Error(`No output path resolved for page object ${sourceFile.getFilePath()}`);
  }

  const context = createContext(runtime, sourceFile, analysis);
  const classDeclaration = sourceFile.getClasses()[0];
  if (!classDeclaration) {
    throw new Error(`Expected a class-based page object in ${sourceFile.getFilePath()}`);
  }

  const className = classDeclaration.getName() ?? sourceFile.getBaseNameWithoutExtension();
  const methods: MethodIR[] = [];

  for (const method of classDeclaration.getMethods()) {
    if (method.getName() === "constructor") {
      continue;
    }
    methods.push(transformMethod(method, context));
  }

  for (const getter of classDeclaration.getGetAccessors()) {
    const body = getter.getBody();
    const statements = body && Node.isBlock(body) ? translateStatements(body, context) : [];
    methods.push({
      name: getter.getName(),
      parameters: [],
      body: {
        statements,
        issues: statements.flatMap((statement) => statement.issues)
      },
      isAsync: false,
      isGetter: true,
      returnType: getter.getReturnTypeNode()?.getText() ?? "unknown"
    });
  }

  const issues = methods.flatMap((method) => method.body.issues);
  if (classDeclaration.getProperties().length > 0) {
    issues.push(
      createIssue(
        classDeclaration,
        sourceFile.getFilePath(),
        "page-property-review",
        "Page-object properties were preserved implicitly; review stateful properties manually.",
        "info"
      )
    );
  }

  return {
    kind: "page-object",
    sourcePath: sourceFile.getFilePath(),
    outputPath,
    className,
    methods,
    issues,
    pluginHits: [...context.pluginHits]
  };
}
