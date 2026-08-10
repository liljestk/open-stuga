import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createCheckPlan,
  parseArguments,
  platformInvocation,
  reportPaths,
  writeReport,
} from "../local-ci.mjs";

function receiptFixture(t) {
  const temporary = realpathSync.native(
    mkdtempSync(join(tmpdir(), "stugu-local-ci-")),
  );
  const repository = join(temporary, "repository");
  const outside = join(temporary, "outside");
  mkdirSync(repository);
  mkdirSync(outside);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  return { outside, repository, temporary };
}

test("local CI options are explicit", () => {
  assert.deepEqual(
    parseArguments([
      "--install",
      "--base-ref",
      "origin/main",
      "--skip-container-builds",
      "--with-sonar",
    ]),
    {
      help: false,
      install: true,
      baseRef: "origin/main",
      skipContainerBuilds: true,
      withSonar: true,
    },
  );
  assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/);
});

test("local CI covers validation and records platform-only Apple checks", () => {
  const common = {
    baseRef: "base-sha",
    baseVersionCheck: true,
    commit: "a".repeat(40),
  };
  const windowsPlan = createCheckPlan({
    ...common,
    currentPlatform: "win32",
  });
  const windowsCommands = windowsPlan.map(({ command, args }) =>
    [command, ...args].join(" "),
  );

  assert.match(windowsCommands.join("\n"), /npm run version:check-pr/);
  assert.match(windowsCommands.join("\n"), /npm run typecheck/);
  assert.match(windowsCommands.join("\n"), /ruff check/);
  assert.match(windowsCommands.join("\n"), /npm run test:coverage/);
  assert.match(windowsCommands.join("\n"), /npm run test:tooling/);
  assert.match(windowsCommands.join("\n"), /npm run test:coverage:python/);
  assert.match(windowsCommands.join("\n"), /docker compose/);
  assert.match(windowsCommands.join("\n"), /docker build --target api/);
  assert.match(windowsCommands.join("\n"), /docker build --target update-agent/);
  assert.match(windowsCommands.join("\n"), /docker build --target runtime --file deploy\/mqtt\/Dockerfile/);
  assert.match(windowsCommands.join("\n"), /docker build --target runtime --file deploy\/nexus433\/Dockerfile/);
  assert.match(windowsCommands.join("\n"), /npm run smoke:built-api/);
  assert.doesNotMatch(windowsCommands.join("\n"), /xcodebuild/);

  const macPlan = createCheckPlan({
    ...common,
    currentPlatform: "darwin",
    skipContainerBuilds: true,
  });
  const macCommands = macPlan.map(({ command, args }) =>
    [command, ...args].join(" "),
  );
  assert.match(macCommands.join("\n"), /swift test --package-path apps\/ios/);
  assert.match(macCommands.join("\n"), /generic\/platform=iOS Simulator/);
  assert.match(macCommands.join("\n"), /variant=Mac Catalyst/);
  assert.doesNotMatch(macCommands.join("\n"), /docker build --target/);
});

test("local CI receipt names are deterministic", (t) => {
  const { repository } = receiptFixture(t);
  const paths = reportPaths(repository, "1.2.3");
  assert.match(paths.report, /stugu-1\.2\.3-local-ci\.json$/);
  assert.equal(paths.checksum, `${paths.report}.sha256`);
});

test("local CI permits only dist/ci or destinations outside the worktree", (t) => {
  const { outside, repository } = receiptFixture(t);

  assert.doesNotThrow(() =>
    reportPaths(repository, "1.2.3", {
      report: join(repository, "dist", "ci", "custom.json"),
    }),
  );
  assert.doesNotThrow(() =>
    reportPaths(repository, "1.2.3", {
      report: join(outside, "custom.json"),
    }),
  );
  assert.throws(
    () =>
      reportPaths(repository, "1.2.3", {
        report: join(repository, "receipt.json"),
      }),
    /must be under .*dist.*ci or outside the Git worktree/u,
  );
  assert.throws(
    () =>
      reportPaths(repository, "1.2.3", {
        checksum: join(repository, "dist", "other", "receipt.sha256"),
      }),
    /must be under .*dist.*ci or outside the Git worktree/u,
  );
});

test("local CI rejects aliases and colliding destinations", (t) => {
  const { outside, repository, temporary } = receiptFixture(t);
  const alias = join(temporary, "worktree-alias");
  symlinkSync(
    repository,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.throws(
    () =>
      reportPaths(repository, "1.2.3", {
        report: join(alias, "receipt.json"),
      }),
    /symbolic-link|junction|alias/u,
  );

  const collision = join(outside, "collision.json");
  assert.throws(
    () =>
      reportPaths(repository, "1.2.3", {
        report: collision,
        checksum: collision,
      }),
    /destinations collide/u,
  );
  assert.throws(
    () =>
      reportPaths(repository, "1.2.3", {
        report: join(outside, "case.json"),
        checksum: join(outside, "CASE.JSON"),
      }),
    /destinations collide/u,
  );
});

test("local CI rejects hard-link aliases", (t) => {
  const { outside, repository } = receiptFixture(t);
  const report = join(outside, "report.json");
  const checksum = join(outside, "report.json.sha256");
  writeFileSync(report, "same file", "utf8");
  linkSync(report, checksum);

  assert.throws(
    () => reportPaths(repository, "1.2.3", { report, checksum }),
    /hard-link alias|filesystem aliases/u,
  );
});

test("local CI never replaces differing receipt files", (t) => {
  const { outside, repository } = receiptFixture(t);
  const paths = reportPaths(repository, "1.2.3", {
    report: join(outside, "receipt.json"),
  });
  writeFileSync(paths.checksum, "different\n", "utf8");

  assert.throws(
    () => writeReport(paths, { result: "passed" }, repository),
    /checksum already exists with different content/u,
  );
  assert.equal(existsSync(paths.report), false);
});

test("local CI writes receipts atomically and accepts identical files", (t) => {
  const { outside, repository } = receiptFixture(t);
  const paths = reportPaths(repository, "1.2.3", {
    report: join(outside, "receipt.json"),
  });
  const receipt = { result: "passed" };

  writeReport(paths, receipt, repository);
  assert.equal(
    readFileSync(paths.report, "utf8"),
    '{\n  "result": "passed"\n}\n',
  );
  assert.match(
    readFileSync(paths.checksum, "utf8"),
    /^[a-f0-9]{64}  receipt\.json\n$/u,
  );
  assert.doesNotThrow(() => writeReport(paths, receipt, repository));
});

test("local CI invokes npm through Node on Windows", () => {
  assert.deepEqual(
    platformInvocation("npm", ["run", "build"], {
      currentPlatform: "win32",
      env: { npm_execpath: "C:\\node\\npm-cli.js" },
      execPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\node\\npm-cli.js", "run", "build"],
    },
  );
});

test("release metadata is aligned across repository and Apple projects", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../check-version.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  assert.match(output, /repository, package, Apple, and changelog metadata/);
});

test("GitHub-hosted CI cannot start automatically", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const triggerBlock = /^on:\r?\n(?<triggers>[\s\S]*?)^permissions:/mu.exec(
    workflow,
  )?.groups?.triggers;
  assert.ok(triggerBlock);
  assert.deepEqual(
    [...triggerBlock.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]),
    ["workflow_dispatch"],
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_hosted_run:/);
  assert.match(workflow, /if: \$\{\{ inputs\.confirm_hosted_run \}\}/);
});
