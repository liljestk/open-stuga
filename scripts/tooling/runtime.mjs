import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export class ToolFailure extends Error {
  constructor(code, cause, next, logPath, options = {}) {
    super(cause, options);
    this.name = "ToolFailure";
    this.code = code;
    this.causeText = cause;
    this.next = next;
    this.logPath = logPath;
  }
}

export function failureText(error, fallback = {}) {
  const value = error instanceof ToolFailure
    ? error
    : new ToolFailure(
      fallback.code ?? "STUGU_TOOL_FAILED",
      error instanceof Error ? error.message : String(error),
      fallback.next ?? "Inspect the detailed log and retry the same command.",
      fallback.logPath ?? "unavailable",
    );
  const concise = (input, maximum) => {
    const line = String(input).replace(/\s+/gu, " ").trim();
    return line.length <= maximum ? line : `${line.slice(0, maximum - 1)}…`;
  };
  return [
    `FAIL ${value.code}`,
    `Cause: ${concise(value.causeText, 500)}`,
    `Next: ${concise(value.next, 320)}`,
    `Log: ${String(value.logPath ?? "unavailable").replace(/[\r\n]+/gu, " ")}`,
  ].join("\n");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(value) {
  return sha256(canonicalJson(value));
}

export function boundedJson(path, label, maximumBytes = 2 * 1024 * 1024) {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maximumBytes) {
    throw new Error(`${label} must be a regular file of at most ${maximumBytes} bytes`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

export function assertSha256(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be a lower-case SHA-256 digest`);
  return value;
}

function inside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export function assertOutsideRepository(path, repositoryRoot, label = "output") {
  if (inside(repositoryRoot, path)) throw new Error(`${label} must be outside the Git worktree`);
  return resolve(path);
}

export function stateDirectory(repositoryRoot, env = process.env) {
  const configured = env.STUGU_TOOLING_STATE_DIR?.trim();
  let directory;
  if (configured) {
    directory = isAbsolute(configured) ? configured : resolve(repositoryRoot, configured);
  } else if (platform() === "win32") {
    directory = join(env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "Stugu", "tooling");
  } else {
    directory = join(env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "stugu", "tooling");
  }
  assertOutsideRepository(directory, repositoryRoot, "STUGU_TOOLING_STATE_DIR");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resolve(directory);
}

export function runIdentifier(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/gu, "-")}-${randomBytes(4).toString("hex")}`;
}

export function logPathFor(repositoryRoot, command, env = process.env) {
  const directory = join(stateDirectory(repositoryRoot, env), "logs", command);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${runIdentifier()}.log`);
}

export function ensureLog(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const descriptor = openSync(path, "wx", 0o600);
    closeSync(descriptor);
  }
  return path;
}

export function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(authorization|token|password|secret|credential|api[_-]?key|cookie)(\s*[:=]\s*)([^\s,;]+)/giu, "$1$2[REDACTED]")
    .replace(/(https?:\/\/[^\s/?#]+\/[^\s?#]*\?)[^\s#]*/giu, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, "[REDACTED KEY]");
}

function redactSensitive(value, sensitiveValues = []) {
  let output = String(value);
  for (const sensitive of [...sensitiveValues].filter(Boolean).sort((left, right) => right.length - left.length)) {
    output = output.split(String(sensitive)).join("[REDACTED]");
  }
  return output;
}

export function appendLog(path, value) {
  ensureLog(path);
  appendFileSync(path, redact(value), { encoding: "utf8", mode: 0o600 });
}

export function printable(command, args) {
  const quote = (value) => (/[^A-Za-z0-9_./:@%+=,-]/u.test(value) ? JSON.stringify(value) : value);
  return [command, ...args].map((value) => quote(String(value))).join(" ");
}

export function platformInvocation(command, args, {
  currentPlatform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  if (currentPlatform === "win32" && command === "npm") {
    if (!env.npm_execpath) {
      throw new Error("npm_execpath is unavailable; run this command through npm");
    }
    return { command: execPath, args: [env.npm_execpath, ...args] };
  }
  return { command, args };
}

export async function runLogged({
  command,
  args = [],
  displayCommand,
  cwd,
  env = process.env,
  input,
  logPath,
  timeoutMs = 0,
  capture = false,
  onLine,
  sanitizeLogLine,
  sensitiveValues = [],
}) {
  ensureLog(logPath);
  const invocation = platformInvocation(command, args, { env });
  appendLog(logPath, `\n> ${displayCommand ?? printable(command, args)}\n`);

  return new Promise((resolveRun) => {
    let settled = false;
    let timedOut = false;
    let captured = "";
    let capturedStdout = "";
    let capturedStderr = "";
    let stdoutRaw = "";
    let stderrRaw = "";
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs)
      : null;

    const consume = (stream, source) => {
      if (capture) {
        stream.on("data", (chunk) => {
          const value = chunk.toString("utf8");
          if (source === "stdout" && stdoutRaw.length < MAX_CAPTURE_BYTES) stdoutRaw += value;
          if (source === "stderr" && stderrRaw.length < MAX_CAPTURE_BYTES) stderrRaw += value;
        });
      }
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const safeLine = sanitizeLogLine ? sanitizeLogLine(line, source) : line;
        if (safeLine !== null && safeLine !== undefined) {
          appendLog(logPath, redactSensitive(`[${source}] ${safeLine}\n`, sensitiveValues));
        }
        if (capture && captured.length < MAX_CAPTURE_BYTES) {
          captured += `${line}\n`;
          if (source === "stdout" && capturedStdout.length < MAX_CAPTURE_BYTES) capturedStdout += `${line}\n`;
          if (source === "stderr" && capturedStderr.length < MAX_CAPTURE_BYTES) capturedStderr += `${line}\n`;
        }
        onLine?.(line, source);
      });
    };
    consume(child.stdout, "stdout");
    consume(child.stderr, "stderr");

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      appendLog(logPath, redactSensitive(`[error] ${error.message}\n`, sensitiveValues));
      resolveRun({
        status: null,
        signal: null,
        error,
        timedOut,
        output: captured.trimEnd(),
        stdout: capturedStdout.trimEnd(),
        stderr: capturedStderr.trimEnd(),
        stdoutRaw,
        stderrRaw,
      });
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        status,
        signal,
        error: null,
        timedOut,
        output: captured.trimEnd(),
        stdout: capturedStdout.trimEnd(),
        stderr: capturedStderr.trimEnd(),
        stdoutRaw,
        stderrRaw,
      });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function capture(command, args, { cwd, env = process.env, encoding = "utf8", maximumBytes = 64 * 1024 * 1024 } = {}) {
  const invocation = platformInvocation(command, args, { env });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding,
    maxBuffer: maximumBytes,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${printable(command, args)} failed: ${String(result.stderr ?? "").trim() || result.status}`);
  }
  return result.stdout;
}

function fileIdentity(path) {
  if (!existsSync(path)) return { kind: "missing", sha256: sha256("missing") };
  const details = lstatSync(path);
  if (details.isSymbolicLink()) {
    const target = readlinkSync(path);
    return { kind: "symlink", sha256: sha256(target), size: Buffer.byteLength(target) };
  }
  if (!details.isFile()) return { kind: "other", sha256: sha256(details.mode.toString(8)), size: 0 };
  return { kind: "file", sha256: sha256File(path), size: details.size };
}

function nulList(value) {
  return String(value).split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

const CONFIGURATION_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+|Dockerfile|docker-compose[^/]*\.ya?ml|\.npmrc)$/u;

export function repositorySnapshot(repositoryRoot) {
  const commit = String(capture("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).trim();
  const status = capture("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "buffer",
  });
  const trackedDiff = capture(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"],
    { cwd: repositoryRoot, encoding: "buffer" },
  );
  const allPaths = nulList(capture(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repositoryRoot },
  )).sort();
  const untracked = new Set(nulList(capture(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: repositoryRoot },
  )));
  const untrackedFiles = [...untracked].sort().map((path) => ({
    path,
    ...fileIdentity(resolve(repositoryRoot, path)),
  }));
  const configuration = allPaths
    .filter((path) => CONFIGURATION_FILE.test(path)
      || path.startsWith(".github/workflows/")
      || /^scripts\/(?:local-ci|check-[^/]+)\.mjs$/u.test(path))
    .map((path) => ({ path, ...fileIdentity(resolve(repositoryRoot, path)) }));
  const lockfilePath = resolve(repositoryRoot, "package-lock.json");
  const lockfileSha256 = existsSync(lockfilePath) ? sha256File(lockfilePath) : sha256("missing");
  const statusSha256 = sha256(status);
  const trackedDiffSha256 = sha256(trackedDiff);
  const configurationSha256 = cacheKey(configuration);
  const worktreeSha256 = cacheKey({
    commit,
    statusSha256,
    trackedDiffSha256,
    untrackedFiles,
  });
  return {
    commit,
    dirty: status.length > 0,
    worktreeSha256,
    statusSha256,
    trackedDiffSha256,
    untrackedFiles,
    lockfileSha256,
    configurationSha256,
  };
}

