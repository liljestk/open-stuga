import { Check, Crosshair, LoaderCircle, MapPin, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { HouseLocation } from "@climate-twin/contracts";
import { api, type LocationSuggestion } from "../api";
import { useI18n } from "../i18n";

export interface DiscoveredHomeDefaults {
  location: HouseLocation;
  timezone: string;
  source: "place-search" | "browser-geolocation";
  confidence: "high" | "medium";
  discoveredAt: string;
}

interface LocationDiscoveryPanelProps {
  currentLocation?: HouseLocation;
  currentTimezone: string;
  onApply: (defaults: DiscoveredHomeDefaults) => Promise<void>;
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function LocationDiscoveryPanel({ currentLocation, currentTimezone, onApply }: LocationDiscoveryPanelProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationSuggestion[]>([]);
  const [announcedResultCount, setAnnouncedResultCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<LocationSuggestion | null>(null);
  const [deviceSuggestion, setDeviceSuggestion] = useState<DiscoveredHomeDefaults | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [changing, setChanging] = useState(!currentLocation);
  const searchGeneration = useRef(0);
  const locationGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    searchGeneration.current += 1;
    locationGeneration.current += 1;
    saveGeneration.current += 1;
    searchController.current?.abort();
  }, []);

  useEffect(() => {
    if (currentLocation) setChanging(false);
  }, [currentLocation?.latitude, currentLocation?.longitude]);

  const searchPlaces = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    const generation = ++searchGeneration.current;
    const requestedQuery = query.trim();
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setAnnouncedResultCount(null);
    setError(null);
    setSaved(false);
    setDeviceSuggestion(null);
    try {
      const next = await api.searchLocations(requestedQuery, locale, controller.signal);
      if (searchGeneration.current !== generation) return;
      setResults(next);
      setAnnouncedResultCount(next.length);
      setSelected(next.length === 1 ? next[0]! : null);
      if (next.length === 0) setError(t("locationDiscovery.noResults"));
    } catch {
      if (searchGeneration.current !== generation || controller.signal.aborted) return;
      setResults([]);
      setAnnouncedResultCount(null);
      setSelected(null);
      setError(t("locationDiscovery.searchError"));
    } finally {
      if (searchGeneration.current === generation) setSearching(false);
    }
  };

  const applyDefaults = async (defaults: DiscoveredHomeDefaults) => {
    const generation = ++saveGeneration.current;
    setSaving(true);
    setError(null);
    try {
      await onApply(defaults);
      if (saveGeneration.current !== generation) return;
      setSaved(true);
      if (currentLocation) setChanging(false);
    } catch {
      if (saveGeneration.current !== generation) return;
      setError(t("locationDiscovery.saveError"));
    } finally {
      if (saveGeneration.current === generation) setSaving(false);
    }
  };

  const applySelected = () => {
    if (!selected) return;
    const discoveredAt = new Date().toISOString();
    return applyDefaults({
      location: {
        latitude: selected.latitude,
        longitude: selected.longitude,
        label: selected.label,
        ...(selected.countryCode ? { countryCode: selected.countryCode.toUpperCase() } : {}),
        source: "place-search",
        confidence: selected.confidence,
        discoveredAt,
        userOverridden: false,
      },
      timezone: selected.timezone,
      source: "place-search",
      confidence: selected.confidence,
      discoveredAt,
    });
  };

  const useDeviceLocation = () => {
    const generation = ++locationGeneration.current;
    setError(null);
    setSaved(false);
    setSelected(null);
    setDeviceSuggestion(null);
    if (!navigator.geolocation) {
      setError(t("locationDiscovery.geolocationUnsupported"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      if (locationGeneration.current !== generation) return;
      try {
        let timezone = browserTimezone();
        try {
          timezone = (await api.coordinateDefaults(coords.latitude, coords.longitude)).timezone;
        } catch {
          // The device timezone is a safe, reversible suggestion when the
          // coordinate lookup is offline. It is never silently persisted.
        }
        if (locationGeneration.current !== generation) return;
        const discoveredAt = new Date().toISOString();
        setDeviceSuggestion({
          location: {
            latitude: Number(coords.latitude.toFixed(6)),
            longitude: Number(coords.longitude.toFixed(6)),
            label: t("locationDiscovery.deviceLabel"),
            source: "browser-geolocation",
            confidence: "medium",
            discoveredAt,
            userOverridden: false,
          },
          timezone,
          source: "browser-geolocation",
          confidence: "medium",
          discoveredAt,
        });
      } catch {
        if (locationGeneration.current !== generation) return;
        setError(t("locationDiscovery.searchError"));
      } finally {
        if (locationGeneration.current === generation) setLocating(false);
      }
    }, () => {
      if (locationGeneration.current !== generation) return;
      setLocating(false);
      setError(t("locationDiscovery.permissionError"));
    }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 });
  };

  return (
    <div className="location-discovery">
      {currentLocation && (
        <div className="location-discovery-current">
          <span aria-hidden="true"><MapPin size={17} /></span>
          <div><strong>{currentLocation.label || t("locationDiscovery.savedLocation")}</strong><small>{currentTimezone}</small></div>
          <span className="readiness-pill ready"><Check size={13} aria-hidden="true" />{t("locationDiscovery.ready")}</span>
          <button type="button" className="secondary-button" aria-expanded={changing} onClick={() => { searchGeneration.current += 1; locationGeneration.current += 1; saveGeneration.current += 1; searchController.current?.abort(); setSearching(false); setLocating(false); setSaving(false); setChanging((value) => !value); setQuery(""); setResults([]); setSelected(null); setDeviceSuggestion(null); setAnnouncedResultCount(null); setError(null); setSaved(false); }}>{changing ? t("common.cancel") : t("locationDiscovery.change")}</button>
        </div>
      )}

      {(!currentLocation || changing) && <><div className="location-discovery-actions">
        <form className="location-search-form" aria-busy={searching} onSubmit={(event) => void searchPlaces(event)}>
          <label className="field">
            <span>{t("locationDiscovery.searchLabel")}</span>
            <span className="input-with-icon"><Search size={16} aria-hidden="true" /><input value={query} minLength={2} maxLength={120} placeholder={t("locationDiscovery.searchPlaceholder")} onChange={(event) => { searchGeneration.current += 1; searchController.current?.abort(); setSearching(false); setQuery(event.target.value); setSelected(null); setDeviceSuggestion(null); setAnnouncedResultCount(null); setSaved(false); }} /></span>
          </label>
          <button type="submit" className="secondary-button" disabled={searching || query.trim().length < 2}>{searching ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}{searching ? t("locationDiscovery.searching") : t("locationDiscovery.search")}</button>
        </form>
        <span className="location-choice-divider">{t("locationDiscovery.or")}</span>
          <button type="button" className="secondary-button location-device-button" disabled={locating} onClick={useDeviceLocation}>{locating ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Crosshair size={16} aria-hidden="true" />}{locating ? t("locationDiscovery.locating") : t("locationDiscovery.useDevice")}</button>
      </div>

      {announcedResultCount !== null && announcedResultCount > 0 && (
        <p className="sr-only" role="status" aria-live="polite">{t("locationDiscovery.resultCount", { count: announcedResultCount })}</p>
      )}

      {results.length > 0 && (
        <div className="location-results" role="group" aria-label={t("locationDiscovery.results")}>
          {results.map((result) => (
            <button key={result.id} type="button" aria-pressed={selected?.id === result.id} className={selected?.id === result.id ? "selected" : ""} onClick={() => { setSelected(result); setDeviceSuggestion(null); setSaved(false); }}>
              <MapPin size={16} aria-hidden="true" />
              <span><strong>{result.label}</strong><small>{result.timezone}</small></span>
              {selected?.id === result.id && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="location-suggestion-review">
          <div><span className="eyebrow">{t("locationDiscovery.suggestion")}</span><strong>{selected.label} · {selected.timezone} · {t("locationDiscovery.weatherAutomatic")}</strong></div>
          <button type="button" className="primary-button" disabled={saving} onClick={() => void applySelected()}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{t("locationDiscovery.useSuggestion")}</button>
        </div>
      )}

      {deviceSuggestion && (
        <div className="location-suggestion-review">
          <div><span className="eyebrow">{t("locationDiscovery.suggestion")}</span><strong>{deviceSuggestion.location.label} · {deviceSuggestion.timezone} · {t("locationDiscovery.weatherAutomatic")}</strong></div>
          <button type="button" className="primary-button" disabled={saving} onClick={() => void applyDefaults(deviceSuggestion)}>{saving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{t("locationDiscovery.useSuggestion")}</button>
        </div>
      )}

      <p className="location-privacy-note"><ShieldCheck size={15} aria-hidden="true" />{t("locationDiscovery.privacy")}</p>
      {error && <p className="test-result failure" role="alert"><TriangleAlert size={16} aria-hidden="true" />{error}</p>}
      {saved && <p className="test-result success" role="status"><Check size={16} aria-hidden="true" />{t("locationDiscovery.saved")}</p>}
      </>}
    </div>
  );
}
