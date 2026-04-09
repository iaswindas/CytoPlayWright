import type { ArrowFunction, CallExpression, FunctionExpression } from "ts-morph";
import type { ImportBinding } from "../ir/types";
import type { ConversionStrategy, MigrationIssue, SubjectKind } from "../shared/types";

export interface ChainCallback {
  node: ArrowFunction | FunctionExpression;
  parameterNames: string[];
}

export interface AnalyzedChainCommand {
  name: string;
  call: CallExpression;
  args: string[];
  kind:
    | "query"
    | "action"
    | "assertion"
    | "alias"
    | "control"
    | "network"
    | "value"
    | "custom";
  callback?: ChainCallback;
}

export interface AnalyzedCommandChain {
  commands: AnalyzedChainCommand[];
}

export interface LoweredChainResult {
  code: string;
  subjectExpression?: string;
  subjectKind: SubjectKind;
  issues: MigrationIssue[];
  unresolved: boolean;
  imports: ImportBinding[];
  conversionStrategy: ConversionStrategy;
}