export function resolveBase(repositoryRoot, baseRef = "origin/main") {
  const verified = String(capture(
    "git",
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    { cwd: repositoryRoot },
  )).trim();
  const mergeBase = String(capture("git", ["merge-base", "HEAD", verified], { cwd: repositoryRoot })).trim();
  return { baseRef, baseCommit: verified, mergeBase };
}

export function changedFiles(repositoryRoot, baseRef = "origin/main") {
  const base = resolveBase(repositoryRoot, baseRef);
  const changed = nulList(capture(
    "git",
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", base.mergeBase, "--"],
    { cwd: repositoryRoot },
  ));
  const untracked = nulList(capture(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: repositoryRoot },
  ));
  return {
    ...base,
    files: [...new Set([...changed, ...untracked])].sort(),
    untrackedFiles: [...new Set(untracked)].sort(),
  };
}

export function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function writeJsonReceipt(path, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== contents) throw new Error(`Receipt already exists with different content: ${path}`);
  } else {
    atomicWrite(path, contents);
  }
  const digest = sha256(contents);
  const checksumPath = `${path}.sha256`;
  const checksum = `${digest}  ${basename(path)}\n`;
  if (!existsSync(checksumPath)) atomicWrite(checksumPath, checksum);
  else if (readFileSync(checksumPath, "utf8") !== checksum) {
    throw new Error(`Receipt checksum already exists with different content: ${checksumPath}`);
  }
  return { path, checksumPath, sha256: digest };
}

export function verifyReceiptChecksum(path, label = "receipt") {
  const digest = sha256File(path);
  const checksumPath = `${path}.sha256`;
  const details = lstatSync(checksumPath);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 512) {
    throw new Error(`${label} checksum must be a small regular file`);
  }
  if (readFileSync(checksumPath, "utf8") !== `${digest}  ${basename(path)}\n`) {
    throw new Error(`${label} checksum does not match`);
  }
  return { path, checksumPath, sha256: digest };
}

export function receiptDigest(path) {
  const details = statSync(path);
  if (!details.isFile()) throw new Error(`Receipt is not a regular file: ${path}`);
  return sha256File(path);
}
