import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  compareWithBaseline,
  loweredBaseline,
  measureCognitiveComplexity,
  measureRepository,
  serializeBaseline,
  threshold,
} from "../check-cognitive-complexity.mjs";

// Expected scores were confirmed against eslint-plugin-sonarjs 4.2.2 (rule S3776).
const cases = `
export function branches(x: unknown[] | null, y: boolean) {
  if (x) {
    for (const item of x) {
      if (item) continue;
    }
  } else if (y) {
    return 1;
  } else {
    return 2;
  }
  return 0;
}

export function logical(a: boolean, b: boolean, c: boolean) {
  const first = a && b || c && a;
  const second = a ?? b;
  const third = a || b || c;
  return first && second && third;
}

export const ternaries = (a: number) => a > 1 ? 1 : a > 0 ? 2 : 3;

export function outer(list: number[] | null) {
  if (list) {
    return list.map((value) => {
      if (value) return 1;
      return 0;
    });
  }
  return [];
}

export function jumps(values: number[], run: () => void) {
  outerLoop: for (const value of values) {
    switch (value) {
      case 1:
        break outerLoop;
      default:
        break;
    }
  }
  try {
    run();
  } catch {
    if (values.length) return;
  }
}

export function Rendered({ a, b }: { a: boolean; b: boolean }) {
  return <div>{a && b && <span />}{a ? <i /> : null}{(a || b) && <b />}</div>;
}

export function leaked(a: boolean, b: () => void) {
  const handler = a ? () => b() : null;
  if (b) return handler;
  return null;
}
`;

function scores(source, fileName = "cases.tsx") {
  return Object.fromEntries(measureCognitiveComplexity(fileName, source).map((entry) => [entry.name, entry.score]));
}

test("scores each function body the way SonarJS S3776 does", () => {
  assert.deepEqual(scores(cases), {
    branches: 8,
    logical: 3,
    ternaries: 3,
    outer: 1,
    "map(…) callback": 1,
    jumps: 7,
    Rendered: 2,
    leaked: 3,
    "<anonymous>": 0,
  });
});

test("reports the SonarJS anchor line and names methods, accessors and constructors", () => {
  const measured = measureCognitiveComplexity("shapes.ts", [
    "class Shape {",
    "  constructor(private readonly size: number) { if (size) this.size = size; }",
    "  get area() { return this.size > 0 ? this.size : 0; }",
    "  grow(by: number) { if (by) { if (by > 1) return by; } return 0; }",
    "}",
    "const handlers = {",
    "  click: function () { return 1; },",
    "  hover: (",
    "    event: number,",
    "  ) => event ? 1 : 0,",
    "};",
  ].join("\n"));
  assert.deepEqual(measured.map(({ name, line, score }) => ({ name, line, score })), [
    { name: "constructor", line: 2, score: 1 },
    { name: "area", line: 3, score: 1 },
    { name: "grow", line: 4, score: 3 },
    { name: "click", line: 7, score: 0 },
    { name: "hover", line: 10, score: 1 },
  ]);
});

test("ratchets per file: no new offender and no slot above its baseline score", () => {
  const offenders = new Map([
    ["apps/a.ts", [{ name: "worse", line: 1, column: 1, score: 30 }, { name: "same", line: 9, column: 1, score: 18 }]],
    ["apps/new.ts", [{ name: "fresh", line: 4, column: 1, score: 16 }]],
    ["apps/better.ts", [{ name: "improved", line: 2, column: 1, score: 17 }]],
  ]);
  const baseline = { "apps/a.ts": [25, 18], "apps/better.ts": [20, 19], "apps/gone.ts": [40] };

  const { regressions, improvements } = compareWithBaseline(offenders, baseline);

  assert.deepEqual(regressions.map(({ path, name, score, allowed }) => ({ path, name, score, allowed })), [
    { path: "apps/a.ts", name: "worse", score: 30, allowed: 25 },
    { path: "apps/new.ts", name: "fresh", score: 16, allowed: threshold },
  ]);
  assert.deepEqual(improvements.sort(), ["apps/better.ts", "apps/gone.ts"]);
  assert.deepEqual(loweredBaseline(offenders, baseline), { "apps/a.ts": [25, 18], "apps/better.ts": [17] });
});

test("serializes one sorted line per file that parses back to the same baseline", () => {
  const files = { "packages/z.ts": [16], "apps/a.ts": [40, 17] };
  const text = serializeBaseline(files);
  assert.match(text, /"apps\/a\.ts": \[40, 17\],\n {4}"packages\/z\.ts": \[16\]\n/);
  assert.deepEqual(JSON.parse(text), {
    rule: "sonarjs/cognitive-complexity (S3776)",
    threshold,
    functions: 3,
    files: { "apps/a.ts": [40, 17], "packages/z.ts": [16] },
  });
});

test("measures apps and packages sources but not tests, builds or the iOS app", (context) => {
  const root = mkdtempSync(join(tmpdir(), "stugu-cognitive-complexity-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = (depth) => `export function deep(v: number) {\n${"  if (v) {\n".repeat(depth)}  return v;\n${"  }\n".repeat(depth)}}\n`;
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("apps/demo/src/complex.ts", nested(6));
  write("apps/demo/src/complex.test.ts", nested(6));
  write("apps/demo/tests/helper.ts", nested(6));
  write("apps/demo/dist/complex.js", nested(6));
  write("apps/ios/Scripts/tool.ts", nested(6));
  write("packages/kit/src/simple.ts", nested(2));

  return measureRepository(root).then((offenders) => {
    assert.deepEqual([...offenders.keys()], ["apps/demo/src/complex.ts"]);
    assert.deepEqual(offenders.get("apps/demo/src/complex.ts").map((entry) => entry.score), [21]);
  });
});
