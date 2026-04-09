import { Node, SyntaxKind, type ExpressionStatement, type FunctionDeclaration, type SourceFile, type VariableDeclaration } from "ts-morph";
import type { HelperFileIR, HelperFunctionIR, ImportBinding } from "../ir/types";
import type { CompilerRuntime } from "../shared/runtime";
import type { FileAnalysis } from "../shared/types";
import { normalizeImportPath } from "./transform-utils";
import { createTransformState, getHelperImportsNeedingPage, getPageObjectClassNames } from "./transform-utils";
import { translateStatements } from "./cypress-command-transformer";
import type { TransformContext } from "./transform-utils";

function createContext(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): TransformContext {
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

function rewriteImports(sourceFile: SourceFile, outputPath: string, runtime: CompilerRuntime): ImportBinding[] {
  const imports: ImportBinding[] = [];
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    const resolvedSourceFile = importDeclaration.getModuleSpecifierSourceFile();
    const outputTargetPath = resolvedSourceFile
      ? runtime.pathResolution.sourceToOutput.get(resolvedSourceFile.getFilePath())
      : undefined;
    const moduleSpecifier = outputTargetPath
      ? normalizeImportPath(outputPath, outputTargetPath)
      : importDeclaration.getModuleSpecifierValue();

    imports.push({
      moduleSpecifier,
      defaultImport: importDeclaration.getDefaultImport()?.getText(),
      namedImports: importDeclaration.getNamedImports().map((namedImport) => namedImport.getName())
    });
  }

  return imports;
}

function buildFunctionIr(
  declaration: FunctionDeclaration,
  context: TransformContext,
  sourceFile: SourceFile
): HelperFunctionIR {
  const body = declaration.getBody();
  const statements = body && Node.isBlock(body) ? translateStatements(body, context) : [];
  const parameters = declaration.getParameters().map((parameter) => parameter.getText());
  const needsPage = sourceFile.getFullText().includes("cy.") && !parameters.some((parameter) => parameter.startsWith("page"));

  return {
    name: declaration.getName() ?? "anonymousHelper",
    parameters: needsPage ? ["page: Page", ...parameters] : parameters,
    body: {
      statements,
      issues: statements.flatMap((statement) => statement.issues)
    },
    isAsync: declaration.isAsync() || statements.some((statement) => statement.code.includes("await ")),
    exportKind: declaration.isDefaultExport() ? "default" : "named"
  };
}

function buildVariableFunctionIr(
  declaration: VariableDeclaration,
  context: TransformContext,
  sourceFile: SourceFile
): HelperFunctionIR | undefined {
  const initializer = declaration.getInitializer();
  if (!initializer || !Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) {
    return undefined;
  }

  const body = initializer.getBody();
  const statements = Node.isBlock(body) ? translateStatements(body, context) : [];
  const parameters = initializer.getParameters().map((parameter) => parameter.getText());
  const needsPage = sourceFile.getFullText().includes("cy.") && !parameters.some((parameter) => parameter.startsWith("page"));

  return {
    name: declaration.getName(),
    parameters: needsPage ? ["page: Page", ...parameters] : parameters,
    body: {
      statements,
      issues: statements.flatMap((statement) => statement.issues)
    },
    isAsync: initializer.isAsync() || statements.some((statement) => statement.code.includes("await ")),
    exportKind: declaration.getVariableStatementOrThrow().isDefaultExport() ? "default" : "named"
  };
}

function buildAssignedFunctionIr(
  name: string,
  initializer: ReturnType<VariableDeclaration["getInitializer"]>,
  context: TransformContext,
  sourceFile: SourceFile,
  exportKind: HelperFunctionIR["exportKind"]
): HelperFunctionIR | undefined {
  if (!initializer || !Node.isArrowFunction(initializer) && !Node.isFunctionExpression(initializer)) {
    return undefined;
  }

  const body = initializer.getBody();
  const statements = Node.isBlock(body) ? translateStatements(body, context) : [];
  const parameters = initializer.getParameters().map((parameter) => parameter.getText());
  const needsPage = sourceFile.getFullText().includes("cy.") && !parameters.some((parameter) => parameter.startsWith("page"));

  return {
    name,
    parameters: needsPage ? ["page: Page", ...parameters] : parameters,
    body: {
      statements,
      issues: statements.flatMap((statement) => statement.issues)
    },
    isAsync: initializer.isAsync() || statements.some((statement) => statement.code.includes("await ")),
    exportKind
  };
}

