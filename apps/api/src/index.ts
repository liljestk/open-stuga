import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApi } from "./app.js";
import { shutdownHttpServer } from "./http-shutdown.js";

const config = loadConfig();
const runtime = createApi({ config, startBackground: true });
const server = createServer(runtime.app);

server.listen(config.port, config.apiHost, () => {
  // Do not log configuration: it may contain integration credentials.
  console.log(`Stuga API listening on http://${config.apiHost}:${config.port}/api/v1`);
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(): void {
  if (shutdownPromise) return;
  shutdownPromise = shutdownHttpServer(server, runtime)
    .then(({ forced }) => process.exit(forced ? 1 : 0))
    .catch(() => {
      // Avoid logging configuration or exception details that might include
      // integration context during an emergency shutdown.
      console.error("Stuga API shutdown failed");
      process.exit(1);
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
