function npmTest(id, label, script, next = `npm run ${script}`) {
  return { id, label, command: "npm", args: ["run", script], next };
}

function workspaceChanged(id, label, workspace, mergeBase) {
  const next = `npm test -w ${workspace}`;
  return {
    id,
    label,
    command: "npm",
    args: ["test", "-w", workspace, "--", "--changed", mergeBase, "--passWithNoTests"],
    next,
  };
}

function workspaceFull(id, label, workspace) {
  return {
    id,
    label,
    command: "npm",
    args: ["test", "-w", workspace],
    next: `npm test -w ${workspace}`,
  };
}

const SCRIPT_TESTS = [
  [/^(?:scripts\/(?:stugu-)?(?:backup|restore)|docker-compose)/u, "test:r2-backup"],
  [/^scripts\/(?:stugu-live-migrate|stugu-migration|migrate-telemetry)/u, "test:live-migration"],
  [/^scripts\/(?:cloudflare|local-ci|setup)/u, "test:setup"],
  [/^scripts\/(?:stugu-update-agent|stugu-storage)/u, "test:update-agent"],
  [/^scripts\/(?:tooling\/|build-host|host-release|publish-local-release|local-release|release-verify|rpi-doctor|deploy-rpi-ota)/u, "test:rpi-ota"],
  [/^scripts\/(?:build-nexus433|smoke-nexus433)/u, "test:nexus433-runtime"],
];

export function affectedTestPlan(files, mergeBase) {
  const plan = new Map();
  const add = (item) => plan.set(item.id, item);
  const any = (pattern) => files.some((file) => pattern.test(file));

  const globalConfiguration = any(/^(?:package-lock\.json|tsconfig[^/]*\.json|\.npmrc)$/u);
  const packageMetadata = any(/^package\.json$/u);
  const contracts = any(/^packages\/(?:contracts|stuguby-protocol)\//u);
  const api = any(/^apps\/api\//u);
  const web = any(/^apps\/web\//u);
  const spatial = any(/^packages\/spatial-layers\//u);
  const kernel = any(/^packages\/analytics-kernel\//u);
  const bugReportRelay = any(/^apps\/bug-report-relay\//u);
  const tapoExportRunner = any(/^apps\/tapo-export-runner\//u);

  if (globalConfiguration || packageMetadata || contracts) {
    add(workspaceFull("TEST_API", "API tests", "@climate-twin/api"));
    add(workspaceFull("TEST_WEB", "Web tests", "@climate-twin/web"));
    add(workspaceFull("TEST_SPATIAL", "Spatial-layer tests", "@climate-twin/spatial-layers"));
    add(workspaceFull("TEST_ANALYTICS_KERNEL", "Analytics kernel tests", "@climate-twin/analytics-kernel"));
    add(workspaceFull("TEST_BUG_REPORT_RELAY", "Bug-report relay tests", "@climate-twin/bug-report-relay"));
    add(workspaceFull("TEST_TAPO_EXPORT_RUNNER", "Tapo export runner tests", "@climate-twin/tapo-export-runner"));
  } else {
    if (kernel) {
      // Every API analytics path consumes the kernel, so a kernel change reruns all of them.
      add(workspaceFull("TEST_ANALYTICS_KERNEL", "Analytics kernel tests", "@climate-twin/analytics-kernel"));
      add(workspaceFull("TEST_API", "API tests", "@climate-twin/api"));
    } else if (api) add(workspaceChanged("TEST_API", "Affected API tests", "@climate-twin/api", mergeBase));
    if (web) add(workspaceChanged("TEST_WEB", "Affected web tests", "@climate-twin/web", mergeBase));
    if (spatial) {
      add(workspaceChanged(
        "TEST_SPATIAL",
        "Affected spatial-layer tests",
        "@climate-twin/spatial-layers",
        mergeBase,
      ));
    }
    if (bugReportRelay) add(workspaceFull("TEST_BUG_REPORT_RELAY", "Bug-report relay tests", "@climate-twin/bug-report-relay"));
    if (tapoExportRunner) add(workspaceFull("TEST_TAPO_EXPORT_RUNNER", "Tapo export runner tests", "@climate-twin/tapo-export-runner"));
  }

  if (any(/^apps\/ios\//u)) add(npmTest("TEST_NATIVE_READINESS", "Native readiness tests", "test:native-readiness"));

  if (packageMetadata || any(/^scripts\/(?:tooling\/|verify-local\.mjs$|release-verify\.mjs$|rpi-doctor\.mjs$|tests\/lean-tooling\.test\.mjs$)/u)) {
    add(npmTest("TEST_LEAN_TOOLING", "Lean tooling tests", "test:lean-tooling"));
  }

  for (const [pattern, script] of SCRIPT_TESTS) {
    if (files.some((file) => pattern.test(file))) {
      add(npmTest(`TEST_${script.replace(/^test:/u, "").replaceAll("-", "_").toUpperCase()}`, `${script} tests`, script));
    }
  }

  if (any(/^deploy\/rpi\/host-updater\//u)) {
    add(npmTest("TEST_HOST_UPDATER", "Host-updater tests", "test:host-updater"));
    add(npmTest("TEST_RPI_OTA", "Raspberry Pi release tests", "test:rpi-ota"));
  } else if (any(/^deploy\/rpi\//u)) {
    add(npmTest("TEST_RPI_OTA", "Raspberry Pi release tests", "test:rpi-ota"));
  }

  if (any(/^(?:Dockerfile|docker-compose[^/]*\.ya?ml|deploy\/(?:mqtt|nexus433)\/)/u)) {
    add(npmTest("TEST_NEXUS433_RUNTIME", "Container runtime tests", "test:nexus433-runtime"));
  }
  if (any(/^\.github\/workflows\//u)) {
    add(npmTest("TEST_RPI_OTA", "Release workflow tests", "test:rpi-ota"));
  }

  for (const file of files.filter((path) => /^scripts\/tests\/.*\.test\.mjs$/u.test(path))) {
    if (file === "scripts/tests/lean-tooling.test.mjs") continue;
    const id = `TEST_FILE_${file.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}`;
    add({
      id,
      label: `Changed tooling test ${file}`,
      command: process.execPath,
      args: ["--test", file],
      next: `node --test ${file}`,
    });
  }

  return [...plan.values()];
}
