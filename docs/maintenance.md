# Activity and maintenance work

Stuga keeps evidence and planned work separate:

- an **observation** records what someone noticed and when;
- a **maintenance task** records what should be done, when it is planned or
  due, why it was proposed, and how completion was verified.

The Home-scoped **Activity** view shows that Home's operational timeline
and observation lifecycle. The canonical **Maintenance** workspace belongs to
the selected Property and turns an observation into linked work without
changing or resolving the source evidence. Its filters cover the whole
Property, individual Homes, mapped land, structures, and equipment, including
Properties without a Home. Home retains a fast observation composer and a
concise link into the Property work plan. The canonical routes are
`/properties/{propertyId}/maintenance` and
`/properties/{propertyId}/homes/{homeId}/activity`.

## Maintenance task model

Every task belongs to one Property. It may identify a Home (`houseId`) and floor for
building work, or a mapped area and piece of equipment for outdoor/property work.
All optional targets must belong to the owning Property. Its classification is
explicit:

| `basis` | Meaning |
| --- | --- |
| `required` | A regulation, manufacturer requirement, or known defect requires the work. |
| `scheduled` | The work is part of an ordinary calendar schedule. |
| `condition-based` | Human or sensor evidence indicates that work is needed. |
| `predictive` | A trend or model suggests future work; this is not a formal deadline. |
| `optional-improvement` | The work is useful but not currently necessary. |

`basisDetail` records the regulation, schedule, evidence, model, or human
rationale. Predictive tasks cannot carry `dueBy`; they may use `plannedFor`
without presenting an estimate as an authoritative deadline.

`plannedFor` and `dueBy` are separate property-local `YYYY-MM-DD` calendar dates.
When both exist, `plannedFor` cannot be later than `dueBy`. Priorities are
`low`, `normal`, `high`, and `urgent`.

## Lifecycle and verification

Tasks move through:

```text
planned -> in-progress -> completed -> verified
                       \-> cancelled
```

`completed` means the work was performed but has not yet been independently
verified. Completing requires a meaningful `completionNote`; the server owns
`completedAt`. Verification is a separate action, requires a
`verificationNote`, and records server-owned `verifiedAt`.

Moving a task back to `planned` or `in-progress`, or cancelling it, clears the
current completion and verification state. Moving a verified task back to
`completed` keeps the work outcome and time but clears its verification.
Historical states remain available through task revisions.

## Observation links

`observationIds` is a duplicate-free list of observations from the selected
Home. Property-only tasks cannot link Home observations until a Home context
is assigned.
Planning work from an observation creates this explicit link. It does **not**:

- resolve the observation;
- complete the task;
- treat a prediction as confirmed evidence.

Likewise, completing or verifying work does not silently resolve linked
observations. The user must inspect the outcome and resolve the evidence with
an appropriate resolution note. A linked observation cannot be permanently
deleted until it has been unlinked from its maintenance tasks.

## REST examples

Create planned work:

```json
{
  "propertyId": "property-1",
  "houseId": "house-1",
  "floorId": "cellar",
  "title": "Repair the sink drain coupling",
  "description": "Dry the cabinet and inspect the surrounding timber.",
  "basis": "condition-based",
  "basisDetail": "Linked leak observation",
  "priority": "high",
  "plannedFor": "2026-07-18",
  "dueBy": "2026-07-21",
  "observationIds": ["observation-1"]
}
```

Use `POST /api/v1/maintenance-tasks`. New tasks start at revision 1 in
`planned`. Start work with an optimistic patch:

```json
{
  "baseRevision": 1,
  "status": "in-progress"
}
```

Complete it with the observed outcome:

```json
{
  "baseRevision": 2,
  "status": "completed",
  "completionNote": "Replaced the coupling and dried the cabinet."
}
```

Verify it after follow-up:

```json
{
  "baseRevision": 3,
  "status": "verified",
  "verificationNote": "No new moisture after 48 hours."
}
```

List work by `propertyId`, `houseId`, `areaId`, or `equipmentId` with
`GET /api/v1/maintenance-tasks`, patch a task at
`PATCH /api/v1/maintenance-tasks/{id}`, and inspect its ordered audit history at
`GET /api/v1/maintenance-tasks/{id}/revisions`. Collection queries support
bounded pagination.

Every effective change increments `revision`. A stale `baseRevision` returns
HTTP 409 and must be reloaded before retrying. A no-op does not create a new
revision, but still checks that the base revision is current. Revision rows are
append-only and record the authenticated REST account or trusted local
MCP/migration channel where available.

## Deliberate scope

This release establishes observation-to-work and property-equipment planning.
The `AreaEquipment` registry is distinct from `AssetRecord`, which still refers
to uploaded floor-plan and 3D files. Recurrence, contractor work orders,
inventory reservations, costs, and predictive models remain separate future
capabilities rather than being hidden in task notes.
