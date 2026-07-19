# Properties, mapped areas, and Guest access

Stuga groups homes and outdoor assets under a **property**. A property can
contain any number of homes plus user-drawn areas such as wells, beaches,
garages, plantations, gardens, fields, forests, shorelines, docks, roads, and
yards. Every home belongs to exactly one existing property and therefore
appears under only that property. Database constraints enforce this invariant;
a blank or unknown `propertyId` is never stored on a home.

Equipment belongs to one area, and its property is derived from that area's
property. Notes can target the property itself, a home, an area, or a piece of
equipment. Maintenance work is likewise property-owned and can optionally
target resources inside that property.

## Durable storage

Property management is server-owned and restart-safe. Properties, Homes,
complete floors/rooms/walls, map placement, areas and point assets, equipment,
notes, electricity contracts, observations, maintenance work and revisions,
sensors, parameters, access grants, and uploaded floor-plan assets are stored
in the core SQLite database. The browser holds only unsaved form drafts and
display preferences; a refresh reconstructs the Property from the API.

Creating a Property and its required default electricity configuration is one
transaction. Moves and other aggregate operations likewise commit completely
or roll back completely, with foreign keys preventing cross-Property orphan
records. A file-backed restart test closes SQLite, reopens it, checks the full
Property graph and operational records, and runs SQLite integrity and foreign
key checks.

## First setup and existing installations

Normal installations start with `MOCK_ENABLED=false` and use the guided
property-and-home setup. The first-home form selects an existing property or,
if none exists, creates one before it creates the home. It supplies useful
localized property/home names, the browser's IANA timezone (falling back to
UTC), and one ground floor as editable defaults. The selected or newly created
property is submitted explicitly with the home.

The REST API retains a narrow compatibility default: omitting `propertyId`
while creating a home selects the only property, or creates the default
property when none exists. Once more than one property exists, clients must
choose one and omission is rejected with `HOUSE_PROPERTY_REQUIRED`.

The sample home and sensors are opt-in: set `MOCK_ENABLED=true` before the first
start of a separate demo database. Do not enable it for a normal installation.

Existing installations are migrated into a valid default property where
needed. Existing home, floor-plan, sensor, observation, and maintenance
identifiers remain stable, and legacy orphaned or inconsistent property scope
is repaired before the ownership constraints are enabled.

## Moving resources between properties

Use the move controls in **Properties** to reorganize an installation. Each move
is one database transaction: either the complete aggregate moves or no part of
it does.

- Moving a home changes its property and carries its home-targeted notes and
  maintenance work with it. Sensors, floors, and the home's retained data stay
  attached to the same home. Area or equipment links on that maintenance work
  are cleared if those outdoor resources remain in another property.
- Moving an area carries the area's equipment plus its area/equipment-targeted
  notes and maintenance work. A home/floor scheduling link is cleared when the
  linked home does not belong to the destination property.
- Moving equipment means selecting its destination area. Its property is
  recalculated from that area, and its targeted notes and maintenance work move
  with it. An incompatible home/floor scheduling link is cleared.

When an area- or equipment-linked maintenance task also has observation
evidence from a home that would have to be detached, the API rejects the move
with `409 PROPERTY_MOVE_HAS_LINKED_EVIDENCE`. Move or unlink that task/evidence
first, then retry. The rejected transaction leaves every resource in its
original property. Successful scope changes also create maintenance revision
history for the fields changed by the move.

## Drawing areas

Open **Properties**, choose a property, and select **Add area**. Area boundaries
use WGS84 latitude/longitude vertices. Click the map to add vertices, or use the
coordinate editor as a keyboard-only/private-map fallback. A valid boundary has
at least three distinct points, stays inside latitude/longitude bounds, and
must not cross itself.

Map tiles are requested from OpenStreetMap only after the user explicitly
loads the map or chooses to draw an area. Loading tiles discloses the browser
IP address and viewed tile coordinates to that service. The manual coordinate
editor remains available as a precise keyboard-friendly fallback.

If a property has no mapped area or precisely located home, its saved
`Property.location` is used as the initial map centre. Area boundaries and home
locations take precedence once spatial content exists.

