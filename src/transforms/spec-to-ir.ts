import path from "node:path";
import { Node, SyntaxKind, type CallExpression, type SourceFile, type Statement } from "ts-morph";
import type { BlockIR, HookIR, HoistedAliasIR, ImportBinding, SpecFileIR, StatementIR, SuiteIR, TestCaseIR } from "../ir/types";
import type { CompilerRuntime } from "../shared/runtime";
import type { FileAnalysis, MigrationIssue, SubjectKind } from "../shared/types";
import { normalizeImportPath } from "./transform-utils";
import {
  translateStatements,
  type TransformContext
} from "./cypress-command-transformer";
import {
  createTransformState,
  createIssue,
  createChildTransformContext,
  getHelperImportsNeedingPage,
  getPageObjectClassNames,
  getStringLiteralValue,
  tryParseCypressChain
} from "./transform-utils";

const HOOK_NAME_MAP: Record<string, HookIR["kind"]> = {
  before: "beforeAll",
  beforeEach: "beforeEach",
  after: "afterAll",
  afterEach: "afterEach"
};

function createTransformContext(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): TransformContext {
  return {
    runtime,
    sourceFile,
    pageIdentifier: "page",
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

function rewriteImportBindings(sourceFile: SourceFile, outputPath: string, runtime: CompilerRuntime): ImportBinding[] {
  const imports: ImportBinding[] = [];

  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    const moduleSpecifierValue = importDeclaration.getModuleSpecifierValue();
    if (moduleSpecifierValue === "cypress") {
      continue;
    }

    const resolvedSourceFile = importDeclaration.getModuleSpecifierSourceFile();
    const outputTargetPath = resolvedSourceFile
      ? runtime.pathResolution.sourceToOutput.get(resolvedSourceFile.getFilePath())
      : undefined;

    const moduleSpecifier = outputTargetPath
      ? normalizeImportPath(outputPath, outputTargetPath)
      : moduleSpecifierValue;

    imports.push({
      moduleSpecifier,
      sideEffectOnly:
        !importDeclaration.getDefaultImport() &&
        !importDeclaration.getNamespaceImport() &&
        importDeclaration.getNamedImports().length === 0,
      defaultImport: importDeclaration.getDefaultImport()?.getText(),
      namespaceImport: importDeclaration.getNamespaceImport()?.getText(),
      namedImports: importDeclaration.getNamedImports().map((namedImport) => namedImport.getName())
    });
  }

  return imports;
}

function transformBlock(statements: Statement[], context: TransformContext): BlockIR {
  const transformedStatements = statements.map((statement) => translateStatements(statement, context)).flat();
  return {
    statements: transformedStatements,
    issues: transformedStatements.flatMap((statement) => statement.issues)
  };
}

function getCallExpression(statement: Statement): CallExpression | undefined {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }

  const expression = statement.getExpression();
  return Node.isCallExpression(expression) ? expression : undefined;
}

function getCallBaseName(expression: Node): string {
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return getCallBaseName(expression.getExpression());
  if (Node.isCallExpression(expression)) return getCallBaseName(expression.getExpression());
  return expression.getText();
}

function getCallModifier(expression: Node): "skip" | "only" | undefined {
  if (Node.isPropertyAccessExpression(expression)) {
    const name = expression.getName();
    if (name === "skip" || name === "only") return name;
    return getCallModifier(expression.getExpression());
  }
  if (Node.isCallExpression(expression)) {
    return getCallModifier(expression.getExpression());
  }
  return undefined;
}

