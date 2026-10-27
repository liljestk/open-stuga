import { loadConfig } from "./config.js";
import { createApi } from "./app.js";
import { ensureSqliteSpillDirectory } from "./db.js";
import { startApiServer } from "./api-startup.js";
import { shutdownHttpServer } from "./http-shutdown.js";

const started = await startApiServer({
  loadConfiguration: () => {
    const config = loadConfig();
    ensureSqliteSpillDirectory(config.databasePath);
    return config;
  },
  createRuntime: config => createApi({ config, startBackground: true }),
  write: record => console.error(JSON.stringify(record)),
}).catch(() => {
  // The startup helper already logged a fixed, redacted classification.
  process.exit(1);
});
const { runtime, server } = started;

let shutdownPromise: Promise<void> | null = null;

function shutdown(): void {
  if (shutdownPromise) return;
  shutdownPromise = shutdownHttpServer(server, runtime)
    .then(({ forced }) => process.exit(forced ? 1 : 0))
    .catch(() => {
      // Avoid logging configuration or exception details that might include
      // integration context during an emergency shutdown.
      console.error("Stugu API shutdown failed");
      process.exit(1);
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
