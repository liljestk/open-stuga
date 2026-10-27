import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// SonarCloud's "Sonar way comprehensive" profile flags functions whose cognitive
// complexity (rule S3776) exceeds 15. This gate reimplements eslint-plugin-sonarjs
// 4.2's scoring on the TypeScript AST, so it needs no ESLint toolchain, and keeps a
// per-file baseline of the existing offenders. A file may not gain an offender, and
// no offender may grow past the baseline score in its slot.
export const threshold = 15;
const baselinePath = "scripts/baselines/cognitive-complexity.json";
const sourceRoots = ["apps", "packages"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set(["__tests__", "build", "coverage", "dist", "node_modules", "test", "tests"]);
const ignoredPaths = new Set(["apps/ios"]);
const logicalOperators = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
  [ts.SyntaxKind.BarBarToken, "||"],
  [ts.SyntaxKind.QuestionQuestionToken, "??"],
]);

function scriptKind(fileName) {
  switch (extname(fileName)) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function logicalOperator(node) {
  return ts.isBinaryExpression(node) ? logicalOperators.get(node.operatorToken.kind) : undefined;
}

function withoutParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isMeasuredFunction(node) {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return node.body !== undefined;
    default:
      return false;
  }
}

function propertyName(name, sourceFile) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function calleeName(call, sourceFile) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return callee.getText(sourceFile).slice(0, 40);
}

function functionName(node, sourceFile) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (!ts.isArrowFunction(node) && node.name) return propertyName(node.name, sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return propertyName(parent.name, sourceFile);
  }
  if (ts.isCallExpression(parent)) return `${calleeName(parent, sourceFile)}(…) callback`;
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) return `${propertyName(parent.parent.name, sourceFile)} handler`;
  return "<anonymous>";
}

// The token SonarJS anchors its issue to: the name, the `function` keyword, or `=>`.
function anchorPosition(node, sourceFile) {
  if (ts.isArrowFunction(node)) return node.equalsGreaterThanToken.getStart(sourceFile);
  if (ts.isFunctionExpression(node) && ts.isPropertyAssignment(node.parent)) return node.parent.name.getStart(sourceFile);
  if (node.name) return node.name.getStart(sourceFile);
  const keyword = node.getChildren(sourceFile).find((child) =>
    child.kind === ts.SyntaxKind.FunctionKeyword || child.kind === ts.SyntaxKind.ConstructorKeyword);
  return (keyword ?? node).getStart(sourceFile);
}

// Returns one entry per function body with its own cognitive complexity; nested
// functions are measured separately, exactly as eslint-plugin-sonarjs reports them.
export function measureCognitiveComplexity(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const functions = [];
  const frames = [];
  const consideredLogical = new Set();

  const current = () => frames.at(-1);
  const addFlat = () => {
    if (current()) current().score += 1;
  };
  const addStructural = () => {
    if (current()) current().score += current().nesting + 1;
  };

  function visitNested(node) {
    const frame = current();
    if (!frame) {
      visit(node);
      return;
    }
    frame.nesting += 1;
    visit(node);
    // SonarJS lowers the nesting of whichever function is innermost when it leaves a
    // nesting node. A ternary branch that is itself a function therefore lowers that
    // function's level instead, and the enclosing function keeps the extra level.
    if (!isMeasuredFunction(withoutParentheses(node))) frame.nesting -= 1;
  }

  function jsxShortCircuitChain(root) {
    let parent = root.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    if (!ts.isJsxExpression(parent)) return null;
    const operator = logicalOperator(root);
    const flatten = (candidate) => {
      const node = withoutParentheses(candidate);
      if (ts.isConditionalExpression(node)) return null;
      const nodeOperator = logicalOperator(node);
      if (!nodeOperator) return [];
      if (nodeOperator !== operator) return null;
      const left = flatten(node.left);
      const right = flatten(node.right);
      return left && right ? [...left, node, ...right] : null;
    };
    return flatten(root);
  }

  function flattenLogical(candidate) {
    const node = withoutParentheses(candidate);
    if (!logicalOperator(node)) return [];
    consideredLogical.add(node);
    return [...flattenLogical(node.left), node, ...flattenLogical(node.right)];
  }

  // Only `&&` sequences count: `||` and `??` are treated as defaulting, and a JSX
  // `{condition && <Element />}` short circuit is treated as conditional rendering.
  function visitLogical(node) {
    const jsxChain = jsxShortCircuitChain(node);
    if (jsxChain) {
      for (const member of jsxChain) consideredLogical.add(member);
      return;
    }
    if (consideredLogical.has(node)) return;
    let previous;
    for (const member of flattenLogical(node)) {
      const operator = logicalOperator(member);
      if (operator === "&&" && previous !== "&&") addFlat();
      previous = operator;
    }
  }

  function visitIf(node) {
    const isElseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
    if (isElseIf) addFlat();
    else addStructural();
    visit(node.expression);
    visitNested(node.thenStatement);
    if (!node.elseStatement) return;
    if (ts.isIfStatement(node.elseStatement)) {
      visit(node.elseStatement);
    } else {
      addFlat();
      visitNested(node.elseStatement);
    }
  }

  function visitLoop(node) {
    addStructural();
    ts.forEachChild(node, (child) => {
      if (child === node.statement) visitNested(child);
      else visit(child);
    });
  }

  function visitFunction(node) {
    const position = sourceFile.getLineAndCharacterOfPosition(anchorPosition(node, sourceFile));
    const frame = { name: functionName(node, sourceFile), line: position.line + 1, column: position.character + 1, score: 0, nesting: 0 };
    frames.push(frame);
    ts.forEachChild(node, visit);
    frames.pop();
    functions.push({ name: frame.name, line: frame.line, column: frame.column, score: frame.score });
  }

  function visit(node) {
    if (isMeasuredFunction(node)) {
      visitFunction(node);
      return;
    }
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
        visitIf(node);
        return;
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
        visitLoop(node);
        return;
      case ts.SyntaxKind.SwitchStatement:
        addStructural();
        visit(node.expression);
        for (const clause of node.caseBlock.clauses) visitNested(clause);
        return;
      case ts.SyntaxKind.CatchClause:
        addStructural();
        if (node.variableDeclaration) visit(node.variableDeclaration);
        visitNested(node.block);
        return;
      case ts.SyntaxKind.ConditionalExpression:
        addStructural();
        visit(node.condition);
        visitNested(node.whenTrue);
        visitNested(node.whenFalse);
        return;
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
        if (node.label) addFlat();
        return;
      case ts.SyntaxKind.BinaryExpression:
        if (logicalOperator(node)) visitLogical(node);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions.sort((left, right) => left.line - right.line || left.column - right.column);
}

function projectPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isSourceFile(name) {
  return sourceExtensions.has(extname(name)) && !/\.(?:test|spec)\./.test(name);
}

async function sourceFiles(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (ignoredPaths.has(projectPath(root, path))) continue;
    if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
    else if (entry.isFile() && isSourceFile(entry.name)) files.push(path);
  }
  return files;
}

