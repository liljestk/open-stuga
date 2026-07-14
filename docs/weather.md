# Outdoor weather and home location

Stuga can attach outdoor context to every home by storing a WGS84
latitude/longitude and IANA timezone. The API selects the weather provider from
that location: Finnish locations use Finnish Meteorological Institute (FMI)
open data, including official warnings, while other locations use Open-Meteo's
worldwide modelled current conditions and hourly forecast. Weather requests are
made by the API process and neither provider requires an API key.

This is contextual weather data, not a certified alarm or building-control
input. Preserve timestamps, provenance, missing-value state, and official
warning text whenever the data is displayed or exported.

## Set weather location, map placement, and orientation

Open **Set up > Weather** and select the home to configure. Search by place name
and review the suggested location and timezone, or explicitly choose **Use this
device's location** and approve the browser permission prompt. Stuga does
not request the device position until that action. Place search and coordinate
timezone lookup are performed server-side through Open-Meteo. They are suggested
defaults: the user decides whether to apply a search result, and the manual
latitude, longitude, label, and timezone fields remain available under
**Advanced**.

Use **Set up > Homes** for the independent precise map placement and plan
orientation. Map tiles are not loaded until the user explicitly opens the map.
A calibrated home is drawn as a geographically scaled floor-plan footprint that
grows and shrinks with map zoom; a home with only a weather location is shown as
a pin. A home with neither value is absent from the shared map until one is set.
Each saved home keeps its own location and timezone, so a single installation
can monitor homes in different parts of the world. Home Assistant and direct
TP-Link credentials are still process-wide integration settings, not per-home
connections.

`House.location` is the weather lookup reference. Its latitude and longitude
can be entered directly. An optional label such as `Espoo` is for display only;
Stuga does not need or derive a street address. Save this location before
loading weather.

The public `House.location` shape can include discovery provenance:

```json
{
  "latitude": 60.2055,
  "longitude": 24.6559,
  "label": "Espoo",
  "countryCode": "FI",
  "source": "place-search",
  "confidence": "high",
  "discoveredAt": "2026-07-14T08:00:00.000Z",
  "userOverridden": false
}
```

`House.mapPlacement` is the independent, precise map placement:

```json
{
  "latitude": 60.2056,
  "longitude": 24.6561,
  "metersPerPlanUnit": 0.05,
  "footprintFloorId": "floor-ground"
}
```

Its WGS84 point is the centre of the floor plan. `metersPerPlanUnit` calibrates
local plan `x`/`y` units to real-world metres and must be positive. The optional
`footprintFloorId` selects which floor supplies the displayed footprint. Once
calibrated, the footprint is rendered at true geographic scale relative to the
map instead of at a fixed screen size.

`House.orientationDegrees` remains independent and optional. It is the
true-north bearing, measured clockwise, of the **top edge of the floor plan**:
`0` means the plan top faces north, `90` east, `180` south, and `270` west.
Leave it unknown until it has been measured; Stuga does not silently
assume north. It rotates the calibrated map footprint and provides the same
plan-top reference for directional weather.

Coordinates in both objects are decimal degrees in WGS84 (`EPSG:4326`):
latitude must be between -90 and 90 and longitude between -180 and 180. Both
objects are separate from floor-local sensor `x`, `y`, and `z` coordinates.
They are stored in the local SQLite database and returned by house endpoints.
Stuga does not yet model property/site membership or surveyed parcel
boundaries, so homes combined in this shared view may belong to different
properties.

Browser geolocation and the map are separate explicit actions. Approving device
location supplies coordinates to the Stuga API and to the server-side
timezone/weather lookup; it does not open the map. Opening the map sends tile
requests but does not grant browser-geolocation access. A place search sends the
entered search text to the API and then Open-Meteo's geocoding service.

The equivalent API operations are:

```http
PATCH /api/v1/houses/house-main
Content-Type: application/json

{
  "location": {
    "latitude": 60.2055,
    "longitude": 24.6559,
    "label": "Espoo"
  },
  "timezone": "Europe/Helsinki",
  "mapPlacement": {
    "latitude": 60.2056,
    "longitude": 24.6561,
    "metersPerPlanUnit": 0.05,
    "footprintFloorId": "floor-ground"
  },
  "orientationDegrees": 0
}
```

Set `location` to `null` to remove it. Updating or removing a location clears
that house's in-memory weather cache. A coordinate change also deletes that
house's previously retained outdoor-boundary rows; location keys in the
boundary table are opaque digests rather than plaintext coordinates.
Moving or clearing `mapPlacement` does not change `location`, clear the weather
cache, or purge retained weather history. `POST /api/v1/houses` also accepts the
same optional location, placement, and orientation. Set `mapPlacement` or
`orientationDegrees` to `null` to clear only that property. All three properties
can be patched separately; clearing one does not erase the others.