function createTestCase(callExpression: CallExpression, context: TransformContext): TestCaseIR | undefined {
  const [titleArg, callbackArg] = callExpression.getArguments();
  if (!titleArg || !callbackArg || !Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) {
    return undefined;
  }

  const title = titleArg.getText().replace(/["'`]/g, "");
  const body = callbackArg.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  return {
    title,
    body: transformBlock(statements, context),
    modifier: getCallModifier(callExpression.getExpression())
  };
}

function createHook(callExpression: CallExpression, context: TransformContext): HookIR | undefined {
  const callbackArg = callExpression.getArguments()[0];
  if (!callbackArg || !Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) {
    return undefined;
  }

  const body = callbackArg.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  const hookName = callExpression.getExpression().asKindOrThrow(SyntaxKind.Identifier).getText();

  return {
    kind: HOOK_NAME_MAP[hookName],
    body: transformBlock(statements, context)
  };
}

interface AliasDefinition {
  name: string;
  kind: "locator" | "value" | "intercept";
  node: CallExpression;
}

function getStringArgumentValue(callExpression: CallExpression, index = 0): string | undefined {
  const argument = callExpression.getArguments()[index];
  if (!argument || !Node.isStringLiteral(argument) && !Node.isNoSubstitutionTemplateLiteral(argument)) {
    return undefined;
  }

  return getStringLiteralValue(argument);
}

function inferAliasKind(callExpression: CallExpression): AliasDefinition["kind"] | undefined {
  const chain = tryParseCypressChain(callExpression);
  if (!chain || chain.at(-1)?.name !== "as") {
    return undefined;
  }

  const rootName = chain[0]?.name;
  if (!rootName) {
    return undefined;
  }

  if (rootName === "intercept") {
    return "intercept";
  }

  if (["get", "find", "contains"].includes(rootName)) {
    return "locator";
  }

  return "value";
}

function collectAliasDefinitions(callbackCall: CallExpression): AliasDefinition[] {
  const callbackArg = callbackCall.getArguments().find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
  if (!callbackArg || !Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) {
    return [];
  }

  return callbackArg
    .getBody()
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .flatMap((callExpression) => {
      const aliasName = getStringArgumentValue(callExpression);
      const kind = inferAliasKind(callExpression);
      if (!aliasName || !kind) {
        return [];
      }

      return [{
        name: aliasName,
        kind,
        node: callExpression
      }];
    });
}

function collectAliasUsagesInNode(node: Node, aliasHelperNames: Set<string>): Set<string> {
  const aliasNames = new Set<string>();

  for (const callExpression of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const chain = tryParseCypressChain(callExpression);
    if (chain?.[0]?.name === "get") {
      const aliasValue = getStringArgumentValue(chain[0].call);
      if (aliasValue?.startsWith("@")) {
        aliasNames.add(aliasValue.slice(1));
      }
    }

    const expression = callExpression.getExpression();
    if (Node.isIdentifier(expression) && aliasHelperNames.has(expression.getText())) {
      const firstArg = getStringArgumentValue(callExpression);
      if (firstArg) {
        aliasNames.add(firstArg.replace(/^@/, ""));
      }
    }
  }

  for (const propertyAccess of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (propertyAccess.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      aliasNames.add(propertyAccess.getName());
    }
  }

  return aliasNames;
}

function computeHoistedAliases(body: Node, context: TransformContext): AliasDefinition[] {
  const hookDefinitions = new Map<string, AliasDefinition>();
  const aliasUsages = new Set<string>();
  const aliasHelperNames = new Set(context.runtime.config.wrapperMap.aliasHelpers ?? []);

  for (const statement of Node.isBlock(body) ? body.getStatements() : []) {
    const nestedCall = getCallExpression(statement);
    if (!nestedCall) {
      continue;
    }

    const callName = nestedCall.getExpression().getText();
    if (HOOK_NAME_MAP[callName]) {
      for (const definition of collectAliasDefinitions(nestedCall)) {
        if (!hookDefinitions.has(definition.name)) {
          hookDefinitions.set(definition.name, definition);
        }
      }
      continue;
    }

    if (callName === "it" || callName === "specify" || callName === "describe" || callName === "context") {
      const callbackArg = nestedCall.getArguments().find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
      if (callbackArg && (Node.isArrowFunction(callbackArg) || Node.isFunctionExpression(callbackArg))) {
        for (const aliasName of collectAliasUsagesInNode(callbackArg.getBody(), aliasHelperNames)) {
          aliasUsages.add(aliasName);
        }
      }
    }
  }

  return [...hookDefinitions.values()].filter((definition) => definition.kind !== "intercept" && aliasUsages.has(definition.name));
}

function isPageObjectInstantiation(statement: Statement, context: TransformContext): Array<{ variableName: string; className: string }> {
  if (!Node.isVariableStatement(statement)) {
    return [];
  }

  const scopedInstances: Array<{ variableName: string; className: string }> = [];
  for (const declaration of statement.getDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isNewExpression(initializer)) {
      return [];
    }

    const expression = initializer.getExpression();
    if (!Node.isIdentifier(expression)) {
      return [];
    }

    const className = expression.getText();
    if (!context.pageObjectClassNames.has(className)) {
      return [];
    }

    scopedInstances.push({
      variableName: declaration.getName(),
      className
    });
  }

  return scopedInstances;
}

function transformSuite(
  callExpression: CallExpression,
  context: TransformContext,
  issues: MigrationIssue[]
): SuiteIR | undefined {
  const [titleArg, callbackArg] = callExpression.getArguments();
  if (!titleArg || !callbackArg || !Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) {
    return undefined;
  }

  const title = titleArg.getText().replace(/["'`]/g, "");
  const body = callbackArg.getBody();
  if (!Node.isBlock(body)) {
    return undefined;
  }

  const suite: SuiteIR = {
    title,
    declarations: [],
    scopedInstances: [],
    hoistedAliases: [],
    forceSerial: false,
    hooks: [],
    tests: [],
    suites: [],
    issues: [],
    modifier: getCallModifier(callExpression.getExpression())
  };

  const hoistedAliases = computeHoistedAliases(body, context);
  suite.hoistedAliases = hoistedAliases.map((alias): HoistedAliasIR => ({
    name: alias.name,
    kind: alias.kind === "locator" ? "locator" : "value"
  }));
  suite.forceSerial = suite.hoistedAliases.length > 0;

  for (const hoistedAlias of hoistedAliases) {
    const hoistIssue = createIssue(
      hoistedAlias.node,
      context.sourceFile.getFilePath(),
      "alias-hoist",
      `Alias "${hoistedAlias.name}" crosses hook/test boundaries; hoisting to describe scope and forcing serial mode.`,
      "info",
      "alias-value-flow",
      "best_effort",
      {
        aliasHoisted: true,
        forcedSerialMode: suite.forceSerial
      }
    );
    suite.issues.push(hoistIssue);
    issues.push(hoistIssue);
  }

  const suiteContext = createChildTransformContext(context, {
    hoistedAliases: new Map([
      ...context.hoistedAliases.entries(),
      ...suite.hoistedAliases.map((alias) => [alias.name, alias.kind] as [string, SubjectKind])
    ])
  });

  for (const statement of body.getStatements()) {
    const nestedCall = getCallExpression(statement);
    if (nestedCall) {
      const expression = nestedCall.getExpression();
      const callName = getCallBaseName(expression);
      if (callName === "describe" || callName === "context") {
        const nestedSuite = transformSuite(nestedCall, suiteContext, issues);
        if (nestedSuite) {
          suite.suites.push(nestedSuite);
        }
        continue;
      }

      if (callName === "it" || callName === "specify") {
        const testCase = createTestCase(nestedCall, suiteContext);
        if (testCase) {
          suite.tests.push(testCase);
        }
        continue;
      }

      const hookName = HOOK_NAME_MAP[callName];
      if (hookName) {
        const hook = createHook(nestedCall, suiteContext);
        if (hook) {
          suite.hooks.push(hook);
        }
        continue;
      }
    }

    const scopedInstances = isPageObjectInstantiation(statement, suiteContext);
    if (scopedInstances.length > 0) {
      for (const scopedInstance of scopedInstances) {
        suite.scopedInstances.push(scopedInstance);
      }
      continue;
    }

    if (Node.isVariableStatement(statement) || Node.isFunctionDeclaration(statement)) {
      suite.declarations.push(statement.getText());
      continue;
    }

    const issue = createIssue(
      statement,
      suiteContext.sourceFile.getFilePath(),
      "suite-setup-review",
      `Suite-level statement "${statement.getKindName()}" needs manual review.`,
      "warning"
    );
    suite.issues.push(issue);
    issues.push(issue);
    suite.declarations.push(`// ${suiteContext.runtime.config.reporting.inlineTodoPrefix}: review suite-level statement\n// ${statement.getText()}`);
  }

  return suite;
}

function collectSuiteIssues(suite: SuiteIR): MigrationIssue[] {
  return [
    ...suite.issues,
    ...suite.hooks.flatMap((hook) => hook.body.issues),
    ...suite.tests.flatMap((testCase) => testCase.body.issues),
    ...suite.suites.flatMap((childSuite) => collectSuiteIssues(childSuite))
  ];
}

export function transformSpecFile(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): SpecFileIR {
  const outputPath = runtime.pathResolution.sourceToOutput.get(sourceFile.getFilePath());
  if (!outputPath) {
    throw new Error(`No output path resolved for spec ${sourceFile.getFilePath()}`);
  }

  const context = createTransformContext(runtime, sourceFile, analysis);
  const issues: MigrationIssue[] = [];
  const suites: SuiteIR[] = [];

  for (const statement of sourceFile.getStatements()) {
    const callExpression = getCallExpression(statement);
    if (callExpression) {
      const expression = callExpression.getExpression();
      const baseName = getCallBaseName(expression);
      if (baseName === "describe" || baseName === "context") {
        const suite = transformSuite(callExpression, context, issues);
        if (suite) {
          suites.push(suite);
        }
        continue;
      }

      if (baseName === "it" || baseName === "specify") {
        const testCase = createTestCase(callExpression, context);
        if (testCase) {
          suites.push({
            title: path.basename(sourceFile.getBaseNameWithoutExtension()),
            declarations: [],
            scopedInstances: [],
            hoistedAliases: [],
            forceSerial: false,
            hooks: [],
            tests: [testCase],
            suites: [],
            issues: []
          });
        }
        continue;
      }
    }

    if (Node.isImportDeclaration(statement)) {
      continue;
    }

    issues.push(
      createIssue(
        statement,
        sourceFile.getFilePath(),
        "top-level-review",
        `Top-level statement "${statement.getKindName()}" requires manual review.`,
        "warning"
      )
    );
  }

  return {
    kind: "spec",
    sourcePath: sourceFile.getFilePath(),
    outputPath,
    imports: rewriteImportBindings(sourceFile, outputPath, runtime),
    suites,
    issues: [...issues, ...suites.flatMap((suite) => collectSuiteIssues(suite))],
    pluginHits: [...context.pluginHits]
  };
}
