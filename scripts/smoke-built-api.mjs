import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const contractsUrl = import.meta.resolve("@climate-twin/contracts");

if (!new URL(contractsUrl).pathname.endsWith("/dist/index.js")) {
  throw new Error(`Contracts runtime must resolve to dist/index.js, received ${contractsUrl}`);
}

const [{ SYSTEM_VERSION }, { createApi }, { loadConfig }] = await Promise.all([
  import("@climate-twin/contracts"),
  import(new URL("apps/api/dist/app.js", root)),
  import(new URL("apps/api/dist/config.js", root)),
]);

if (SYSTEM_VERSION !== manifest.version) {
  throw new Error(`Built contracts version ${SYSTEM_VERSION} does not match package version ${manifest.version}`);
}

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_PATH: ":memory:",
  MOCK_ENABLED: "false",
  API_HOST: "127.0.0.1",
});
const runtime = createApi({ config, startBackground: false });
const server = createServer(runtime.app);

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Built API did not bind a TCP port");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
  if (!response.ok) throw new Error(`Built API health check returned HTTP ${response.status}`);
  console.log(`Built API ${SYSTEM_VERSION} started successfully with ${process.version}.`);
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  runtime.close();
}
