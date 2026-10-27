import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import { MOCK_SCENARIOS } from "../services.js";
import { HttpError, bodyObject, dateValue, enumValue } from "./support/index.js";
import type { ApiRouteRegistrationContext } from "./route-registration-context.js";

/** Mock scenarios and recorded-data replay for demo installations. */
export function registerDemoDataRoutes(context: ApiRouteRegistrationContext): void {
  context.app.get(`${context.prefix}/mock/scenarios`, (_request, response) => {
      context.dataMode.synchronize();
      response.json({ scenarios: MOCK_SCENARIOS, active: context.mock.scenario, enabled: context.status.value.mock.enabled });
    });
  context.app.put(`${context.prefix}/mock/scenario`, (request, response) => {
      const scenario = enumValue(bodyObject(request.body).scenario, MOCK_SCENARIOS.map((item) => item.id), "scenario");
      context.mock.setScenario(scenario);
      response.json({ active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/scenario`, (request, response) => {
      const body = bodyObject(request.body);
      const scenario = enumValue(body.scenarioId ?? body.scenario, MOCK_SCENARIOS.map((item) => item.id), "scenarioId");
      context.mock.setScenario(scenario);
      response.json({ ok: true, active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/tick`, (_request, response) => response.status(201).json({ readings: context.mock.generate(), scenario: context.mock.scenario }));
  context.app.get(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.state }));
  context.app.post(`${context.prefix}/replay`, async (request, response) => {
      const body = bodyObject(request.body);
      const sensorIds = Array.isArray(body.sensorIds)
        ? body.sensorIds.filter((id): id is string => typeof id === "string")
        : context.database.listSensors()
            .filter((sensor) => {
              const house = context.database.getHouse(sensor.houseId);
              return Boolean(house && hasLocalHouseAuthority(house));
            })
            .map((sensor) => sensor.id);
      for (const sensorId of sensorIds) {
        const sensor = context.database.getSensor(sensorId);
        if (!sensor) throw new HttpError(404, "NOT_FOUND", `Sensor ${sensorId} not found`);
        context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const to = dateValue(body.to, new Date(), "to");
      const from = dateValue(body.from, new Date(Date.parse(to) - 3_600_000), "from");
      const speed = typeof body.speed === "number" ? body.speed : 60;
      const readings = (await context.telemetryReader.legacyReadingHistory({ sensorIds, from, to, limit: 50_000 })).records;
      response.status(202).json({ replay: context.replay.startReadings(readings, from, to, speed) });
    });
  context.app.delete(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.stop() }));
}
