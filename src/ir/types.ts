import type { FileCategory, MigrationIssue } from "../shared/types";

export interface ImportBinding {
  moduleSpecifier: string;
  sideEffectOnly?: boolean;
  defaultImport?: string;
  namespaceImport?: string;
  namedImports?: string[];
}

export interface CommentIR {
  leading: string[];
  trailing: string[];
}

export interface StatementIR {
  code: string;
  issues: MigrationIssue[];
  unresolved: boolean;
  imports?: ImportBinding[];
  comments?: CommentIR;
}

export interface BlockIR {
  statements: StatementIR[];
  issues: MigrationIssue[];
}

export interface HookIR {
  kind: "beforeAll" | "beforeEach" | "afterAll" | "afterEach";
  body: BlockIR;
}

export interface TestCaseIR {
  title: string;
  body: BlockIR;
  modifier?: "skip" | "only";
}

export interface ScopedInstanceIR {
  variableName: string;
  className: string;
}

export interface HoistedAliasIR {
  name: string;
  kind: "locator" | "value";
}

export interface SuiteIR {
  title: string;
  declarations: string[];
  scopedInstances: ScopedInstanceIR[];
  hoistedAliases: HoistedAliasIR[];
  forceSerial: boolean;
  hooks: HookIR[];
  tests: TestCaseIR[];
  suites: SuiteIR[];
  issues: MigrationIssue[];
  modifier?: "skip" | "only";
}

export interface SpecFileIR {
  kind: "spec";
  sourcePath: string;
  outputPath: string;
  imports: ImportBinding[];
  suites: SuiteIR[];
  issues: MigrationIssue[];
  pluginHits: string[];
}

export interface MethodIR {
  name: string;
  parameters: string[];
  body: BlockIR;
  isAsync: boolean;
  isGetter: boolean;
  returnType?: string;
}

export interface PageObjectIR {
  kind: "page-object";
  sourcePath: string;
  outputPath: string;
  className: string;
  methods: MethodIR[];
  issues: MigrationIssue[];
  pluginHits: string[];
}

export interface HelperFunctionIR {
  name: string;
  parameters: string[];
  body: BlockIR;
  isAsync: boolean;
  exportKind: "named" | "default";
}

export interface HelperFileIR {
  kind: "helper";
  sourcePath: string;
  outputPath: string;
  imports: ImportBinding[];
  functions: HelperFunctionIR[];
  rawStatements: string[];
  issues: MigrationIssue[];
  pluginHits: string[];
}

export interface SupportFileIR {
  kind: "support";
  sourcePath: string;
  outputPath: string;
  content: string;
  issues: MigrationIssue[];
}

export type MigrationFileIR =
  | SpecFileIR
  | PageObjectIR
  | HelperFileIR
  | SupportFileIR;

export interface ConversionResult {
  category: FileCategory;
  ir?: MigrationFileIR;
  issues: MigrationIssue[];
  pluginHits: string[];
}
