import { CloudSun, LocateFixed } from "lucide-react";
import type { House, HouseLocation, Property, PropertyPatch } from "@climate-twin/contracts";
import { LocationDiscoveryPanel, type DiscoveredHomeDefaults } from "../../components/LocationDiscoveryPanel";
import { useI18n } from "../../i18n";

interface PropertyWeatherSettingsProps {
  property: Property;
  houses: House[];
  readOnly: boolean;
  onUpdateProperty: (id: string, patch: PropertyPatch) => Promise<Property>;
}

function homeLocationCandidate(houses: House[]): { house: House; location: HouseLocation } | null {
  for (const house of houses) {
    if (house.mapPlacement) {
      return {
        house,
        location: {
          latitude: house.mapPlacement.latitude,
          longitude: house.mapPlacement.longitude,
          source: "map-placement",
          confidence: "high",
          userOverridden: false,
        },
      };
    }
  }
  const located = houses.find((house) => house.location?.source !== "property-location" && house.location);
  return located?.location ? { house: located, location: located.location } : null;
}

export function PropertyWeatherSettings({ property, houses, readOnly, onUpdateProperty }: Readonly<PropertyWeatherSettingsProps>) {
  const { t } = useI18n();
  const candidate = property.location ? null : homeLocationCandidate(houses);
  const timezone = houses[0]?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const saveDiscoveredLocation = async (defaults: DiscoveredHomeDefaults) => {
    await onUpdateProperty(property.id, { location: defaults.location });
  };
  const useHomeLocation = async () => {
    if (!candidate) return;
    await onUpdateProperty(property.id, { location: candidate.location });
  };

  return <section className="panel property-weather-settings" aria-labelledby="property-weather-title">
    <div className="panel-header">
      <div><span className="eyebrow">{property.name}</span><h2 id="property-weather-title">{t("setup.workspaceWeather")}</h2></div>
      <CloudSun size={20} aria-hidden="true" />
    </div>
    <p>{t("properties.weatherDescription")}</p>
    {!readOnly && <LocationDiscoveryPanel
      key={`${property.id}:${property.location?.latitude ?? "missing"}:${property.location?.longitude ?? "missing"}`}
      {...(property.location ? { currentLocation: property.location } : {})}
      currentTimezone={timezone}
      onApply={saveDiscoveredLocation}
    />}
    {candidate && !readOnly && <button type="button" className="secondary-button property-weather-home-default" onClick={() => void useHomeLocation()}>
      <LocateFixed size={15} aria-hidden="true" />{t("properties.useHomeLocationForWeather", { home: candidate.house.name })}
    </button>}
    {readOnly && <p className="property-help">{property.location?.label ?? t(property.location ? "weather.locationSet" : "weather.locationMissing")}</p>}
  </section>;
}