function isModuleExportsAssignment(statement: ExpressionStatement): boolean {
  const expression = statement.getExpression();
  return Node.isBinaryExpression(expression)
    && expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken
    && expression.getLeft().getText() === "module.exports";
}

function isExportsPropertyAssignment(statement: ExpressionStatement): boolean {
  const expression = statement.getExpression();
  if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
    return false;
  }

  const left = expression.getLeft();
  return Node.isPropertyAccessExpression(left) && left.getExpression().getText() === "exports";
}

export function transformHelperFile(runtime: CompilerRuntime, sourceFile: SourceFile, analysis: FileAnalysis): HelperFileIR {
  const outputPath = runtime.pathResolution.sourceToOutput.get(sourceFile.getFilePath());
  if (!outputPath) {
    throw new Error(`No output path resolved for helper ${sourceFile.getFilePath()}`);
  }

  const context = createContext(runtime, sourceFile, analysis);
  const functions: HelperFunctionIR[] = [];
  const rawStatements: string[] = [];
  const commonJsMembers = new Set<string>();
  let hasExplicitDefaultExport = false;

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      functions.push(buildFunctionIr(statement, context, sourceFile));
      continue;
    }

    if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const functionIr = buildVariableFunctionIr(declaration, context, sourceFile);
        if (functionIr) {
          functions.push(functionIr);
        }
      }
      continue;
    }

    if (Node.isExpressionStatement(statement) && isExportsPropertyAssignment(statement)) {
      const expression = statement.getExpression().asKindOrThrow(SyntaxKind.BinaryExpression);
      const exportName = expression.getLeft().asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName();
      const functionIr = buildAssignedFunctionIr(exportName, expression.getRight(), context, sourceFile, "named");
      if (functionIr) {
        functions.push(functionIr);
      } else if (Node.isIdentifier(expression.getRight()) && expression.getRight().getText() === exportName) {
        // The identifier is already declared above; just expose it through ESM exports/default object.
      } else {
        rawStatements.push(`export const ${exportName}: any = ${expression.getRight().getText()};`);
      }
      commonJsMembers.add(exportName);
      continue;
    }

    if (Node.isExpressionStatement(statement) && isModuleExportsAssignment(statement)) {
      const expression = statement.getExpression().asKindOrThrow(SyntaxKind.BinaryExpression);
      const right = expression.getRight();
      if (Node.isObjectLiteralExpression(right)) {
        for (const property of right.getProperties()) {
          if (Node.isShorthandPropertyAssignment(property)) {
            commonJsMembers.add(property.getName());
          } else if (Node.isPropertyAssignment(property)) {
            const propertyName = property.getName();
            commonJsMembers.add(propertyName);
          }
        }
      } else {
        const defaultFunction = buildAssignedFunctionIr(sourceFile.getBaseNameWithoutExtension(), right, context, sourceFile, "default");
        if (defaultFunction) {
          functions.push(defaultFunction);
        } else {
          rawStatements.push(`const __cypwDefaultExport: any = ${right.getText()};`);
          rawStatements.push(`export default __cypwDefaultExport;`);
        }
        hasExplicitDefaultExport = true;
      }
      continue;
    }

    if (!Node.isImportDeclaration(statement)) {
      rawStatements.push(statement.getText());
    }
  }

  if (commonJsMembers.size > 0 && !hasExplicitDefaultExport) {
    rawStatements.push(`const __cypwDefaultExport = { ${[...commonJsMembers].join(", ")} };`);
    rawStatements.push(`export default __cypwDefaultExport;`);
  }

  return {
    kind: "helper",
    sourcePath: sourceFile.getFilePath(),
    outputPath,
    imports: rewriteImports(sourceFile, outputPath, runtime),
    functions,
    rawStatements,
    issues: functions.flatMap((fn) => fn.body.issues),
    pluginHits: [...context.pluginHits]
  };
}