## Placing homes and fixed assets

The **Map** workspace keeps the items that can be positioned in one compact
**Map items** panel. A home, well, shed, garage, dock, or other fixed asset can
be selected and placed by clicking the map, dragged from the panel onto the
map, and fine-tuned by dragging its marker. Coordinates remain available under
the advanced home-placement controls, but are not required for normal map
placement.

Use **Add fixed asset** for a point feature such as a well or shed. Give it a
name and type, click the map to pin it, and save it. Fixed assets use a WGS84
`location` and an empty `polygon`; an existing area such as a well can also keep
its boundary and receive an optional reference pin. Removing a placement clears
only the pin, not the asset, its boundary, notes, equipment, or maintenance
history.

Equipment and notes can be added from the selected area. Maintenance work is
owned by the property and can target an area and optionally one of its equipment
records, even when the Property has no Home. A Home can be added as scheduling
or indoor context, but it must belong to the same Property. A Home with tasks
cannot be deleted until those tasks are reassigned or removed, preventing silent
loss of outdoor work.

## Browser scope and navigation

The browser keeps the selected Property in its canonical URL. Selecting a Home
also selects its parent Property, and the Home switcher lists only Homes inside
that Property. Workspace Overview includes every visible Property, including
land-only Properties. Back, Forward, refresh, and copied links preserve the
same Property and optional Home context.

The permanent rail separates Workspace destinations from the selected
Property and Home. Property contains its overview, map/assets, notes, and
access sections; canonical Maintenance and Electricity contract management are
Property-owned. Home contains indoor status, Sensors, and Set up. Legacy
`/sites/{houseId}/...` links remain accepted and are redirected to canonical
`/properties/{propertyId}/homes/{homeId}/...` routes.

The primary canonical destinations are:

```text
/properties/{propertyId}
/properties/{propertyId}/maintenance
/properties/{propertyId}/electricity
/properties/{propertyId}/homes/{homeId}
/properties/{propertyId}/homes/{homeId}/sensors
/properties/{propertyId}/homes/{homeId}/setup/{section}
```

The Set up sections are `overview`, `homes`, `connections`, and `weather`.

## Guest accounts

Every installation has one local workspace with built-in owner,
administrator, and Guest accounts. An owner or administrator can grant a Guest
any combination of:

- a Property, which includes all of its Homes, areas, and equipment;
- an individual Home, which includes its sensors and Home-derived data; or
- an individual area, which includes equipment and area-linked notes/work.

A child grant also reveals the minimal parent property shell needed to navigate
the hierarchy. It does not reveal sibling Homes or areas. Guessed or stale
identifiers are returned as not found.

Guests are read-only. The API rejects every Guest mutation before a domain
handler runs, and list/detail queries are scoped on the server. The web client
hides editing controls as a usability measure, but it is not the authorization
boundary. Account directories and access-grant administration remain
owner/admin-only. Observation and maintenance audit histories are also hidden
from Guests because a current grant cannot prove that every older snapshot was
inside the same scope.

Browser sign-in establishes a server-managed HttpOnly session. The browser
cannot read that session credential, and the API resolves the account role and
grants for every request. All accounts share the same local workspace; there is
no alternate workspace selector.

Account authentication does not encrypt traffic. Keep Stuga on loopback or a
trusted private network, and use TLS with a VPN or reverse proxy before sharing
it across another network.

## Local API resources

The local API exposes property resources under `/api/v1`:

- `properties`
- `property-areas`
- `area-equipment`
- `property-notes`

List endpoints accept the relevant `propertyId` or `areaId` filter. In
particular, `GET /api/v1/houses?propertyId=...` returns only homes in the chosen
property. Houses carry their parent `propertyId`; maintenance tasks may carry
`areaId` and `equipmentId`. A house is moved with `PATCH /api/v1/houses/{id}`,
an area with `PATCH /api/v1/property-areas/{id}`, and equipment with
`PATCH /api/v1/area-equipment/{id}` (selecting its destination `areaId`).
Property-management and maintenance collections use bounded `limit`/`offset`
pagination. Account administration lets an owner or administrator manage
Guests and replace a Guest's grant set atomically within the local workspace.
