import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateAdaptiveMonitoring } from "./evaluation.js";
import { privateAdaptivePath } from "./private-path.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
  throw new Error("Usage: npm run adaptive:evaluate -- --output ABSOLUTE_PATH_OUTSIDE_GIT");
}
const output = privateAdaptivePath(args[1]);
const result = await evaluateAdaptiveMonitoring();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ kind: result.kind, canPromote: result.canPromote, results: result.results, output }, null, 2) + "\n");
