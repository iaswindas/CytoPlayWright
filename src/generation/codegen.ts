import path from "node:path";
import type {
  HelperFileIR,
  ImportBinding,
  MethodIR,
  MigrationFileIR,
  SpecFileIR,
  StatementIR,
  SuiteIR
} from "../ir/types";
import { indentBlock, normalizeImportPath } from "../transforms/transform-utils";

function getBaseTestImportPath(specOutputPath: string): string {
  const normalizedOutputPath = specOutputPath.replace(/\\/g, "/");
  const testsIndex = normalizedOutputPath.lastIndexOf("/tests/");
  const outputRoot = testsIndex >= 0 ? normalizedOutputPath.slice(0, testsIndex) : path.dirname(normalizedOutputPath);
  const target = `${outputRoot}/fixtures/baseTest.ts`;
  return normalizeImportPath(specOutputPath, target);
}

function mergeImports(imports: ImportBinding[]): ImportBinding[] {
  const grouped = new Map<string, ImportBinding>();

  for (const entry of imports) {
    const current = grouped.get(entry.moduleSpecifier) ?? {
      moduleSpecifier: entry.moduleSpecifier,
      defaultImport: entry.defaultImport,
      namedImports: []
    };

    if (!current.defaultImport && entry.defaultImport) {
      current.defaultImport = entry.defaultImport;
    }

    const namedImports = new Set([...(current.namedImports ?? []), ...(entry.namedImports ?? [])]);
    current.namedImports = [...namedImports].sort();
    grouped.set(entry.moduleSpecifier, current);
  }

  return [...grouped.values()].sort((left, right) => left.moduleSpecifier.localeCompare(right.moduleSpecifier));
}

function collectStatementImports(statements: StatementIR[]): ImportBinding[] {
  return statements.flatMap((statement) => statement.imports ?? []);
}

function collectSuiteImports(suite: SuiteIR): ImportBinding[] {
  const hookImports = suite.hooks.flatMap((hook) => collectStatementImports(hook.body.statements));
  const testImports = suite.tests.flatMap((testCase) => collectStatementImports(testCase.body.statements));
  const nestedImports = suite.suites.flatMap((childSuite) => collectSuiteImports(childSuite));
  return [...hookImports, ...testImports, ...nestedImports];
}

function renderImport(importBinding: ImportBinding): string {
  const parts: string[] = [];
  if (importBinding.defaultImport) {
    parts.push(importBinding.defaultImport);
  }

  if ((importBinding.namedImports ?? []).length > 0) {
    parts.push(`{ ${(importBinding.namedImports ?? []).join(", ")} }`);
  }

  return `import ${parts.join(", ")} from ${JSON.stringify(importBinding.moduleSpecifier)};`;
}

function renderStatement(statement: StatementIR): string {
  const parts: string[] = [];
  if (statement.comments?.leading.length) {
    parts.push(...statement.comments.leading);
  }
  parts.push(statement.code);
  if (statement.comments?.trailing.length) {
    parts.push(...statement.comments.trailing);
  }
  return parts.join("\n");
}

function renderStatements(statements: StatementIR[], indent = 4): string {
  const body = statements.map((statement) => renderStatement(statement)).join("\n");
  return indentBlock(body, indent);
}

function renderHookSignature(kind: string): string {
  switch (kind) {
    case "beforeAll":
      return "test.beforeAll";
    case "beforeEach":
      return "test.beforeEach";
    case "afterAll":
      return "test.afterAll";
    case "afterEach":
      return "test.afterEach";
    default:
      return "test.beforeEach";
  }
}

function ensureScopedInstances(suite: SuiteIR): SuiteIR {
  if (suite.scopedInstances.length === 0) {
    return suite;
  }

  const initializationStatements = suite.scopedInstances.map((instance) => ({
    code: `${instance.variableName} = new ${instance.className}(page);`,
    issues: [],
    unresolved: false
  }));

  const existingBeforeEach = suite.hooks.find((hook) => hook.kind === "beforeEach");
  if (existingBeforeEach) {
    existingBeforeEach.body.statements = [...initializationStatements, ...existingBeforeEach.body.statements];
  } else {
    suite.hooks.unshift({
      kind: "beforeEach",
      body: {
        statements: initializationStatements,
        issues: []
      }
    });
  }

  suite.declarations.unshift(
    ...suite.scopedInstances.map((instance) => `let ${instance.variableName}: ${instance.className};`)
  );

  return suite;
}

