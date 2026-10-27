import { useMutation } from "@tanstack/react-query";
import type { Point, Sensor, SensorPatch } from "@climate-twin/contracts";
import { api, type CreateSensorInput } from "../../api";
import { queryClient } from "../queryClient";

export const sensorMutationKeys = {
  all: ["sensor-mutations"] as const,
  create: ["sensor-mutations", "create"] as const,
  update: ["sensor-mutations", "update"] as const,
  move: ["sensor-mutations", "move"] as const,
  delete: ["sensor-mutations", "delete"] as const,
};

interface UpdateSensorVariables {
  sensorId: string;
  patch: SensorPatch;
  previousHouseId: string | undefined;
}

interface MoveSensorVariables {
  sensorId: string;
  point: Point;
  previousHouseId?: string;
}

interface DeleteSensorVariables {
  sensorId: string;
  houseId: string | undefined;
}

function affectsHouse(queryKey: readonly unknown[], houseIds: ReadonlySet<string>): boolean {
  if (queryKey[0] === "monitoring" && queryKey[1] === "houses") return true;
  if (queryKey[0] === "house" && typeof queryKey[1] === "string") {
    return houseIds.size === 0 || houseIds.has(queryKey[1]);
  }
  if (queryKey[0] === "analytics"
    && (queryKey[1] === "opening-activity" || queryKey[1] === "calendar-comparison")
    && typeof queryKey[2] === "string") {
    return houseIds.size === 0 || houseIds.has(queryKey[2]);
  }
  return false;
}

function invalidateSensorDerivedQueries(...houseIds: Array<string | undefined>): void {
  const affected = new Set(houseIds.filter((id): id is string => Boolean(id)));
  void queryClient.invalidateQueries({
    predicate: (query) => affectsHouse(query.queryKey, affected),
  });
}

function affectedHouses(saved: Sensor, previousHouseId?: string): Array<string | undefined> {
  return [previousHouseId, saved.houseId];
}

/**
 * Owns sensor network writes in TanStack MutationCache. Sensor read state remains
 * part of the legacy Home snapshot until that separate ownership family moves.
 */
export function useSensorMutations() {
  const create = useMutation({
    mutationKey: sensorMutationKeys.create,
    mutationFn: (input: CreateSensorInput) => api.createSensor(input),
    onSuccess: (saved) => invalidateSensorDerivedQueries(saved.houseId),
    meta: { resourceFamily: "sensorMutations", operation: "create" },
  }, queryClient);
  const update = useMutation({
    mutationKey: sensorMutationKeys.update,
    mutationFn: ({ sensorId, patch }: UpdateSensorVariables) => api.updateSensor(sensorId, patch),
    onSuccess: (saved, variables) => {
      invalidateSensorDerivedQueries(...affectedHouses(saved, variables.previousHouseId));
    },
    meta: { resourceFamily: "sensorMutations", operation: "update" },
  }, queryClient);
  const move = useMutation({
    mutationKey: sensorMutationKeys.move,
    mutationFn: ({ sensorId, point }: MoveSensorVariables) => api.updateSensor(sensorId, point),
    onSuccess: (saved, variables) => {
      invalidateSensorDerivedQueries(...affectedHouses(saved, variables.previousHouseId));
    },
    meta: { resourceFamily: "sensorMutations", operation: "move" },
  }, queryClient);
  const remove = useMutation({
    mutationKey: sensorMutationKeys.delete,
    mutationFn: ({ sensorId }: DeleteSensorVariables) => api.deleteSensor(sensorId),
    onSuccess: (_result, variables) => invalidateSensorDerivedQueries(variables.houseId),
    meta: { resourceFamily: "sensorMutations", operation: "delete" },
  }, queryClient);

  return {
    createSensor: create.mutateAsync,
    updateSensor: update.mutateAsync,
    moveSensor: move.mutateAsync,
    deleteSensor: remove.mutateAsync,
  };
}
