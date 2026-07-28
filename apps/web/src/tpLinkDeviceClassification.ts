import type {
  AirflowPlanElement,
  Floor,
  House,
  OpeningStateBinding,
  Sensor,
  TpLinkDiscoveredDevice,
} from "@climate-twin/contracts";

export type TpLinkDeviceType = NonNullable<TpLinkDiscoveredDevice["deviceType"]>;

export function tpLinkDeviceType(
  device: Pick<TpLinkDiscoveredDevice, "deviceType" | "model" | "contactOpen" | "temperature" | "humidity" | "power" | "energy">,
): TpLinkDeviceType {
  if (device.deviceType && device.deviceType !== "unknown") return device.deviceType;
  const model = device.model.trim().toUpperCase();
  if (typeof device.contactOpen === "boolean" || /\bT110\b/u.test(model)) return "contact";
  if (typeof device.power === "number" || typeof device.energy === "number") return "energy";
  if (typeof device.temperature === "number" || typeof device.humidity === "number"
    || /^T3(?:10|15)(?:\b|\s|\()/u.test(model)) return "climate";
  return "unknown";
}

export function isTpLinkContactDevice(device: TpLinkDiscoveredDevice): boolean {
  return tpLinkDeviceType(device) === "contact";
}

export function tpLinkOpeningMatchesDevice(
  binding: OpeningStateBinding | undefined,
  device: Pick<TpLinkDiscoveredDevice, "deviceId" | "connectionId">,
): boolean {
  return binding?.provider === "tapo"
    && binding.externalId === device.deviceId
    && (!binding.connectionId || binding.connectionId === device.connectionId);
}

export function houseHasTpLinkOpeningBinding(
  house: House,
  device: Pick<TpLinkDiscoveredDevice, "deviceId" | "connectionId" | "mappedOpening">,
): boolean {
  if (device.mappedOpening) return true;
  return house.floors.some((floor) => (floor.planElements ?? [])
    .some((element) => "stateBinding" in element && tpLinkOpeningMatchesDevice(element.stateBinding, device)));
}

export interface TpLinkOpeningTarget {
  floor: Floor;
  element: AirflowPlanElement;
}

export function tpLinkOpeningForDevice(
  house: House,
  device: Pick<TpLinkDiscoveredDevice, "deviceId" | "connectionId" | "mappedOpening">,
): TpLinkOpeningTarget | null {
  for (const floor of house.floors) {
    for (const element of floor.planElements ?? []) {
      if ("stateBinding" in element && tpLinkOpeningMatchesDevice(element.stateBinding, device)) {
        return { floor, element };
      }
    }
  }
  const mapped = device.mappedOpening;
  if (!mapped) return null;
  const floor = house.floors.find((candidate) => candidate.id === mapped.floorId);
  const element = floor?.planElements?.find((candidate) => candidate.id === mapped.elementId);
  return floor && element && "stateBinding" in element ? { floor, element } : null;
}

export function isLegacyTpLinkContactSensor(sensor: Pick<Sensor, "model" | "name">): boolean {
  return /\bT110\b/iu.test(sensor.model) || /\bT110\b/iu.test(sensor.name);
}

function normalizedDeviceLabel(value: string): string {
  return value.normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function tpLinkContactDeviceForSensor(
  sensor: Pick<Sensor, "id" | "name" | "model" | "tpLinkDeviceId" | "tpLinkConnectionId">,
  devices: readonly TpLinkDiscoveredDevice[],
): TpLinkDiscoveredDevice | null {
  const contacts = devices.filter(isTpLinkContactDevice);
  const direct = contacts.find((device) => sensor.tpLinkDeviceId === device.deviceId
    && (!sensor.tpLinkConnectionId || sensor.tpLinkConnectionId === device.connectionId));
  if (direct) return direct;
  const mapped = contacts.find((device) => device.mappedSensorId === sensor.id);
  if (mapped) return mapped;

  const sensorName = normalizedDeviceLabel(sensor.name);
  const aliases = contacts.filter((device) => {
    const alias = normalizedDeviceLabel(device.alias ?? "");
    return alias && (sensorName === alias || sensorName.startsWith(`${alias} `) || sensorName.includes(` ${alias} `));
  });
  if (aliases.length === 1) return aliases[0]!;

  const sensorModel = normalizedDeviceLabel(sensor.model);
  const modelMatches = contacts.filter((device) => {
    const deviceModel = normalizedDeviceLabel(device.model);
    return deviceModel === sensorModel
      || (/\bt110\b/u.test(deviceModel) && /\bt110\b/u.test(sensorModel || sensorName));
  });
  return modelMatches.length === 1 ? modelMatches[0]! : null;
}
