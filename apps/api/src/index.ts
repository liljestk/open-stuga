import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createApi } from "./app.js";

const config = loadConfig();
const runtime = createApi({ config, startBackground: true });
const server = createServer(runtime.app);

server.listen(config.port, config.apiHost, () => {
  // Do not log configuration: it may contain integration credentials.
  console.log(`Climate Twin API listening on http://${config.apiHost}:${config.port}/api/v1`);
});

function shutdown(): void {
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
