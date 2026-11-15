/** JSON-safe AST for a deliberately small C subset. No semantic resolution. */
export interface Position { readonly offset: number; readonly line: number; readonly column: number }
export interface Span { readonly start: Position; readonly end: Position }
export interface Node { readonly kind: string; readonly span: Span }
export type TopLevel = FunctionDeclaration | VariableDeclaration | PreprocessorDirective;
export type Statement = BlockStatement | VariableDeclaration | IfStatement | WhileStatement |
  DoWhileStatement | ForStatement | ReturnStatement | BreakStatement | ContinueStatement |
  ExpressionStatement | EmptyStatement;
export type Expression = Identifier | Literal | BinaryExpression | UnaryExpression |
  UpdateExpression | AssignmentExpression | ConditionalExpression | CallExpression |
  IndexExpression | MemberExpression | SequenceExpression;

export interface TranslationUnit extends Node {
  readonly kind: "TranslationUnit";
  readonly declarations: readonly TopLevel[];
}
export interface TypeName { readonly name: string; readonly pointerDepth: number }
export interface VariableDeclarator extends Node {
  readonly kind: "VariableDeclarator";
  readonly name: string;
  readonly pointerDepth: number;
  readonly arraySizes: readonly (Expression | null)[];
  readonly initializer: Expression | null;
}
export interface VariableDeclaration extends Node {
  readonly kind: "VariableDeclaration";
  readonly type: TypeName;
  readonly declarators: readonly VariableDeclarator[];
}
export interface Parameter extends Node {
  readonly kind: "Parameter";
  readonly type: TypeName;
  readonly name: string | null;
  readonly arraySizes: readonly (Expression | null)[];
}
export interface FunctionDeclaration extends Node {
  readonly kind: "FunctionDeclaration";
  readonly returnType: TypeName;
  readonly name: string;
  readonly parameters: readonly Parameter[];
  readonly body: BlockStatement | null;
}
export interface PreprocessorDirective extends Node { readonly kind: "PreprocessorDirective"; readonly text: string }
export interface BlockStatement extends Node { readonly kind: "BlockStatement"; readonly statements: readonly Statement[] }
export interface IfStatement extends Node { readonly kind: "IfStatement"; readonly test: Expression; readonly consequent: Statement; readonly alternate: Statement | null }
export interface WhileStatement extends Node { readonly kind: "WhileStatement"; readonly test: Expression; readonly body: Statement }
export interface DoWhileStatement extends Node { readonly kind: "DoWhileStatement"; readonly body: Statement; readonly test: Expression }
export interface ForStatement extends Node { readonly kind: "ForStatement"; readonly init: VariableDeclaration | Expression | null; readonly test: Expression | null; readonly update: Expression | null; readonly body: Statement }
export interface ReturnStatement extends Node { readonly kind: "ReturnStatement"; readonly argument: Expression | null }
export interface BreakStatement extends Node { readonly kind: "BreakStatement" }
export interface ContinueStatement extends Node { readonly kind: "ContinueStatement" }
export interface ExpressionStatement extends Node { readonly kind: "ExpressionStatement"; readonly expression: Expression }
export interface EmptyStatement extends Node { readonly kind: "EmptyStatement" }
export interface Identifier extends Node { readonly kind: "Identifier"; readonly name: string }
export interface Literal extends Node { readonly kind: "Literal"; readonly literalType: "number" | "string" | "char"; readonly raw: string }
export interface BinaryExpression extends Node { readonly kind: "BinaryExpression" | "LogicalExpression"; readonly operator: string; readonly left: Expression; readonly right: Expression }
export interface UnaryExpression extends Node { readonly kind: "UnaryExpression"; readonly operator: string; readonly argument: Expression }
export interface UpdateExpression extends Node { readonly kind: "UpdateExpression"; readonly operator: string; readonly prefix: boolean; readonly argument: Expression }
export interface AssignmentExpression extends Node { readonly kind: "AssignmentExpression"; readonly operator: string; readonly left: Expression; readonly right: Expression }
export interface ConditionalExpression extends Node { readonly kind: "ConditionalExpression"; readonly test: Expression; readonly consequent: Expression; readonly alternate: Expression }
export interface CallExpression extends Node { readonly kind: "CallExpression"; readonly callee: Expression; readonly arguments: readonly Expression[] }
export interface IndexExpression extends Node { readonly kind: "IndexExpression"; readonly object: Expression; readonly index: Expression }
export interface MemberExpression extends Node { readonly kind: "MemberExpression"; readonly object: Expression; readonly property: string; readonly operator: "." | "->" }
export interface SequenceExpression extends Node { readonly kind: "SequenceExpression"; readonly expressions: readonly Expression[] }

export interface AstMetrics {
  readonly nodeCount: number;
  readonly functions: number;
  readonly functionDefinitions: number;
  readonly variableDeclarations: number;
  readonly statements: number;
  readonly expressions: number;
}
export function countAstNodes(ast: TranslationUnit): AstMetrics {
  let nodeCount = 0, functions = 0, functionDefinitions = 0, variableDeclarations = 0;
  let statements = 0, expressions = 0;
  const statementsSet = new Set([
    "BlockStatement", "VariableDeclaration", "IfStatement", "WhileStatement", "DoWhileStatement",
    "ForStatement", "ReturnStatement", "BreakStatement", "ContinueStatement", "ExpressionStatement", "EmptyStatement",
  ]);
  const expressionsSet = new Set([
    "Identifier", "Literal", "BinaryExpression", "LogicalExpression", "UnaryExpression", "UpdateExpression",
    "AssignmentExpression", "ConditionalExpression", "CallExpression", "IndexExpression", "MemberExpression", "SequenceExpression",
  ]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const entry of item) visit(entry); return; }
    if (item === null || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    if (typeof obj.kind !== "string") return;
    nodeCount++;
    if (obj.kind === "FunctionDeclaration") { functions++; if (obj.body !== null) functionDefinitions++; }
    if (obj.kind === "VariableDeclaration") variableDeclarations++;
    if (statementsSet.has(obj.kind)) statements++;
    if (expressionsSet.has(obj.kind)) expressions++;
    for (const [key, value] of Object.entries(obj)) if (key !== "span") visit(value);
  };
  visit(ast);
  return { nodeCount, functions, functionDefinitions, variableDeclarations, statements, expressions };
}