// Maps each project path to its functions above the threshold, worst first.
export async function measureRepository(root) {
  const offenders = new Map();
  for (const sourceRoot of sourceRoots) {
    for (const path of await sourceFiles(root, join(root, sourceRoot))) {
      const functions = measureCognitiveComplexity(path, await readFile(path, "utf8"))
        .filter((entry) => entry.score > threshold)
        .sort((left, right) => right.score - left.score || left.line - right.line);
      if (functions.length) offenders.set(projectPath(root, path), functions);
    }
  }
  return offenders;
}

// The i-th worst function in a file may not score above the i-th worst baseline
// score, and a file may not have more offenders than its baseline lists.
export function compareWithBaseline(offenders, baselineFiles) {
  const regressions = [];
  const improvements = [];
  for (const [path, functions] of offenders) {
    const allowed = baselineFiles[path] ?? [];
    functions.forEach((entry, index) => {
      if (index >= allowed.length || entry.score > allowed[index]) {
        regressions.push({ path, ...entry, allowed: allowed[index] ?? threshold });
      }
    });
  }
  for (const [path, allowed] of Object.entries(baselineFiles)) {
    const scores = (offenders.get(path) ?? []).map((entry) => entry.score);
    if (scores.length < allowed.length || scores.some((score, index) => score < allowed[index])) improvements.push(path);
  }
  return { regressions, improvements };
}

// Lowers the baseline to the measured scores; it never raises an entry.
export function loweredBaseline(offenders, baselineFiles) {
  const files = {};
  for (const path of Object.keys(baselineFiles).sort()) {
    const scores = (offenders.get(path) ?? []).map((entry) => entry.score);
    const lowered = baselineFiles[path]
      .slice(0, scores.length)
      .map((allowed, index) => Math.min(allowed, scores[index]));
    if (lowered.length) files[path] = lowered;
  }
  return files;
}

function functionCount(files) {
  return Object.values(files).reduce((total, scores) => total + scores.length, 0);
}

// One line per file keeps baseline diffs reviewable.
export function serializeBaseline(files) {
  const entries = Object.keys(files).sort()
    .map((path) => `    ${JSON.stringify(path)}: [${files[path].join(", ")}]`);
  return [
    "{",
    `  "rule": "sonarjs/cognitive-complexity (S3776)",`,
    `  "threshold": ${threshold},`,
    `  "functions": ${functionCount(files)},`,
    `  "files": {`,
    entries.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

async function main(argv) {
  const root = process.cwd();
  const offenders = await measureRepository(root);
  const measuredCount = [...offenders.values()].reduce((total, functions) => total + functions.length, 0);

  // --initialize records every current offender; use it only when adopting a new rule version.
  if (argv.includes("--initialize")) {
    const files = Object.fromEntries([...offenders].map(([path, functions]) => [path, functions.map((entry) => entry.score)]));
    await writeFile(join(root, baselinePath), serializeBaseline(files));
    console.log(`Wrote ${baselinePath} with ${measuredCount} functions above ${threshold}.`);
    return;
  }

  const baseline = JSON.parse(await readFile(join(root, baselinePath), "utf8"));
  let baselineFiles = baseline.files;
  const { regressions, improvements } = compareWithBaseline(offenders, baselineFiles);

  if (argv.includes("--update")) {
    const lowered = loweredBaseline(offenders, baselineFiles);
    await writeFile(join(root, baselinePath), serializeBaseline(lowered));
    console.log(`Lowered ${baselinePath}: ${functionCount(baselineFiles)} -> ${functionCount(lowered)} functions above ${threshold}.`);
    baselineFiles = lowered;
  } else if (improvements.length) {
    console.log(
      `Cognitive complexity dropped below the baseline in ${improvements.length} file(s); `
        + "run `npm run check:cognitive-complexity -- --update` to lock the gain in.",
    );
  }

  if (regressions.length) {
    console.error(`Cognitive complexity (SonarJS S3776, threshold ${threshold}) grew past ${baselinePath}:`);
    for (const regression of regressions) {
      console.error(
        `  ${regression.path}:${regression.line} ${regression.name} scores ${regression.score} (allowed ${regression.allowed})`,
      );
    }
    console.error("Extract named helpers or use early returns until each function is at or under the allowance.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Cognitive complexity check passed (${measuredCount} functions above ${threshold}; baseline ${functionCount(baselineFiles)}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