## Outdoor page and Twin context

The home-scoped **Outdoor** page presents current context separately from Setup.
It requests a 48-hour forecast and divides it into four keyboard-operable
12-hour windows: **Next 12 hours**, **+12–24 hours**, **+24–36 hours**, and
**+36–48 hours**. The table and mobile cards use the selected home's timezone,
including its UTC offset, and retain provider attribution, timestamps, partial
availability, and stale state. Changing home resets the window safely; a manual
refresh remains available.

The live Twin view can also load the home's current outdoor values and shows
outside temperature, relative humidity, wind speed, gust, source direction,
source time, provenance, and stale state when those fields are available. FMI
current conditions are recent station observations; Open-Meteo current
conditions are modelled and are labelled as such. Missing values remain visibly
unavailable rather than being replaced with zero.

Wind direction is the direction the wind comes **from**. With a known house
orientation, Stuga converts it into plan coordinates as
`windFrom - orientationDegrees` (normalized to 0–359 degrees). The resulting
arrow starts at the windward plan edge and points inward in the 2D and 3D
views. If orientation or wind direction is unknown, the numeric outside values
remain available but the plan-relative arrow is withheld. Current live weather
is not overlaid on historical replay.

This overlay is a structured external boundary condition only. It is not added
as a synthetic indoor sensor, interpolation anchor, or measurement-history
row. The current wall model does not identify an exterior envelope, openings,
materials, outward normals, or room adjacency, so the UI reports a windward
**plan edge** rather than claiming that a specific wall segment is affected.
Quantifying how wind changes indoor temperature or humidity needs a separately
calibrated building-physics model and supporting building data.

## Retrieve house weather

```http
GET /api/v1/houses/house-main/weather?hours=48
```

`hours` defaults to 48 and accepts 1–240. Open-Meteo currently returns at most
168 forecast hours. A house without a saved location
returns `409 HOUSE_LOCATION_REQUIRED`. A total upstream failure without a
usable cache returns `503 WEATHER_UNAVAILABLE`.

The response envelope is `{ "weather": ... }`. Important provenance and
quality fields are:

| Field | Meaning |
| --- | --- |
| `provider` / `attribution` | `fmi` or `open-meteo` and the attribution that must remain visible downstream |
| `location` | exact stored WGS84 point used for this request |
| `fetchedAt` | time this upstream retrieval began |
| `forecastIssuedAt` | provider issue time when exposed; `null` for Open-Meteo |
| `observationStation` | FMI station ID, name, coordinates, and straight-line distance; `null` for modelled current conditions |
| `stale` | `true` when a failed refresh fell back to an older in-memory result |
| `unavailable` | independently unavailable `observation`, `forecast`, `short-range`, or `warnings` component |
| `componentStatus` | per-component provider, product, attribution, availability, coverage, freshness, and whether an empty result is authoritative |

`current` is a station observation, modelled current conditions, or `null`;
`forecast` is an ordered array of hourly point values. For FMI, `warnings`
contains official CAP warnings whose polygon or circle includes the home point.
Open-Meteo does not supply official warnings through this adapter. An empty
warning array means "no active warnings" only when
`componentStatus.warnings.availability` is `available`, coverage is `covered`,
`emptyResultIsAuthoritative` is `true`, and the component is not stale. In every
other state the UI must say warning status is unavailable or unverified, not
that there are no warnings. Missing upstream parameters are omitted rather than
filled with zero or an estimate.

## Automatic provider selection

The default policy is automatic. A location with `countryCode: "FI"` uses FMI;
a legacy location without a country code uses a conservative Finland outline.
Other locations use Open-Meteo. The chosen provider is recorded in every
response and can vary between homes in the same installation.

Open-Meteo requests its `best_match` modelled current conditions and hourly
forecast in GMT, then Stuga displays those UTC timestamps in the home's
IANA timezone. The adapter maps temperature, relative humidity, dew point,
pressure, wind, precipitation, precipitation probability, cloud layers,
visibility, WMO weather code, snow depth, and shortwave radiation when provided.
It deliberately reports warnings as not applicable/outside coverage rather than
fabricating an empty authoritative result.

## FMI products and fields

The adapter uses FMI's public WFS 2.0 download service at
`https://opendata.fmi.fi/wfs` and the English CAP Atom warning feed. It currently
requests these products:

