import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runAnalyticsBenchmark } from "./benchmark-analytics.mjs";

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

  // A year of 15-minute temperature and energy readings for the speed targets.
  const now = Date.now();
  const sensor = runtime.database.listSensors("house-main")[0];
  if (!sensor) throw new Error("The built API has no demo sensor to benchmark");
  const samples = [];
  let counter = 1_000;
  for (let time = now - 366 * 86_400_000; time <= now; time += 15 * 60_000) {
    const timestamp = new Date(time).toISOString();
    counter += 0.1 + 0.05 * Math.sin(time / 3_600_000);
    samples.push(
      { sensorId: sensor.id, metric: "temperature", value: 21 + Math.sin(time / 43_200_000), canonicalUnit: "°C", timestamp, source: "api", quality: "good" },
      { sensorId: sensor.id, metric: "energy", value: counter, canonicalUnit: "kWh", timestamp, source: "api", quality: "good" },
    );
  }
  runtime.database.insertMeasurementSamples(samples);
  const results = await runAnalyticsBenchmark({
    origin: `http://127.0.0.1:${address.port}`,
    houseId: "house-main",
    sensorId: sensor.id,
    dataMode: runtime.database.isRealDataMode() ? "live" : "demo",
    samples: 5,
    now,
  });
  console.table(results);
  const failed = results.filter((result) => !result.pass);
  if (failed.length > 0) {
    throw new Error(`Analytics speed targets missed: ${failed.map((result) => result.name).join(", ")}`);
  }
} finally {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  runtime.close();
}
