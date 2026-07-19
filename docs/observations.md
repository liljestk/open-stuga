# Manual observations, evidence time, and resolution

Manual observations record contextual evidence such as a leak, condensation,
ventilation change, maintenance visit, or free-form note. They are not sensor
measurements and should not be treated as a substitute for an inspection.

## Time model

Every newly stored observation has two distinct clocks:

- `occurredAt` is the observed time. Its representation depends on
  `timePrecision`.
- `createdAt` is the immutable server-recorded time. Clients cannot supply or
  edit it.
- `updatedAt` is the server time of the latest effective revision.

`timePrecision` controls which time fields are accepted:

| Precision | Required input | Stored representation |
| --- | --- | --- |
| `exact` | Optional `occurredAt`; server time is the default | Canonical UTC RFC 3339 instant |
| `approximate` | `occurredAt` | Canonical UTC RFC 3339 instant, explicitly labelled approximate |
| `date-only` | `occurredAt` | Calendar date as `YYYY-MM-DD` |
| `date-range` | `validFrom` and `validTo` | Inclusive `YYYY-MM-DD` dates; `occurredAt` mirrors `validFrom` for v1 compatibility |
| `unknown` | No time fields | Empty `occurredAt` for v1 string compatibility |

Date ranges are appropriate for continuing or retrospectively bounded
conditions. The start must not be after the end. Clients must use
`timePrecision`, rather than guessing precision from the shape of
`occurredAt`.

Older records are migrated without inventing provenance: their existing
timestamp remains `exact`, while `source` becomes `unknown` and `confidence`
becomes `uncertain`.

## Provenance and confidence

`source` is one of `owner`, `caretaker`, `contractor`, `sensor`,
`imported-document`, `automated-analysis`, or `unknown`. `sourceDetail` can
identify the person, document, device, or analysis more precisely without
changing the controlled source category.

`confidence` is `confirmed`, `probable`, `uncertain`, or
`awaiting-inspection`. An automated or imported observation should retain its
actual source and should not silently become confirmed.

The current model links observations to a house, floor, and optionally a
sensor and plan position. Maintenance tasks can link observations through
explicit same-house IDs; completing that work never silently resolves the
source evidence. Asset, issue, photo, and document links remain future domain
extensions, so do not encode those relationships into `note` and then depend
on parsing the text. See [Activity and maintenance work](maintenance.md).

Floor edits cannot remove an observation's floor or shrink its bounds past a
placed observation. An observation without plan coordinates does not prevent
an otherwise valid floor resize. A sensor reference is retained as historical
provenance if that device is later moved or deleted; note and lifecycle edits
remain available, while explicitly selecting a new sensor or floor revalidates
the relationship against the current layout.

## Resolution lifecycle

Every current server returns `status: "open"` or `status: "resolved"`; legacy
objects that do not yet contain the additive field are treated as open. A new
observation always starts open. Resolve it through the same optimistic PATCH
surface with the revision last read by the client and a meaningful outcome:

```json
{
  "baseRevision": 2,
  "status": "resolved",
  "resolutionNote": "Fixed leak and replaced the failed sink seal."
}
```

The resolution note is required, limited to 5,000 characters across the local
REST and MCP surfaces and web UI, and whitespace-only outcomes
are rejected.
The server records `resolvedAt`; clients cannot choose that timestamp. Editing
the outcome of an already resolved observation preserves the original
`resolvedAt`. Reopen an observation with:

```json
{
  "baseRevision": 3,
  "status": "open"
}
```

Reopening clears the current `resolutionNote` and `resolvedAt`, but the prior
resolved snapshot, time, and actor remain in the append-only revision ledger.
Resolution means the reported condition was addressed; it does not prove that
the repair was effective or replace follow-up inspection and sensor evidence.

## Creation and revision

Create an observation with `POST /api/v1/observations`:

```json
{
  "houseId": "house-1",
  "floorId": "cellar",
  "kind": "leak",
  "severity": "warning",
  "note": "Floor stayed damp during the first week of January.",
  "timePrecision": "date-range",
  "validFrom": "2026-01-01",
  "validTo": "2026-01-07",
  "source": "caretaker",
  "sourceDetail": "Arrival inspection",
  "confidence": "probable"
}
```

The response has `revision: 1`. Creation also writes revision 1 to the
append-only revision ledger. Change a mutable field with
`PATCH /api/v1/observations/{id}` and the revision last read by the client:

```json
{
  "baseRevision": 1,
  "confidence": "confirmed",
  "note": "Standing water confirmed during inspection."
}
```

An effective change increments `revision`; a no-op patch leaves it unchanged.
A stale `baseRevision` returns HTTP 409 with
`OBSERVATION_REVISION_CONFLICT`, so a client must reload before deciding
whether to retry. The Home activity timeline exposes that reload action when
it detects a conflict. Retrieve the ordered snapshots with
`GET /api/v1/observations/{id}/revisions`.

The Home activity timeline keeps observed, recorded, and resolved time
separate; it can resolve or reopen an observation and load the same revision
ledger, including changed fields and actor attribution.
Calendar-only and ranged observations remain calendar evidence; they are not
coerced into misleading instant markers on the comparison chart.

REST and MCP changes retain their local channel attribution; authenticated REST
requests are authorized against the signed-in account before a write reaches
the observation service. Pre-0.3 baselines are conservatively attributed as
`local-migration` rather than inventing their original authoring channel.

The local MCP exposes `create_observation`, `update_observation`, and
`list_observation_revisions` with the same validation and optimistic
concurrency rules. Deletion is still permanent in this release and cascades to
the revision history; export evidence before deleting it.
