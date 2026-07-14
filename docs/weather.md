# FMI weather and house location

Climate Twin can attach outdoor context to each house by storing a WGS84
latitude/longitude and retrieving public data from the Finnish Meteorological
Institute (FMI). FMI requests are made by the API process; the browser never
receives an FMI credential because the selected open-data endpoints do not
require an API key.

This is contextual weather data, not a certified alarm or building-control
input. Preserve timestamps, provenance, missing-value state, and official
warning text whenever the data is displayed or exported.

## Set a house location

Open **Integrations**, select a house, then click the map or drag its marker.
Latitude and longitude can also be entered directly. An optional label such as
`Espoo` is for display only; Climate Twin does not need or derive a street
address. Save the location before loading weather.

The public `House.location` shape is:

```json
{
  "latitude": 60.2055,
  "longitude": 24.6559,
  "label": "Espoo"
}
```

Coordinates are decimal degrees in WGS84 (`EPSG:4326`): latitude must be
between -90 and 90 and longitude between -180 and 180. This location is
separate from floor-local sensor `x`, `y`, and `z` coordinates. It is stored in
the local SQLite database and is returned by house endpoints.

The browser-geolocation API is deliberately not used. The production web
server keeps `Permissions-Policy: geolocation=()`, so choosing a point on the
map does not grant Climate Twin access to the computer or phone's current
position.

The equivalent API operations are:

```http
PATCH /api/v1/houses/house-main
Content-Type: application/json

{
  "location": {
    "latitude": 60.2055,
    "longitude": 24.6559,
    "label": "Espoo"
  }
}
```

Set `location` to `null` to remove it. Updating or removing a location clears
that house's in-memory weather cache. `POST /api/v1/houses` also accepts the
same optional location object.

## Retrieve house weather

```http
GET /api/v1/houses/house-main/weather?hours=48
```

`hours` defaults to 48 and accepts 1–240. A house without a saved location
returns `409 HOUSE_LOCATION_REQUIRED`. A total upstream failure without a
usable cache returns `503 WEATHER_UNAVAILABLE`.

The response envelope is `{ "weather": ... }`. Important provenance and
quality fields are:

| Field | Meaning |
| --- | --- |
| `provider` / `attribution` | `fmi` and the attribution that must remain visible downstream |
| `location` | exact stored WGS84 point used for this request |
| `fetchedAt` | time this upstream retrieval began |
| `forecastIssuedAt` | FMI result time for the edited forecast, when available |
| `observationStation` | ID, name, coordinates, and straight-line distance of the selected station |
| `stale` | `true` when a failed refresh fell back to an older in-memory result |
| `unavailable` | independently unavailable `observation`, `forecast`, `short-range`, or `warnings` component |

`current` is a station observation or `null`; `forecast` is an ordered array of
hourly point values; and `warnings` contains official CAP warnings whose
polygon or circle includes the house point. An empty array alone does not say
whether a component succeeded: always inspect `unavailable`. Missing upstream
parameters are omitted rather than filled with zero or an estimate.

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

An observation is not measured at the house. Climate Twin searches for recent
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

- A result is fresh in process memory for 10 minutes per house, coordinates,
  and requested horizon. Recent horizons coexist in a bounded 128-entry LRU,
  and concurrent identical requests share one FMI fetch.
- The parsed CAP warning feed is shared for 10 minutes across houses.
- Forecast, short-range supplement, observation, and warning retrievals settle
  independently. A usable response can therefore be partial and lists failed
  parts in `unavailable`.
- If refresh fails after a previous result exists for the same key, Climate
  Twin can return it with `stale: true` for at most 60 minutes after retrieval.
  Forecast points and warnings that have expired are removed before any cached
  response is returned. There is no durable weather cache: restarting the API
  or changing the location removes that fallback.
- If no primary forecast, observation, or warning result is usable and no
  matching cached result exists, the endpoint returns 503. Callers should use
  bounded retries with jitter, not a rapid polling loop.

Weather context is not inserted into sensor measurement history. A future
analysis that correlates indoor and outdoor data should persist explicit source
timestamps and product metadata rather than silently treating the latest API
response as a historical outdoor sensor.

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
and WMS together limited to 600 requests per five minutes. Climate Twin does
not use WMS for this feature. The 10-minute application cache reduces calls,
but operators still need to account for the number of houses, horizon changes,
restarts, replicas, and other software sharing the same allowance. The license
page does not state that those WFS/WMS figures govern the separate CAP feed;
cache and poll that feed considerately nonetheless.

Authoritative references checked on 2026-07-14:

- [FMI open data and machine-readable endpoints](https://www.ilmatieteenlaitos.fi/avoin-data)
- [FMI open data sets](https://www.ilmatieteenlaitos.fi/avoin-data-avattavat-aineistot)
- [FMI WFS open-data manual](https://en.ilmatieteenlaitos.fi/open-data-manual)
- [FMI licence and request limits](https://www.ilmatieteenlaitos.fi/avoin-data-lisenssi)
- [FMI CAP warning-feed guide](https://www.ilmatieteenlaitos.fi/varoitusten-latauspalvelun-pikaohje)

## Map privacy and attribution

The location picker renders standard tiles directly in the user's browser from
`https://tile.openstreetmap.org`; it does not proxy or store the tiles. Those
requests disclose the browser's IP address, the Climate Twin web origin in the
required HTTP `Referer`, and the requested tile coordinates (which imply the
viewed map area and zoom) to OpenStreetMap infrastructure. Users who must not
make that external request should not open the map-enabled Integrations page;
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
OSM, not a Climate Twin route, query string, or saved coordinates.

Only the exact HTTPS tile origin is permitted by the production content
security policy. FMI data remains server-to-server and therefore does not need
to be added to browser `connect-src`.

## Coverage and safety limits

The current response is broad but not every external influence on a building.
It does not yet include radar images, lightning strikes, UV index, pollen, air
quality, road weather, soil temperature/frost depth, flood/wildfire products,
marine conditions, terrain/shading, or hyperlocal sensors at the property.
FMI CAP warnings improve official hazard context but do not replace smoke, CO,
flood, freeze, wind, or other certified local detectors and notifications.