| Purpose | FMI stored query/feed | Requested values |
| --- | --- | --- |
| Edited point forecast | `fmi::forecast::edited::weather::scandinavia::point::timevaluepair` | pressure, temperature, dew point, relative humidity, wind direction/speed, one-hour precipitation, precipitation form and potential form, total/low/medium/high cloud, precipitation and thunder probabilities, global radiation, fog intensity, `WeatherSymbol3`, frost/severe-frost probabilities, hourly maximum wind and gust |
| Short-range supplement | `fmi::forecast::harmonie::surface::point::timevaluepair` | global radiation, visibility, and wind gust, for at most the first 66 hours |
| Recent observations | `fmi::observations::weather::timevaluepair` | air temperature, relative humidity, dew point, 10-minute wind/gust/direction, one-hour precipitation, 10-minute precipitation intensity, snow depth, sea-level pressure, visibility, cloud amount, and present weather |
| Official warnings | `https://alerts.fmi.fi/cap/feed/atom_en-GB.xml` | actual CAP 1.2 alerts/updates, including event, headline, description, severity, urgency, certainty, validity, areas, web link, and polygon/circle geometry |

These map to canonical response properties with explicit units: degrees Celsius,
percent, hectopascals, metres per second, millimetres, millimetres per hour,
centimetres, metres, and watts per square metre. FMI/WMO categorical values such
as precipitation form, present weather, fog intensity, and weather-symbol codes
remain numeric source codes. Consumers must use FMI's parameter metadata when
turning those codes into labels.

