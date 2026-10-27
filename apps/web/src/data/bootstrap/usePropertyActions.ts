import { useCallback } from "react";
import type { AreaEquipment, AreaEquipmentInput, AreaEquipmentPatch, Floor, House, HousePatch, Property, PropertyArea, PropertyAreaInput, PropertyAreaPatch, PropertyCreateInput, PropertyNote, PropertyNoteInput, PropertyNotePatch, PropertyPatch } from "@climate-twin/contracts";
import { automaticWeatherLocation, hasLocalHouseAuthority, isAutomaticWeatherLocation } from "@climate-twin/contracts";
import { api, type CreateHouseInput, type HouseGeoreferencePatch } from "../../api";
import { preferredHouseForProperty } from "../../domain";
import { replaceFloor, settleInBackground, synchronizeSensorRoomLabels } from "./support";
import type { PropertyActions, SensorContext } from "./pipelineTypes";
export function usePropertyActions(
  context: SensorContext,
): SensorContext & PropertyActions {
  const { setState, setBootstrapStatus, apiAvailable, stateRef, globalFieldVersions, recordInventoryMutation, ensurePropertyWrite, refreshMovedPropertyContext } = context;
  const createProperty = useCallback(async (input: PropertyCreateInput): Promise<Property> => {
      ensurePropertyWrite();
      const saved = await api.createProperty(input);
      setState((current) => ({ ...current, properties: [...current.properties.filter((item) => item.id !== saved.id), saved] }));
      setBootstrapStatus("ready");
      return saved;
    }, [ensurePropertyWrite]);
  const updateProperty = useCallback(async (id: string, patch: PropertyPatch): Promise<Property> => {
      ensurePropertyWrite();
      const saved = await api.updateProperty(id, patch);
      setState((current) => {
        const houses = patch.location === undefined ? current.houses : current.houses.map((house) => {
          if (house.propertyId !== id || !hasLocalHouseAuthority(house) || (house.location && !isAutomaticWeatherLocation(house.location))) return house;
          const inferred = automaticWeatherLocation(saved.location, house.mapPlacement);
          if (inferred) return { ...house, location: inferred, updatedAt: saved.updatedAt };
          const { location: _removed, ...withoutLocation } = house;
          return { ...withoutLocation, updatedAt: saved.updatedAt };
        });
        return {
          ...current,
          houses,
          properties: current.properties.map((item) => item.id === id ? saved : item),
          integration: {
            ...current.integration,
            weather: {
              ...current.integration.weather,
              configuredHouses: houses.filter((house) => Boolean(house.location)).length,
            },
          },
        };
      });
      return saved;
    }, [ensurePropertyWrite]);
  const deleteProperty = useCallback(async (id: string): Promise<void> => {
      ensurePropertyWrite();
      await api.deleteProperty(id);
      setState((current) => ({
        ...current,
        properties: current.properties.filter((item) => item.id !== id),
        propertyAreas: current.propertyAreas.filter((item) => item.propertyId !== id),
        areaEquipment: current.areaEquipment.filter((item) => item.propertyId !== id),
        propertyNotes: current.propertyNotes.filter((item) => item.propertyId !== id),
      }));
    }, [ensurePropertyWrite]);
  const createPropertyArea = useCallback(async (input: PropertyAreaInput): Promise<PropertyArea> => {
      ensurePropertyWrite();
      const saved = await api.createPropertyArea(input);
      setState((current) => ({ ...current, propertyAreas: [...current.propertyAreas.filter((item) => item.id !== saved.id), saved] }));
      return saved;
    }, [ensurePropertyWrite]);
  const updatePropertyArea = useCallback(async (id: string, patch: PropertyAreaPatch): Promise<PropertyArea> => {
      ensurePropertyWrite();
      const previousPropertyId = stateRef.current.propertyAreas.find((item) => item.id === id)?.propertyId;
      const saved = await api.updatePropertyArea(id, patch);
      setState((current) => {
        const movedEquipmentIds = new Set(current.areaEquipment.filter((item) => item.areaId === id).map((item) => item.id));
        const moved = current.propertyAreas.find((item) => item.id === id)?.propertyId !== saved.propertyId;
        return {
          ...current,
          propertyAreas: current.propertyAreas.map((item) => item.id === id ? saved : item),
          areaEquipment: moved
            ? current.areaEquipment.map((item) => item.areaId === id ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt } : item)
            : current.areaEquipment,
          propertyNotes: moved
            ? current.propertyNotes.map((item) => item.areaId === id || (item.equipmentId && movedEquipmentIds.has(item.equipmentId))
              ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
              : item)
            : current.propertyNotes,
          maintenanceTasks: moved
            ? current.maintenanceTasks.map((item) => item.areaId === id || (item.equipmentId && movedEquipmentIds.has(item.equipmentId))
              ? {
                ...item,
                propertyId: saved.propertyId,
                ...(item.houseId && !current.houses.some((house) => house.id === item.houseId && house.propertyId === saved.propertyId)
                  ? { houseId: null, floorId: null }
                  : {}),
                revision: item.revision + 1,
                updatedAt: saved.updatedAt,
              }
              : item)
            : current.maintenanceTasks,
        };
      });
      if (previousPropertyId !== undefined && previousPropertyId !== saved.propertyId) {
        settleInBackground(refreshMovedPropertyContext(true));
      }
      return saved;
    }, [ensurePropertyWrite, refreshMovedPropertyContext]);
  const deletePropertyArea = useCallback(async (id: string): Promise<void> => {
      ensurePropertyWrite();
      await api.deletePropertyArea(id);
      setState((current) => ({
        ...current,
        propertyAreas: current.propertyAreas.filter((item) => item.id !== id),
        areaEquipment: current.areaEquipment.filter((item) => item.areaId !== id),
        propertyNotes: current.propertyNotes.filter((item) => item.areaId !== id),
        maintenanceTasks: current.maintenanceTasks.map((item) => item.areaId === id ? { ...item, areaId: null, equipmentId: null } : item),
      }));
    }, [ensurePropertyWrite]);
  const createAreaEquipment = useCallback(async (input: AreaEquipmentInput): Promise<AreaEquipment> => {
      ensurePropertyWrite();
      const saved = await api.createAreaEquipment(input);
      setState((current) => ({ ...current, areaEquipment: [...current.areaEquipment.filter((item) => item.id !== saved.id), saved] }));
      return saved;
    }, [ensurePropertyWrite]);
  const updateAreaEquipment = useCallback(async (id: string, patch: AreaEquipmentPatch): Promise<AreaEquipment> => {
      ensurePropertyWrite();
      const previous = stateRef.current.areaEquipment.find((item) => item.id === id);
      const saved = await api.updateAreaEquipment(id, patch);
      setState((current) => {
        const previous = current.areaEquipment.find((item) => item.id === id);
        const moved = previous?.propertyId !== saved.propertyId || previous?.areaId !== saved.areaId;
        return {
          ...current,
          areaEquipment: current.areaEquipment.map((item) => item.id === id ? saved : item),
          propertyNotes: moved
            ? current.propertyNotes.map((item) => item.equipmentId === id
              ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
              : item)
            : current.propertyNotes,
          maintenanceTasks: moved
            ? current.maintenanceTasks.map((item) => item.equipmentId === id
              ? {
                ...item,
                propertyId: saved.propertyId,
                areaId: saved.areaId,
                ...(item.houseId && !current.houses.some((house) => house.id === item.houseId && house.propertyId === saved.propertyId)
                  ? { houseId: null, floorId: null }
                  : {}),
                revision: item.revision + 1,
                updatedAt: saved.updatedAt,
              }
              : item)
            : current.maintenanceTasks,
        };
      });
      if (previous && (previous.propertyId !== saved.propertyId || previous.areaId !== saved.areaId)) {
        settleInBackground(refreshMovedPropertyContext(true));
      }
      return saved;
    }, [ensurePropertyWrite, refreshMovedPropertyContext]);
  const deleteAreaEquipment = useCallback(async (id: string): Promise<void> => {
      ensurePropertyWrite();
      await api.deleteAreaEquipment(id);
      setState((current) => ({
        ...current,
        areaEquipment: current.areaEquipment.filter((item) => item.id !== id),
        propertyNotes: current.propertyNotes.filter((item) => item.equipmentId !== id),
        maintenanceTasks: current.maintenanceTasks.map((item) => item.equipmentId === id ? { ...item, equipmentId: null } : item),
      }));
    }, [ensurePropertyWrite]);
  const createPropertyNote = useCallback(async (input: PropertyNoteInput): Promise<PropertyNote> => {
      ensurePropertyWrite();
      const saved = await api.createPropertyNote(input);
      setState((current) => ({ ...current, propertyNotes: [...current.propertyNotes.filter((item) => item.id !== saved.id), saved] }));
      return saved;
    }, [ensurePropertyWrite]);
  const updatePropertyNote = useCallback(async (id: string, patch: PropertyNotePatch): Promise<PropertyNote> => {
      ensurePropertyWrite();
      const saved = await api.updatePropertyNote(id, patch);
      setState((current) => ({ ...current, propertyNotes: current.propertyNotes.map((item) => item.id === id ? saved : item) }));
      return saved;
    }, [ensurePropertyWrite]);
  const deletePropertyNote = useCallback(async (id: string): Promise<void> => {
      ensurePropertyWrite();
      await api.deletePropertyNote(id);
      setState((current) => ({ ...current, propertyNotes: current.propertyNotes.filter((item) => item.id !== id) }));
    }, [ensurePropertyWrite]);
  const setHouseGeoreference = useCallback(async (houseId: string, patch: HouseGeoreferencePatch) => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The location was not saved.");
      const saved = await api.updateHouseGeoreference(houseId, patch);
      recordInventoryMutation({ action: "upsert", value: saved });
      globalFieldVersions.current.integration += 1;
      setState((current) => {
        const nextHouses = [...current.houses.filter((house) => house.id !== houseId), saved];
        return {
          ...current,
          houses: nextHouses,
          integration: {
            ...current.integration,
            weather: {
              ...current.integration.weather,
              configuredHouses: nextHouses.filter((house) => Boolean(house.location)).length,
            },
          },
        };
      });
    }, [recordInventoryMutation]);
  const updateFloor = useCallback((houseId: string, floor: Floor) => {
      setState((current) => replaceFloor(current, houseId, floor));
    }, []);
  const updateHouseDraft = useCallback((houseId: string, patch: HousePatch) => {
      setState((current) => {
        const houses = current.houses.map((house) => house.id === houseId
          ? { ...house, ...patch, updatedAt: new Date().toISOString() } as House
          : house);
        const floors = houses.find((house) => house.id === houseId)?.floors ?? [];
        return {
          ...current,
          houses,
          sensors: synchronizeSensorRoomLabels(current.sensors, houseId, floors),
        };
      });
    }, []);
  /** Persist an atomic house metadata update, including inferred location and timezone defaults. */
    const updateHouse = useCallback(async (houseId: string, patch: HousePatch): Promise<House> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not saved.");
      const previousPropertyId = stateRef.current.houses.find((house) => house.id === houseId)?.propertyId;
      const saved = await api.updateHouse(houseId, patch);
      recordInventoryMutation({ action: "upsert", value: saved });
      globalFieldVersions.current.integration += 1;
      setState((current) => {
        const previous = current.houses.find((house) => house.id === houseId);
        const moved = previous?.propertyId !== saved.propertyId;
        const nextHouses = [...current.houses.filter((house) => house.id !== houseId), saved];
        const properties = moved && previous ? current.properties.map((item) => {
          if (item.id === previous.propertyId && item.defaultHouseId === houseId) {
            const replacement = preferredHouseForProperty({ id: item.id, defaultHouseId: null }, nextHouses);
            return { ...item, defaultHouseId: replacement?.id ?? null, updatedAt: saved.updatedAt };
          }
          if (item.id === saved.propertyId && item.defaultHouseId === null) {
            return { ...item, defaultHouseId: saved.id, updatedAt: saved.updatedAt };
          }
          return item;
        }) : current.properties;
        return {
          ...current,
          houses: nextHouses,
          properties,
          sensors: synchronizeSensorRoomLabels(current.sensors, houseId, saved.floors),
          propertyNotes: moved
            ? current.propertyNotes.map((item) => item.houseId === houseId
              ? { ...item, propertyId: saved.propertyId, updatedAt: saved.updatedAt }
              : item)
            : current.propertyNotes,
          maintenanceTasks: moved
            ? current.maintenanceTasks.map((item) => item.houseId === houseId
              ? {
                ...item,
                propertyId: saved.propertyId,
                areaId: item.areaId && current.propertyAreas.some((area) => area.id === item.areaId && area.propertyId === saved.propertyId)
                  ? item.areaId : null,
                equipmentId: item.equipmentId && current.areaEquipment.some((equipment) => equipment.id === item.equipmentId && equipment.propertyId === saved.propertyId)
                  ? item.equipmentId : null,
                revision: item.revision + 1,
                updatedAt: saved.updatedAt,
              }
              : item)
            : current.maintenanceTasks,
          integration: {
            ...current.integration,
            weather: {
              ...current.integration.weather,
              configuredHouses: nextHouses.filter((house) => Boolean(house.location)).length,
            },
          },
        };
      });
      if (previousPropertyId !== undefined && previousPropertyId !== saved.propertyId) {
        settleInBackground(refreshMovedPropertyContext(false));
      }
      return saved;
    }, [recordInventoryMutation, refreshMovedPropertyContext]);
  const createHouse = useCallback(async (input: CreateHouseInput): Promise<House> => {
      if (!apiAvailable.current) throw new Error("The local API is unavailable. The property was not created.");
      const saved = await api.createHouse(input);
      recordInventoryMutation({ action: "upsert", value: saved });
      setState((current) => ({
        ...current,
        houses: [...current.houses.filter((house) => house.id !== saved.id), saved],
        properties: current.properties.map((property) => property.id === saved.propertyId && property.defaultHouseId === null
          ? { ...property, defaultHouseId: saved.id, updatedAt: saved.updatedAt }
          : property),
      }));
      return saved;
    }, [recordInventoryMutation]);
  return Object.assign(context, { createProperty, updateProperty, deleteProperty, createPropertyArea, updatePropertyArea, deletePropertyArea, createAreaEquipment, updateAreaEquipment, deleteAreaEquipment, createPropertyNote, updatePropertyNote, deletePropertyNote, setHouseGeoreference, updateFloor, updateHouseDraft, updateHouse, createHouse });
}