function renderSuite(suiteInput: SuiteIR, depth = 0): string {
  const suite = ensureScopedInstances(suiteInput);
  const indent = " ".repeat(depth * 2);
  const bodyLines: string[] = [];

  if (suite.declarations.length > 0) {
    bodyLines.push(...suite.declarations);
  }

  if (suite.hoistedAliases.length > 0) {
    bodyLines.push(...suite.hoistedAliases.map((alias) => `let ${alias.name}: any;`));
  }

  if (suite.forceSerial) {
    bodyLines.push(`test.describe.configure({ mode: "serial" });`);
  }

  for (const hook of suite.hooks) {
    bodyLines.push(
      `${renderHookSignature(hook.kind)}(async ({ page, request, loadFixture, runTask, migrationState }) => {`,
      renderStatements(hook.body.statements, 2),
      `});`
    );
  }

  for (const testCase of suite.tests) {
    bodyLines.push(
      `test(${JSON.stringify(testCase.title)}, async ({ page, request, loadFixture, runTask, migrationState }) => {`,
      renderStatements(testCase.body.statements, 2),
      `});`
    );
  }

  for (const childSuite of suite.suites) {
    bodyLines.push(renderSuite(childSuite, depth + 1));
  }

  const body = bodyLines.length > 0 ? `\n${indentBlock(bodyLines.join("\n"), 2)}\n` : "\n";
  return `${indent}test.describe(${JSON.stringify(suite.title)}, () => {${body}${indent}});`;
}

function renderMethod(method: MethodIR): string {
  const signatureName = method.isGetter ? `get ${method.name}` : `${method.isAsync ? "async " : ""}${method.name}`;
  const params = method.parameters.join(", ");
  const returnType = method.returnType ? `: ${method.returnType}` : "";
  const body = method.body.statements.length > 0 ? `\n${renderStatements(method.body.statements, 2)}\n` : "\n";

  return `${signatureName}(${params})${returnType} {${body}}`;
}

function renderSpecFile(ir: SpecFileIR): string {
  const baseTestImport = getBaseTestImportPath(ir.outputPath);
  const imports = mergeImports([
    {
      moduleSpecifier: baseTestImport,
      namedImports: [
        "expect",
        "getLocatorAlias",
        "getValueAlias",
        "loadProjectJson",
        "normalizeResponse",
        "registerAlias",
        "registerLocatorAlias",
        "registerValueAlias",
        "test",
        "waitForAlias"
      ]
    },
    ...ir.imports,
    ...ir.suites.flatMap((suite) => collectSuiteImports(suite))
  ]);

  const sections = [
    imports.map((entry) => renderImport(entry)).join("\n"),
    ir.suites.map((suite) => renderSuite(suite)).join("\n\n")
  ].filter((section) => section.trim().length > 0);

  return `${sections.join("\n\n")}\n`;
}

function renderHelperFile(ir: HelperFileIR): string {
  const imports = mergeImports([
    {
      moduleSpecifier: "@playwright/test",
      namedImports: ["Page", "expect"]
    },
    ...ir.imports,
    ...ir.functions.flatMap((fn) => collectStatementImports(fn.body.statements))
  ]);

  const declarations = ir.functions.map((fn) => {
    const keyword = fn.exportKind === "default" ? "export default" : "export";
    const asyncKeyword = fn.isAsync ? "async " : "";
    return `${keyword} ${asyncKeyword}function ${fn.name}(${fn.parameters.join(", ")}) {\n${renderStatements(fn.body.statements, 2)}\n}`;
  });

  return `${imports.map((entry) => renderImport(entry)).join("\n")}\n\n${[...declarations, ...ir.rawStatements].join("\n\n")}\n`;
}

function renderPageObject(ir: Extract<MigrationFileIR, { kind: "page-object" }>): string {
  const methods = ir.methods.map((method) => renderMethod(method)).join("\n\n");
  return `import { Page, expect } from "@playwright/test";

export class ${ir.className} {
  constructor(private readonly page: Page) {}

${indentBlock(methods, 2)}
}
`;
}

export function renderMigrationFile(ir: MigrationFileIR): string {
  switch (ir.kind) {
    case "spec":
      return renderSpecFile(ir);
    case "page-object":
      return renderPageObject(ir);
    case "helper":
      return renderHelperFile(ir);
    case "support":
      return ir.content;
    default:
      return "";
  }
}
