import type { ArrowFunction, CallExpression, FunctionExpression, SourceFile } from "ts-morph";
import type { FileAnalysis, GeneratedArtifact, MigrationIssue } from "../shared/types";

export interface CommandTranslationContext {
  sourceFile: SourceFile;
  callExpression: CallExpression;
  commandName: string;
  args: string[];
  pageIdentifier: string;
}

export interface CommandTranslationResult {
  code: string;
  issues?: MigrationIssue[];
  imports?: Array<{ moduleSpecifier: string; namedImport: string }>;
}

export interface RuntimeRecipeContext {
  sourceFile: SourceFile;
  callback: ArrowFunction | FunctionExpression;
  windowIdentifier: string;
  pageIdentifier: string;
}

export interface RuntimeRecipeResult {
  code: string;
  issues?: MigrationIssue[];
  imports?: Array<{ moduleSpecifier: string; namedImport: string }>;
}

export interface DetectionContext {
  sourceFile: SourceFile;
  analysis: FileAnalysis;
}

export interface DetectionResult {
  pluginName: string;
  pattern: string;
  message: string;
}

export interface PostGenerateContext {
  artifact: GeneratedArtifact;
}

export interface CypwPlugin {
  name: string;
  detectFile?(context: DetectionContext): DetectionResult[];
  translateCommand?(context: CommandTranslationContext): CommandTranslationResult | undefined;
  translateRuntimeRecipe?(context: RuntimeRecipeContext): RuntimeRecipeResult | undefined;
  postGenerate?(context: PostGenerateContext): GeneratedArtifact | undefined;
}
