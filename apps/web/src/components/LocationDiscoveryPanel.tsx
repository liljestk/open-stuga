import { Check, Crosshair, LoaderCircle, MapPin, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
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
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const searchPlaces = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setAnnouncedResultCount(null);
    setError(null);
    setSaved(false);
    try {
      const next = await api.searchLocations(query, locale);
      setResults(next);
      setAnnouncedResultCount(next.length);
      setSelected(next.length === 1 ? next[0]! : null);
      if (next.length === 0) setError(t("locationDiscovery.noResults"));
    } catch {
      setResults([]);
      setAnnouncedResultCount(null);
      setSelected(null);
      setError(t("locationDiscovery.searchError"));
    } finally {
      setSearching(false);
    }
  };

  const applySelected = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const discoveredAt = new Date().toISOString();
      await onApply({
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
      setSaved(true);
    } catch {
      setError(t("locationDiscovery.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const useDeviceLocation = () => {
    setError(null);
    setSaved(false);
    if (!navigator.geolocation) {
      setError(t("locationDiscovery.geolocationUnsupported"));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        let timezone = browserTimezone();
        try {
          timezone = (await api.coordinateDefaults(coords.latitude, coords.longitude)).timezone;
        } catch {
          // The device timezone is a safe, reversible suggestion when the
          // coordinate lookup is offline. It is never silently persisted.
        }
        const discoveredAt = new Date().toISOString();
        await onApply({
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
        setSaved(true);
      } catch {
        setError(t("locationDiscovery.saveError"));
      } finally {
        setLocating(false);
      }
    }, () => {
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
        </div>
      )}

      <div className="location-discovery-actions">
        <form className="location-search-form" aria-busy={searching} onSubmit={(event) => void searchPlaces(event)}>
          <label className="field">
            <span>{t("locationDiscovery.searchLabel")}</span>
            <span className="input-with-icon"><Search size={16} aria-hidden="true" /><input value={query} minLength={2} maxLength={120} placeholder={t("locationDiscovery.searchPlaceholder")} onChange={(event) => { setQuery(event.target.value); setSelected(null); setAnnouncedResultCount(null); setSaved(false); }} /></span>
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
            <button key={result.id} type="button" aria-pressed={selected?.id === result.id} className={selected?.id === result.id ? "selected" : ""} onClick={() => { setSelected(result); setSaved(false); }}>
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

      <p className="location-privacy-note"><ShieldCheck size={15} aria-hidden="true" />{t("locationDiscovery.privacy")}</p>
      {error && <p className="test-result failure" role="alert"><TriangleAlert size={16} aria-hidden="true" />{error}</p>}
      {saved && <p className="test-result success" role="status"><Check size={16} aria-hidden="true" />{t("locationDiscovery.saved")}</p>}
    </div>
  );
}