The edited forecast is the primary series. HARMONIE values supplement fields
that are absent from the edited series at the same timestamp; they do not
replace populated edited-forecast values. FMI notes that model configuration,
resolution, coverage, parameters, and usable horizon can change, so deployments
should monitor the [open-data changelog](https://en.ilmatieteenlaitos.fi/open-data-changelog)
and test stored queries when upgrading.

### Observation-station caveat

An observation is not measured at the house. Stuga searches for recent
stations within roughly 40 km and expands to 120 km if necessary, then selects
the nearest station with a temperature observation no more than 90 minutes
old. Other fields are taken only within 30 minutes of that temperature, and
the response timestamp is the temperature's source time.
`observationStation.distanceKm` makes that choice visible. Elevation, coast,
terrain, vegetation, buildings,
urban heat, precipitation cells, and station maintenance can all make the
house's actual conditions differ materially. Different stations also measure
different parameters, and a field can be absent even when the observation
component succeeded.

## Cache and failure behaviour

- A full weather response is fresh in process memory for 10 minutes per house, coordinates,
  and requested horizon. Recent horizons coexist in a bounded 128-entry LRU,
  and concurrent identical requests share one provider fetch.
- The parsed CAP warning feed is shared for 10 minutes across houses.
- Forecast, short-range supplement, observation, and warning retrievals settle
  independently. A usable response can therefore be partial and lists failed
  parts in `unavailable`.
- If refresh fails after a previous result exists for the same key, Climate
  Twin can return it with `stale: true` for at most 60 minutes after retrieval.
  Forecast points and warnings that have expired are removed before any cached
  response is returned. There is no durable full-response cache: restarting the
  API or changing `House.location` removes that fallback. A fresh current
  temperature is separately retained as a location-keyed physics boundary;
  stale fallbacks and forecasts are never inserted as observations.
- If no primary forecast, observation, or warning result is usable and no
  matching cached result exists, the endpoint returns 503. Callers should use
  bounded retries with jitter, not a rapid polling loop.

When normal background services are enabled, a weather monitor refreshes every
located home with a 48-hour request. It starts after up to 60 seconds of jitter,
then waits at least 15 minutes plus up to 60 seconds of jitter between cycles.
At most two homes are refreshed concurrently and cycles never overlap. A failed
or stale refresh gets per-home exponential backoff from 5 minutes up to 6 hours;
changing that home's location clears the obsolete backoff. Before persistence,
the monitor rechecks the home update timestamp and opaque location key so a
late response for a moved home cannot be stored under its new location.

Weather context is not inserted into sensor measurement history. Stuga
persists only fresh current temperature, with its source timestamp, requested
location represented by an opaque digest, fetch time, and station provenance,
in a separate outdoor-boundary table. The thermal model uses only timestamp
overlap and never treats the latest
API response as historical weather. These boundary rows follow
`RETENTION_DAYS`, and changing or clearing the `House.location` coordinates
erases rows from the old weather location.

## License, attribution, and service limits

FMI publishes these data through machine-readable services without an API key.
FMI open data is licensed under
[Creative Commons Attribution 4.0](https://www.ilmatieteenlaitos.fi/avoin-data-lisenssi),
which requires the licensor and data-set name to be credited. Keep the response
attribution visible and, in a redistributed display or export, identify the
used sets, for example:

> Finnish Meteorological Institute open data — edited weather forecast,
> HARMONIE forecast, weather observations, and weather warnings (CC BY 4.0).

FMI's published user-specific limits are currently 20,000 requests per day for
the WFS download service and 10,000 per day for the WMS view service, with WFS
and WMS together limited to 600 requests per five minutes. Stuga does
not use WMS for this feature. The 10-minute application cache reduces calls,
but operators still need to account for the number of houses, horizon changes,
restarts, replicas, and other software sharing the same allowance. The license
page does not state that those WFS/WMS figures govern the separate CAP feed;
cache and poll that feed considerately nonetheless.

Open-Meteo's response attribution is **Weather data by Open-Meteo.com (CC BY
4.0)** and the Outdoor page links that credit to Open-Meteo. Keep it visible in
redistributed displays and exports. Review the current
[Open-Meteo licence](https://open-meteo.com/en/license),
[API documentation](https://open-meteo.com/en/docs), and
[terms and service limits](https://open-meteo.com/en/terms) for the deployment's
use class and traffic volume. The application cache, bounded background
concurrency, jitter, and per-home backoff reduce avoidable traffic but do not
replace provider-side capacity planning.

Authoritative references checked on 2026-07-14:

- [FMI open data and machine-readable endpoints](https://www.ilmatieteenlaitos.fi/avoin-data)
- [FMI open data sets](https://www.ilmatieteenlaitos.fi/avoin-data-avattavat-aineistot)
- [FMI WFS open-data manual](https://en.ilmatieteenlaitos.fi/open-data-manual)
- [FMI licence and request limits](https://www.ilmatieteenlaitos.fi/avoin-data-lisenssi)
- [FMI CAP warning-feed guide](https://www.ilmatieteenlaitos.fi/varoitusten-latauspalvelun-pikaohje)
- [Open-Meteo weather API](https://open-meteo.com/en/docs)
- [Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api)
- [Open-Meteo licence](https://open-meteo.com/en/license)

## Location-discovery privacy

Stuga does not silently infer or persist a home location. A place search
sends the entered text and UI language from the browser to the local API, which
forwards them to Open-Meteo's geocoding service; only a result the user selects
and applies is saved. **Use this device's location** invokes the browser
geolocation permission prompt only after the click. If approved, the browser
sends the resulting coordinates to the local API and the API uses Open-Meteo to
resolve a timezone; if that lookup fails, the browser timezone is offered as a
reversible fallback. Manual coordinates remain available under **Advanced**.

The saved coordinate, timezone, discovery source, confidence, and discovery
time are household metadata. Browser permission is not ongoing background
tracking: Stuga stores the selected home point, not a device movement
history. Revoke the browser permission separately if it is no longer wanted.

## Map privacy and attribution

The shared home map and location editor render standard tiles directly in the
user's browser from `https://tile.openstreetmap.org` only after the user chooses
to load the map; Stuga does not proxy or store the tiles. Those
requests disclose the browser's IP address, the Stuga web origin in the
required HTTP `Referer`, and the requested tile coordinates (which imply the
viewed map area and zoom) to OpenStreetMap infrastructure. Users who must not
make that external request should not load the map in **Set up > Homes**;
they can set coordinates through the API, or the deployment can replace the
layer with an approved self-hosted/private provider before loading the picker.

The map visibly credits `© OpenStreetMap contributors` and links to the OSM
copyright/licence page. Do not remove that attribution. Follow the current
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/),
[copyright guidance](https://www.openstreetmap.org/copyright), and
[OSM Foundation privacy policy](https://osmfoundation.org/wiki/Privacy_Policy).
Do not prefetch or bulk-download standard tiles; production/high-volume use
needs a suitable tile provider or self-hosted service. The production
`strict-origin-when-cross-origin` referrer policy sends only the web origin to
OSM, not a Stuga route, query string, or saved coordinates.

Only the exact HTTPS tile origin is permitted by the production content
security policy. FMI, Open-Meteo weather, Open-Meteo geocoding, and coordinate
timezone requests remain server-to-server and therefore do not need to be added
to browser `connect-src`.

## Coverage and safety limits

The current response is broad but not every external influence on a building.
It does not yet include radar images, lightning strikes, UV index, pollen, air
quality, road weather, soil temperature/frost depth, flood/wildfire products,
marine conditions, terrain/shading, or hyperlocal sensors at the property.
FMI CAP warnings improve official hazard context for covered Finnish homes. The
worldwide Open-Meteo path provides no official warning component. Neither path
replaces smoke, CO, flood, freeze, wind, or other certified local detectors and
notifications.
