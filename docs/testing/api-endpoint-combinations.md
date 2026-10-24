# API endpoint combinations for testing

This is a testing list for Stugu 0.41.19: **342 local API operations** (316 v1 and 26 v2), plus **one optional bug-report relay operation**. Each operation is a method and path, so GET and POST on the same path are separate entries.

The files cover endpoint inputs, applicable account/resource/runtime states, and multi-endpoint workflows. **All 117,649 ordered two-operation pairs are listed**, including repeats, reverse order, both versions and the relay. Arbitrary payload values, subsets of all endpoints and sequences of unrestricted length cannot be fully listed. These are proposed tests, not executed results.

## Testing files

| File | Contents |
| --- | --- |
| [api-endpoint-matrix.json](api-endpoint-matrix.json) | Every operation, resolved parameters, body schemas, response contracts, security alternatives, compact input factors and common profiles |
| [api-input-cases.ndjson](api-input-cases.ndjson) | 18,287 individual schema, boundary, omission, null, enum, nested branch and invalid-input cases |
| [api-query-combinations.ndjson](api-query-combinations.ndjson) | 1,399 combinations of query presence, enums and booleans; other values use synthetic fixtures |
| [api-endpoint-pairs.ndjson](api-endpoint-pairs.ndjson) | 117,649 rows of [first operation key, second operation key] |
| [api-workflows.json](api-workflows.json) | 40 ordered workflows with prerequisites, assertions and negative cases |

Operation keys include the version because operationId alone is not unique across documents. Look up each key in the matrix to find its method, path and contract. Relay paths use their separate configured service origin. Local-only pair coverage is 116,964; filtering pairs to first key less than second key gives 58,653 distinct unordered pairs across all services.

## How to use the combinations

1. Seed synthetic accounts and resources in an isolated test installation. Give successful requests valid ownership, related IDs and credentials. Capture returned IDs and revisions for subsequent requests. Use temporary databases/secrets files and fake providers, actuators, host/update agents and GitHub transport.
2. Run a valid baseline for each operation and verify its documented success status, media type and response body. An empty result, stale cache or missing prerequisite is a different scenario with its own oracle.
3. Run each applicable input case by changing its named field while keeping the fixture otherwise valid. A field-level accept means only that schema node accepts the value. It does not promise whole-request success. Conditions in when identify required parent objects, array items or union branches. Query/path values require their documented wire encoding; ordinary numeric query strings are valid encodings.
4. Enumerate the query combinations, replacing fixture choices with valid synthetic values. Omitted values and explicit defaults are separate cases. Check from/to relationships, scope and other domain constraints before declaring a combination valid.
5. For bodies, cross all listed topLevelFactors and conditional nested branch choices from the original schemas and input cases. Enum values, booleans, null and omission are explicit; strings, numbers, arrays and objects use representative values plus boundary cases. topLevelCandidateCount is a candidate count before validation. Branch-only fields and complex-value products are not included in that count. Apply required fields, oneOf/anyOf/allOf, minProperties and runtime rules to the complete candidate.
6. Cross the applicable common profiles with each endpoint's inputs. Set expected status and state from the route/middleware, not from HTTP method alone. Keep incompatible fixture states separate. Record unsupported combinations as inapplicable, with a reason.
7. Run the selected workflows, then the exhaustive endpoint pairs. For each pair, supply prerequisites, capture the first result, and assert the second result and state. Reversed order and repeating a mutation can intentionally fail. Reset state between cases. For streams, subscribe before the triggering call and close during teardown.

The matrix preserves OpenAPI constraints and response schemas. Formats, trimming, ownership, lifecycle prerequisites, idempotency and middleware policies also need the implementation and existing tests. The relay supplement is explicitly hand-mapped from its source and shared validator; it is not part of the local OpenAPI counts.

## Shared test dimensions

Cross only factors applicable to the chosen route. The JSON contains every factor's case list and its oracle.

| Profile | Applies to | Dimensions |
| --- | --- | --- |
| browser-auth | Local browser-session routes; apply public/setup exceptions from middleware | account, session, setup |
| browser-write | Unsafe browser-session methods, with documented middleware exceptions | csrf, origin, contentType |
| machine-auth | Routes with machine credentials or Stuguby signatures | credential, credentialSource |
| resource-scope | Scoped operations; identifiers in path, query, body, arrays and nested references | resource, property |
| pagination-and-time | Collection/history routes with relevant parameters | page, range, filter |
| revision-and-repeat | Mutations, especially baseRevision/expectedRevision/operationId routes | order, revision |
| telemetry-and-mode | Telemetry, weather, monitoring, analytics, forecasts and tracking | mode, evidence |
| dependency-state | External integrations, workers, archive storage, host agents and inference engines | dependency, cache |
| event-stream | Routes whose successful content type is text/event-stream | connection, access |
| transport | Every applicable route | method, payload |
| privacy-and-side-effects | Every response and mutation | result |

Important policy cases include Owner/Admin/Member/Guest access; ungranted resources concealed as not found; immediate grant/account revocation; a Property without Homes; hidden Home write denial with retained Property records; route-scoped machine credentials; current/stale revisions; live/demo separation; stale/partial evidence; failed integrations; stream cleanup; secret redaction and no unauthorized mutation.

POST /api/v2/analytics/query and /analytics/coverage have explicit read-only middleware exceptions. Guest notification registration and bug reporting also have self-service exceptions. Documented security alternatives use OR between objects and AND within each object. Check actual session/ingest alternatives in middleware where documentation is incomplete. General unsupported API methods may return 404; MCP and the relay explicitly implement 405. HEAD and OPTIONS are transport cases rather than separate documented operations.

## Workflow list

The full operation sequence, subscriptions, fixture requirements and assertions are in api-workflows.json. Each step has to be evaluated under its intended fixture state; negative steps are not all expected to return success.

| ID | Workflow | Calls | Stream subscriptions |
| --- | --- | ---: | ---: |
| WF01 | Owner setup and session lifecycle | 7 | 0 |
| WF02 | Invitation and immediate access revocation | 9 | 0 |
| WF03 | Property without a Home | 11 | 0 |
| WF04 | Home layout and sensor lifecycle | 12 | 0 |
| WF05 | Hide Home and preserve Property history | 10 | 0 |
| WF06 | Area equipment attachments and links | 16 | 0 |
| WF07 | Property notes and optimistic observations | 11 | 0 |
| WF08 | Maintenance planning through verification | 8 | 0 |
| WF09 | Legacy readings and compatibility aliases | 7 | 2 |
| WF10 | Measurement registry and sparse ingestion | 10 | 1 |
| WF11 | Analytics coverage and query combinations | 3 | 0 |
| WF12 | Calendar comparison and opening activity | 4 | 0 |
| WF13 | Derived analytics cache and monitoring | 12 | 0 |
| WF14 | Weather inheritance and thermal calculations | 7 | 0 |
| WF15 | Property electricity and Home consumption | 7 | 0 |
| WF16 | Alert rules events and delivery retries | 11 | 1 |
| WF17 | Action playbooks and runs | 9 | 0 |
| WF18 | Apple notification registration ownership | 5 | 0 |
| WF19 | Discovery jobs and sensor mapping | 8 | 1 |
| WF20 | Home Assistant connection lifecycle | 7 | 0 |
| WF21 | TP-Link connection and credential reuse | 8 | 0 |
| WF22 | Tapo history worker queue | 10 | 0 |
| WF23 | Telegram pairing and test delivery | 6 | 0 |
| WF24 | Apple Notes grant capture and deduplication | 8 | 0 |
| WF25 | Gree local and cloud heat pump placement | 8 | 0 |
| WF26 | Tuya device configuration and control | 6 | 0 |
| WF27 | Nexus433 candidate binding and recovery | 7 | 0 |
| WF28 | Tracking enrollment evidence and map stream | 21 | 1 |
| WF29 | Equipment borrowing and explicit presence | 7 | 0 |
| WF30 | Spatial layer configuration and inference | 19 | 1 |
| WF31 | Stuguby collaboration and grant revocation | 16 | 0 |
| WF32 | Stuguby signed protocol replay and blobs | 9 | 1 |
| WF33 | Exports schedules and backup requests | 9 | 0 |
| WF34 | Demo and replay isolation | 8 | 0 |
| WF35 | System updates with simulated host agent | 6 | 1 |
| WF36 | Storage and host monitoring | 6 | 0 |
| WF37 | MCP runtime and HTTP transport | 6 | 0 |
| WF38 | Cloudflare setup callback and one-time claim | 5 | 0 |
| WF39 | Bug report configuration relay and failure recovery | 6 | 0 |
| WF40 | Static parameters assets and Apple RoomPlan | 11 | 0 |

## Complete endpoint inventory

Parameter markers: * required, ? optional. The JSON expands references and lists query literals; body constraints and nested inputs are available through requestBodies and components.schemas. Status values below are documented codes, not a claim that all middleware failures are documented. Administration roles still require their runtime guards.

| Operation key | Method and endpoint | Parameters | Body schema | Documented security | Documented statuses |
| --- | --- | --- | --- | --- | --- |
| `v1:setupLocalOwner` | POST `/api/v1/auth/setup` | — | LocalAuthCredentials | public | 201, 403, 409, 429 |
| `v1:registerLocalInvitation` | POST `/api/v1/auth/register` | — | LocalInvitationRegistrationInput | public | 201, 404, 429 |
| `v1:loginLocalMember` | POST `/api/v1/auth/login` | — | LocalAuthCredentials | public | 200, 401, 429 |
| `v1:logoutLocalMember` | POST `/api/v1/auth/logout` | — | — | localSession + csrfToken | 204 |
| `v1:listLocalWorkspaceMembers` | GET `/api/v1/tenant/members` | — | — | localSession | 200 |
| `v1:inviteLocalWorkspaceMember` | POST `/api/v1/tenant/members` | — | TenantMemberCreateInput | localSession + csrfToken | 201, 409 |
| `v1:updateLocalWorkspaceMemberAccess` | PUT `/api/v1/tenant/members/{email}/access` | path:email* | inline schema | localSession + csrfToken | 200, 404 |
| `v1:removeLocalWorkspaceMember` | DELETE `/api/v1/tenant/members/{email}` | path:email* | — | localSession + csrfToken | 204, 404 |
| `v1:listSecurityAuditEvents` | GET `/api/v1/security/audit-events` | query:limit?, query:offset? | — | localSession | 200, 403 |
| `v1:getHostSystemHealth` | GET `/api/v1/system/health` | — | — | localSession | 200, 403 |
| `v1:getHostSystemPrometheusMetrics` | GET `/api/v1/system/metrics` | — | — | localSession OR ingestKey | 200, 403 |
| `v1:exportSystemErrorLogs` | GET `/api/v1/system/error-logs` | — | — | localSession | 200, 403 |
| `v1:getSystemUpdateStatus` | GET `/api/v1/system/updates` | — | — | localSession | 200, 403 |
| `v1:getSystemStorageStatus` | GET `/api/v1/system/storage` | — | — | localSession | 200, 403 |
| `v1:updateSystemStorage` | PUT `/api/v1/system/storage` | — | inline schema | localSession + csrfToken | 202, 400, 409, 503 |
| `v1:streamSystemUpdateStatus` | GET `/api/v1/system/updates/events` | — | — | localSession | 200, 403, 429 |
| `v1:checkSystemUpdates` | POST `/api/v1/system/updates/check` | — | — | localSession + csrfToken | 200, 403 |
| `v1:updateSystemUpdateSettings` | PATCH `/api/v1/system/updates/settings` | — | inline schema | localSession + csrfToken | 200, 400, 403 |
| `v1:installLatestSystemUpdate` | POST `/api/v1/system/updates/install` | — | — | localSession + csrfToken | 202, 403, 409, 503 |
| `v1:requestSystemUpdateOperation` | POST `/api/v1/system/updates/operations` | — | 4 oneOf shapes | localSession + csrfToken | 202, 400, 403, 409, 503 |
| `v1:getCloudflareSetupStatus` | GET `/api/v1/cloudflare/setup` | — | — | localSession | 200, 403 |
| `v1:startCloudflareSetup` | POST `/api/v1/cloudflare/setup/start` | — | inline schema | localSession + csrfToken | 202, 403, 409, 503 |
| `v1:completeCloudflareSetupOAuth` | GET `/api/v1/cloudflare/setup/oauth/callback` | — | — | public | 200, 400 |
| `v1:claimCloudflareSetupCredentials` | GET `/api/v1/internal/cloudflare-setup/claims/{id}` | path:id* | — | public | 200, 404 |
| `v1:listSpatialLayerEngines` | GET `/api/v1/layer-engines` | — | — | localSession | 200 |
| `v1:getHouseSpatialLayersCurrent` | GET `/api/v1/houses/{id}/layers/current` | path:id*, query:layers? | — | localSession | 200, 503 |
| `v1:getHouseSpatialLayersHistory` | GET `/api/v1/houses/{id}/layers/history` | path:id*, query:layers?, query:from?, query:to?, query:limit?, query:includeSuperseded? | — | localSession | 200, 503 |
| `v1:getHouseSpatialLayerHealth` | GET `/api/v1/houses/{id}/layers/health` | path:id* | — | localSession | 200, 503 |
| `v1:getHouseSpatialLayerConfig` | GET `/api/v1/houses/{id}/layers/config` | path:id* | — | localSession | 200, 503 |
| `v1:updateHouseSpatialLayerConfig` | PUT `/api/v1/houses/{id}/layers/config` | path:id* | SpatialLayerConfigurationInput | localSession | 200, 409, 503 |
| `v1:listHouseSpatialLayerGroundTruth` | GET `/api/v1/houses/{id}/layers/ground-truth` | path:id* | — | localSession | 200 |
| `v1:createHouseSpatialLayerGroundTruth` | POST `/api/v1/houses/{id}/layers/ground-truth` | path:id* | SpatialGroundTruthInput | localSession | 201 |
| `v1:getPropertySpatialLayersCurrent` | GET `/api/v1/properties/{id}/layers/current` | path:id*, query:layers? | — | localSession | 200, 503 |
| `v1:getPropertySpatialLayersHistory` | GET `/api/v1/properties/{id}/layers/history` | path:id*, query:layers?, query:from?, query:to?, query:limit?, query:includeSuperseded? | — | localSession | 200, 503 |
| `v1:getPropertySpatialLayerHealth` | GET `/api/v1/properties/{id}/layers/health` | path:id* | — | localSession | 200, 503 |
| `v1:getPropertySpatialLayerConfig` | GET `/api/v1/properties/{id}/layers/config` | path:id* | — | localSession | 200, 503 |
| `v1:updatePropertySpatialLayerConfig` | PUT `/api/v1/properties/{id}/layers/config` | path:id* | SpatialLayerConfigurationInput | localSession | 200, 409, 503 |
| `v1:listPropertySpatialLayerGroundTruth` | GET `/api/v1/properties/{id}/layers/ground-truth` | path:id* | — | localSession | 200 |
| `v1:createPropertySpatialLayerGroundTruth` | POST `/api/v1/properties/{id}/layers/ground-truth` | path:id* | SpatialGroundTruthInput | localSession | 201 |
| `v1:getHouseSpatialInferenceSession` | GET `/api/v1/houses/{id}/layers/inference-session` | path:id* | — | localSession | 200, 503 |
| `v1:startHouseSpatialInferenceSession` | POST `/api/v1/houses/{id}/layers/inference-session` | path:id* | SpatialInferenceSessionStartInput | localSession | 201, 409, 503 |
| `v1:stopHouseSpatialInferenceSession` | DELETE `/api/v1/houses/{id}/layers/inference-session` | path:id* | — | localSession | 200, 503 |
| `v1:listHouseSpatialBindings` | GET `/api/v1/houses/{id}/layers/bindings` | path:id* | — | localSession | 200, 503 |
| `v1:createHouseSpatialBindings` | POST `/api/v1/houses/{id}/layers/bindings` | path:id* | SpatialSensorBindingInput | localSession | 201, 503 |
| `v1:listHouseSpatialCalibrations` | GET `/api/v1/houses/{id}/layers/calibrations` | path:id* | — | localSession | 200, 503 |
| `v1:createHouseSpatialCalibrations` | POST `/api/v1/houses/{id}/layers/calibrations` | path:id* | SpatialSensorCalibrationInput | localSession | 201, 503 |
| `v1:listHouseSpatialCalibrationSessions` | GET `/api/v1/houses/{id}/layers/calibration-sessions` | path:id* | — | localSession | 200, 503 |
| `v1:createHouseSpatialCalibrationSessions` | POST `/api/v1/houses/{id}/layers/calibration-sessions` | path:id* | SpatialCalibrationSessionInput | localSession | 201, 503 |
| `v1:listHouseSpatialContextEvents` | GET `/api/v1/houses/{id}/layers/context-events` | path:id*, query:from?, query:to? | — | localSession | 200, 503 |
| `v1:createHouseSpatialContextEvents` | POST `/api/v1/houses/{id}/layers/context-events` | path:id* | SpatialContextEventInput | localSession | 201, 503 |
| `v1:streamSpatialLayerSnapshots` | GET `/api/v1/layers/events` | query:scopeKind?="house"/"property", query:scopeId? | — | localSession | 200, 503 |
| `v1:useLocalMcpOverHttp` | POST `/api/v1/mcp` | — | — | mcpBearer | 200, 401, 503 |
| `v1:getLocalMcpRuntimeStatus` | GET `/api/v1/system/mcp-runtime` | — | — | localSession | 200, 403 |
| `v1:startLocalMcpRuntime` | POST `/api/v1/system/mcp-runtime/start` | — | — | localSession + csrfToken | 200, 403, 409, 503 |
| `v1:stopLocalMcpRuntime` | POST `/api/v1/system/mcp-runtime/stop` | — | — | localSession + csrfToken | 200, 403, 503 |
| `v1:getPropertyEnergyOptimization` | GET `/api/v1/properties/{id}/energy-optimization` | path:id*, query:windowHours? | — | localSession | 200, 404 |
| `v1:listNotificationDeliveries` | GET `/api/v1/notification-deliveries` | query:limit? | — | localSession | 200 |
| `v1:retryNotificationDelivery` | POST `/api/v1/notification-deliveries/{id}/retry` | path:id* | — | localSession | 200, 403, 409 |
| `v1:listActionPlaybooks` | GET `/api/v1/action-playbooks` | query:metric?, query:enabled? | — | localSession | 200 |
| `v1:createActionPlaybook` | POST `/api/v1/action-playbooks` | — | ActionPlaybookInput | localSession | 201, 400 |
| `v1:updateActionPlaybook` | PATCH `/api/v1/action-playbooks/{id}` | path:id* | ActionPlaybookPatch | localSession | 200, 400, 404 |
| `v1:listAlertActionPlaybooks` | GET `/api/v1/alerts/{id}/action-playbooks` | path:id* | — | localSession | 200, 404 |
| `v1:listActionRuns` | GET `/api/v1/action-runs` | query:houseId?, query:sensorId?, query:alertEventId?, query:active?, query:limit? | — | localSession | 200, 400, 404 |
| `v1:startActionRun` | POST `/api/v1/action-runs` | — | ActionRunStartInput | localSession | 201, 400, 404, 409 |
| `v1:completeActionRun` | POST `/api/v1/action-runs/{id}/complete` | path:id* | — | localSession | 200, 404 |
| `v1:cancelActionRun` | POST `/api/v1/action-runs/{id}/cancel` | path:id* | ActionRunCancelInput | localSession | 200, 404 |
| `v1:previewDataExport` | GET `/api/v1/data-export/preview` | query:privacyLevel?="structure"/"operations"/"full", query:includeTelemetry? | — | localSession | 200 |
| `v1:exportData` | GET `/api/v1/data-export` | query:privacyLevel?="structure"/"operations"/"full", query:includeTelemetry? | — | localSession | 200 |
| `v1:getBackupStatus` | GET `/api/v1/backups/status` | — | — | localSession | 200 |
| `v1:requestBackup` | POST `/api/v1/backups` | — | — | localSession | 202 |
| `v1:runSetupDoctor` | GET `/api/v1/setup/doctor` | — | — | localSession | 200 |
| `v1:getSensorLabel` | GET `/api/v1/sensors/{id}/label` | path:id* | — | localSession | 200, 404 |
| `v1:bulkUpdateSensorMappings` | POST `/api/v1/setup/bulk-sensor-mappings` | — | BulkSensorMappingsInput | localSession | 200, 400 |
| `v1:getTrackingCapabilities` | GET `/api/v1/tracking/capabilities` | — | — | localSession | 200 |
| `v1:getTrackingProfileManifest` | GET `/api/v1/tracking/profiles` | — | — | localSession | 200 |
| `v1:assessTrackingCompatibility` | POST `/api/v1/tracking/compatibility-assessments` | — | TrackingCompatibilityAssessmentInput | localSession | 200, 404 |
| `v1:getTrackingSettings` | GET `/api/v1/properties/{propertyId}/tracking-settings` | path:propertyId* | — | localSession | 200 |
| `v1:updateTrackingSettings` | PATCH `/api/v1/properties/{propertyId}/tracking-settings` | path:propertyId* | inline schema | localSession | 200 |
| `v1:listTrackingEndpoints` | GET `/api/v1/tracking/endpoints` | query:propertyId* | — | localSession | 200 |
| `v1:enrollTrackingEndpoint` | POST `/api/v1/tracking/endpoints` | — | TrackingEndpointEnrollmentInput | localSession | 201 |
| `v1:getTrackingEndpoint` | GET `/api/v1/tracking/endpoints/{endpointId}` | path:endpointId* | — | localSession | 200 |
| `v1:updateTrackingEndpointStatus` | PATCH `/api/v1/tracking/endpoints/{endpointId}/status` | path:endpointId* | inline schema | localSession | 200 |
| `v1:listEquipmentTrackingBindings` | GET `/api/v1/properties/{propertyId}/tracking-bindings` | path:propertyId*, query:history? | — | localSession | 200 |
| `v1:bindTrackingEndpoint` | POST `/api/v1/area-equipment/{equipmentId}/tracking-binding` | path:equipmentId* | EquipmentTrackingBindingInput | localSession | 201 |
| `v1:unbindTrackingEndpoint` | DELETE `/api/v1/area-equipment/{equipmentId}/tracking-binding` | path:equipmentId* | — | localSession | 200 |
| `v1:listTrackingObservers` | GET `/api/v1/properties/{propertyId}/tracking-observers` | path:propertyId* | — | localSession | 200 |
| `v1:registerTrackingObserver` | POST `/api/v1/tracking/observers/register` | — | inline schema | localSession | 201 |
| `v1:updateTrackingObserver` | PATCH `/api/v1/tracking/observers/{observerId}` | path:observerId* | inline schema | localSession | 200 |
| `v1:getTrackingResolutionManifest` | GET `/api/v1/tracking/observers/{observerId}/resolution-manifest` | path:observerId* | — | trackingObserverBearer | 200 |
| `v1:heartbeatTrackingObserver` | POST `/api/v1/tracking/observers/{observerId}/heartbeat` | path:observerId* | inline schema | trackingObserverBearer | 200 |
| `v1:positionTrackingObserver` | POST `/api/v1/tracking/observers/{observerId}/position` | path:observerId* | inline schema | localSession | 200 |
| `v1:ingestTrackingEvidence` | POST `/api/v1/tracking/evidence:batch` | — | TrackingObservationBatchInput | localSession OR trackingObserverBearer | 200 |
| `v1:listEquipmentLoans` | GET `/api/v1/properties/{propertyId}/equipment-loans` | path:propertyId*, query:equipmentId?, query:active?, query:limit? | — | localSession | 200 |
| `v1:borrowEquipment` | POST `/api/v1/area-equipment/{equipmentId}/borrow` | path:equipmentId* | EquipmentBorrowInput | localSession | 201, 409 |
| `v1:returnEquipment` | POST `/api/v1/equipment-loans/{loanId}/return` | path:loanId* | EquipmentReturnInput | localSession | 200 |
| `v1:listPropertyMemberLocations` | GET `/api/v1/properties/{propertyId}/member-locations` | path:propertyId* | — | localSession | 200 |
| `v1:sharePropertyMemberLocation` | PUT `/api/v1/properties/{propertyId}/member-location` | path:propertyId* | PropertyMemberLocationInput | localSession | 200 |
| `v1:stopPropertyMemberLocation` | DELETE `/api/v1/properties/{propertyId}/member-location` | path:propertyId* | — | localSession | 204 |
| `v1:listTrackedEquipment` | GET `/api/v1/properties/{propertyId}/tracked-equipment` | path:propertyId* | — | localSession | 200, 413 |
| `v1:getTrackedEquipmentPosition` | GET `/api/v1/area-equipment/{equipmentId}/tracking-position` | path:equipmentId* | — | localSession | 200 |
| `v1:getTrackedEquipmentPositionHistory` | GET `/api/v1/area-equipment/{equipmentId}/tracking-position-history` | path:equipmentId*, query:limit? | — | localSession | 200 |
| `v1:setManualEquipmentTrackingPosition` | PUT `/api/v1/area-equipment/{equipmentId}/manual-tracking-position` | path:equipmentId* | EquipmentManualLocationInput | localSession | 200 |
| `v1:getTrackedEquipmentEvidence` | GET `/api/v1/area-equipment/{equipmentId}/tracking-observations` | path:equipmentId*, query:limit? | — | localSession | 200 |
| `v1:getTrackingFindDescriptor` | GET `/api/v1/area-equipment/{equipmentId}/tracking-find-descriptor` | path:equipmentId* | — | localSession | 200 |
| `v1:getTrackingMapSnapshot` | GET `/api/v1/properties/{propertyId}/tracking-map-snapshot` | path:propertyId* | — | localSession | 200, 413 |
| `v1:streamTrackingUpdates` | GET `/api/v1/properties/{propertyId}/tracking-stream` | path:propertyId*, query:sequence? | — | localSession | 200 |
| `v1:listStugubys` | GET `/api/v1/stugbys` | — | — | localSession | 200 |
| `v1:createStuguby` | POST `/api/v1/stugbys` | — | inline schema | localSession | 201, 503 |
| `v1:configureStugubyCoordinator` | PUT `/api/v1/stugbys/configuration` | — | inline schema | localSession | 200, 409, 422 |
| `v1:joinStuguby` | POST `/api/v1/stugbys/join` | — | inline schema | localSession | 201 |
| `v1:getStuguby` | GET `/api/v1/stugbys/{stugubyId}` | path:stugubyId* | — | localSession | 200 |
| `v1:deleteStuguby` | DELETE `/api/v1/stugbys/{stugubyId}` | path:stugubyId* | — | localSession | 204, 409 |
| `v1:createStugubyInvitation` | POST `/api/v1/stugbys/{stugubyId}/invitations` | path:stugubyId* | inline schema | localSession | 201, 503 |
| `v1:revokeStugubyInvitation` | DELETE `/api/v1/stugbys/{stugubyId}/invitations/{invitationId}` | path:stugubyId*, path:invitationId* | — | localSession | 204 |
| `v1:updateStugubyMember` | PATCH `/api/v1/stugbys/{stugubyId}/members/{nodeId}` | path:stugubyId*, path:nodeId* | inline schema | localSession | 200, 409 |
| `v1:updateStugubyMemberLabel` | PATCH `/api/v1/stugbys/{stugubyId}/members/{nodeId}/label` | path:stugubyId*, path:nodeId* | inline schema | localSession | 200 |
| `v1:getStugubySharedProperty` | GET `/api/v1/stugbys/{stugubyId}/property` | path:stugubyId* | — | localSession | 200 |
| `v1:updateStugubySharedProperty` | PUT `/api/v1/stugbys/{stugubyId}/property` | path:stugubyId* | inline schema | localSession | 200, 409 |
| `v1:adoptStugubyProperty` | POST `/api/v1/stugbys/{stugubyId}/property/adopt` | path:stugubyId* | inline schema | localSession | 201 |
| `v1:migrateLocalPropertyIntoStuguby` | POST `/api/v1/stugbys/{stugubyId}/property/migrate` | path:stugubyId* | inline schema | localSession | 200, 409 |
| `v1:disconnectStugubyProperty` | POST `/api/v1/stugbys/{stugubyId}/property/disconnect` | path:stugubyId* | inline schema | localSession | 200, 409 |
| `v1:resolveStugubyPropertyConflict` | POST `/api/v1/stugbys/{stugubyId}/property-conflicts/{commandId}/resolve` | path:stugubyId*, path:commandId* | — | localSession | 204, 404 |
| `v1:createStugubyShareGrant` | POST `/api/v1/stugbys/{stugubyId}/grants` | path:stugubyId* | inline schema | localSession | 201, 409 |
| `v1:getLocalStugubyPublicationCatalog` | GET `/api/v1/stugbys/{stugubyId}/publications/{houseId}` | path:stugubyId*, path:houseId* | — | localSession | 200 |
| `v1:updateStugubyShareGrant` | PUT `/api/v1/stugbys/{stugubyId}/grants/{grantId}` | path:stugubyId*, path:grantId* | inline schema | localSession | 200 |
| `v1:revokeStugubyShareGrant` | DELETE `/api/v1/stugbys/{stugubyId}/grants/{grantId}` | path:stugubyId*, path:grantId* | — | localSession | 200 |
| `v1:removeInvalidStugubyGrant` | DELETE `/api/v1/stugbys/{stugubyId}/grants/{grantId}/invalid` | path:stugubyId*, path:grantId* | — | localSession | 200 |
| `v1:republishStugubyGrant` | POST `/api/v1/stugbys/{stugubyId}/grants/{grantId}/republish` | path:stugubyId*, path:grantId* | — | localSession | 202 |
| `v1:syncStuguby` | POST `/api/v1/stugbys/{stugubyId}/sync` | path:stugubyId* | — | localSession | 200 |
| `v1:queryStugubyRemoteTelemetry` | GET `/api/v1/stugbys/{stugubyId}/telemetry` | path:stugubyId* | — | localSession | 200 |
| `v1:downloadLocalStugubyAsset` | GET `/api/v1/stugbys/{stugubyId}/assets/{digest}` | path:stugubyId*, path:digest* | — | localSession | 200, 404 |
| `v1:acceptStugubyNodeJoin` | POST `/api/v1/stugby-protocol/join` | — | inline schema | public | 201 |
| `v1:pullStugubyEvents` | GET `/api/v1/stugby-protocol/stugbys/{stugubyId}/events` | path:stugubyId* | — | stugubyNodeSignature | 200 |
| `v1:publishStugubyEvents` | POST `/api/v1/stugby-protocol/stugbys/{stugubyId}/events` | path:stugubyId* | inline schema | stugubyNodeSignature | 200 |
| `v1:streamStugubyAvailability` | GET `/api/v1/stugby-protocol/stugbys/{stugubyId}/events/stream` | path:stugubyId* | — | stugubyNodeSignature | 200 |
| `v1:downloadStugubyBlob` | GET `/api/v1/stugby-protocol/stugbys/{stugubyId}/blobs/{digest}` | path:stugubyId*, path:digest* | — | stugubyNodeSignature | 200 |
| `v1:uploadStugubyBlob` | PUT `/api/v1/stugby-protocol/stugbys/{stugubyId}/blobs/{digest}` | path:stugubyId*, path:digest* | — | stugubyNodeSignature | 201 |
| `v1:forwardStugubyPropertyUpdate` | PUT `/api/v1/stugby-protocol/stugbys/{stugubyId}/property` | path:stugubyId* | inline schema | stugubyNodeSignature | 200 |
| `v1:applyStugubyPropertyCommand` | POST `/api/v1/stugby-protocol/stugbys/{stugubyId}/property-commands` | path:stugubyId* | inline schema | stugubyNodeSignature | 200 |
| `v1:applyStugubyHomeCommand` | POST `/api/v1/stugby-protocol/stugbys/{stugubyId}/home-commands` | path:stugubyId* | inline schema | stugubyNodeSignature | 200 |
| `v1:acknowledgeStugubyDeletion` | POST `/api/v1/stugby-protocol/stugbys/{stugubyId}/deletion-receipts` | path:stugubyId* | — | stugubyNodeSignature | 204 |
| `v1:health` | GET `/api/v1/health` | — | — | public | 200 |
| `v1:openApiDocument` | GET `/api/v1/openapi.json` | — | — | public | 200 |
| `v1:localSession` | GET `/api/v1/session` | — | — | public | 200, 401 |
| `v1:searchLocations` | GET `/api/v1/locations/search` | query:q*, query:language? | — | localSession | 200, 400, 503 |
| `v1:coordinateDefaults` | GET `/api/v1/locations/defaults` | query:latitude*, query:longitude* | — | localSession | 200, 400, 422, 503 |
| `v1:listProperties` | GET `/api/v1/properties` | query:limit?, query:offset? | — | localSession | 200 |
| `v1:createProperty` | POST `/api/v1/properties` | — | PropertyInput | localSession | 201, 409, 422 |
| `v1:getProperty` | GET `/api/v1/properties/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updateProperty` | PATCH `/api/v1/properties/{id}` | path:id* | PropertyPatch | localSession | 200, 404, 422 |
| `v1:deleteProperty` | DELETE `/api/v1/properties/{id}` | path:id* | — | localSession | 204, 404, 409 |
| `v1:getPropertyInventory` | GET `/api/v1/properties/{propertyId}/inventory` | path:propertyId* | — | localSession | 200, 404, 413 |
| `v1:getPropertyElectricity` | GET `/api/v1/properties/{id}/electricity` | path:id*, query:from?, query:to? | — | localSession | 200, 404 |
| `v1:configurePropertyElectricity` | PUT `/api/v1/properties/{id}/electricity/config` | path:id* | PropertyElectricityConfigInput | localSession | 200, 400, 404 |
| `v1:refreshPropertyElectricity` | POST `/api/v1/properties/{id}/electricity/refresh` | path:id* | — | localSession | 200, 404, 502 |
| `v1:listPropertyAreas` | GET `/api/v1/property-areas` | query:propertyId?, query:limit?, query:offset? | — | localSession | 200 |
| `v1:createPropertyArea` | POST `/api/v1/property-areas` | — | PropertyAreaInput | localSession | 201, 404, 409, 422 |
| `v1:getPropertyArea` | GET `/api/v1/property-areas/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updatePropertyArea` | PATCH `/api/v1/property-areas/{id}` | path:id* | PropertyAreaPatch | localSession | 200, 404, 409, 422 |
| `v1:deletePropertyArea` | DELETE `/api/v1/property-areas/{id}` | path:id* | — | localSession | 204, 404, 409 |
| `v1:listAreaEquipment` | GET `/api/v1/area-equipment` | query:propertyId?, query:houseId?, query:areaId?, query:limit?, query:offset? | — | localSession | 200 |
| `v1:createAreaEquipment` | POST `/api/v1/area-equipment` | — | AreaEquipmentInput | localSession | 201, 404, 409, 422 |
| `v1:getAreaEquipment` | GET `/api/v1/area-equipment/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updateAreaEquipment` | PATCH `/api/v1/area-equipment/{id}` | path:id* | AreaEquipmentPatch | localSession | 200, 404, 409, 422 |
| `v1:deleteAreaEquipment` | DELETE `/api/v1/area-equipment/{id}` | path:id* | — | localSession | 204, 404, 409 |
| `v1:listEquipmentAttachments` | GET `/api/v1/area-equipment/{equipmentId}/attachments` | path:equipmentId* | — | localSession | 200, 404 |
| `v1:uploadEquipmentAttachment` | POST `/api/v1/area-equipment/{equipmentId}/attachments` | path:equipmentId* | EquipmentAttachmentUploadInput | localSession | 201, 404, 413, 415 |
| `v1:downloadEquipmentAttachment` | GET `/api/v1/area-equipment/{equipmentId}/attachments/{attachmentId}` | path:equipmentId*, path:attachmentId* | — | localSession | 200, 404 |
| `v1:deleteEquipmentAttachment` | DELETE `/api/v1/area-equipment/{equipmentId}/attachments/{attachmentId}` | path:equipmentId*, path:attachmentId* | — | localSession | 204, 404 |
| `v1:listEquipmentLinks` | GET `/api/v1/area-equipment/{equipmentId}/links` | path:equipmentId* | — | localSession | 200, 404 |
| `v1:createEquipmentLink` | POST `/api/v1/area-equipment/{equipmentId}/links` | path:equipmentId* | EquipmentLinkInput | localSession | 201, 404, 422 |
| `v1:updateEquipmentLink` | PATCH `/api/v1/area-equipment/{equipmentId}/links/{linkId}` | path:equipmentId*, path:linkId* | EquipmentLinkPatch | localSession | 200, 404, 422 |
| `v1:deleteEquipmentLink` | DELETE `/api/v1/area-equipment/{equipmentId}/links/{linkId}` | path:equipmentId*, path:linkId* | — | localSession | 204, 404 |
| `v1:listPropertyNotes` | GET `/api/v1/property-notes` | query:propertyId?, query:houseId?, query:areaId?, query:equipmentId?, query:limit?, query:offset? | — | localSession | 200 |
| `v1:createPropertyNote` | POST `/api/v1/property-notes` | — | PropertyNoteInput | localSession | 201, 404, 409, 422 |
| `v1:getPropertyNote` | GET `/api/v1/property-notes/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updatePropertyNote` | PATCH `/api/v1/property-notes/{id}` | path:id* | PropertyNotePatch | localSession | 200, 404, 409, 422 |
| `v1:deletePropertyNote` | DELETE `/api/v1/property-notes/{id}` | path:id* | — | localSession | 204, 404 |
| `v1:listHouses` | GET `/api/v1/houses` | query:propertyId? | — | localSession | 200 |
| `v1:createHouse` | POST `/api/v1/houses` | — | HouseCreate | localSession | 201, 400, 404, 409, 422 |
| `v1:getHouse` | GET `/api/v1/houses/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updateHouse` | PATCH `/api/v1/houses/{id}` | path:id* | HousePatch | localSession | 200, 400, 404, 409, 422 |
| `v1:deleteHouse` | DELETE `/api/v1/houses/{id}` | path:id* | — | localSession | 204, 404 |
| `v1:getOpeningStates` | GET `/api/v1/houses/{id}/opening-states` | path:id*, query:at?, query:from?, query:to?, query:limit? | — | localSession | 200, 400, 404 |
| `v1:recordOpeningState` | POST `/api/v1/houses/{id}/opening-states` | path:id* | OpeningStateObservationInput | localSession | 201, 400, 404, 409 |
| `v1:getHouseElectricityPrice` | GET `/api/v1/houses/{id}/electricity-price` | path:id*, query:from?, query:to? | — | localSession | 200, 404 |
| `v1:getHouseEnergyCost` | GET `/api/v1/houses/{id}/energy-cost` | path:id*, query:sensorId*, query:from?, query:to? | — | localSession | 200, 400, 404, 503 |
| `v1:getHouseEnergySummary` | GET `/api/v1/houses/{id}/energy-summary` | path:id*, query:from?, query:to? | — | localSession | 200, 400, 404, 503 |
| `v1:getHouseWeather` | GET `/api/v1/houses/{id}/weather` | path:id*, query:hours? | — | localSession | 200, 404, 409, 503 |
| `v1:runThermalSimulation` | GET `/api/v1/houses/{id}/thermal-simulation` | path:id*, query:sensorId*, query:from?, query:to?, query:horizonHours?, query:scenarioOutdoorTemperatureC? | — | localSession | 200, 400, 404, 409 |
| `v1:compareThermalIsolation` | GET `/api/v1/houses/{id}/thermal-isolation` | path:id*, query:from?, query:to? | — | localSession | 200, 400, 404, 422 |
| `v1:compareMoistureResponse` | GET `/api/v1/houses/{id}/moisture-response` | path:id*, query:from?, query:to? | — | localSession | 200, 400, 404, 422 |
| `v1:replaceHouseLayout` | PUT `/api/v1/houses/{id}/layout` | path:id* | inline schema | localSession | 200, 404, 409 |
| `v1:replaceFloor` | PUT `/api/v1/houses/{id}/floors/{floorId}` | path:id*, path:floorId* | Floor | localSession | 200, 404, 409 |
| `v1:importAppleRoomPlanFloor` | POST `/api/v1/houses/{id}/floors/{floorId}/roomplan-import` | path:id*, path:floorId* | inline schema | localSession | 200, 400, 404, 409 |
| `v1:listSensors` | GET `/api/v1/sensors` | query:houseId? | — | localSession | 200 |
| `v1:createSensor` | POST `/api/v1/sensors` | — | SensorInput | localSession | 201, 404, 409, 422 |
| `v1:listSensorSnapshots` | GET `/api/v1/sensors/snapshots` | query:houseId? | — | localSession | 200 |
| `v1:listSnapshotCompatibility` | GET `/api/v1/snapshot` | query:houseId? | — | localSession | 200 |
| `v1:getSensor` | GET `/api/v1/sensors/{id}` | path:id* | — | localSession | 200 |
| `v1:replaceSensorFields` | PUT `/api/v1/sensors/{id}` | path:id* | SensorPatch | localSession | 200, 404, 409, 422 |
| `v1:updateSensor` | PATCH `/api/v1/sensors/{id}` | path:id* | SensorPatch | localSession | 200, 404, 409, 422 |
| `v1:deleteSensor` | DELETE `/api/v1/sensors/{id}` | path:id* | — | localSession | 204 |
| `v1:queryReadingsCompatibility` | GET `/api/v1/readings` | query:sensorId?, query:from?, query:to?, query:limit? | — | localSession | 200 |
| `v1:ingestReadings` | POST `/api/v1/readings` | — | 3 oneOf shapes | ingestKey | 201 |
| `v1:latestReadings` | GET `/api/v1/readings/latest` | query:sensorId? | — | localSession | 200 |
| `v1:queryHistory` | GET `/api/v1/history` | query:sensorId?, query:from?, query:to?, query:limit?, query:bucketSeconds?, query:forecastHours? | — | localSession | 200 |
| `v1:forecast` | GET `/api/v1/forecast` | query:sensorId?, query:hours?, query:horizonMinutes? | — | localSession | 200 |
| `v1:streamTelemetry` | GET `/api/v1/stream` | query:sensorId? | — | localSession | 200 |
| `v1:streamTelemetryCompatibility` | GET `/api/v1/events` | query:sensorId? | — | localSession | 200 |
| `v1:listAlertRules` | GET `/api/v1/alert-rules` | — | — | localSession | 200 |
| `v1:createAlertRule` | POST `/api/v1/alert-rules` | — | AlertRuleInput | localSession | 201 |
| `v1:updateAlertRule` | PATCH `/api/v1/alert-rules/{id}` | path:id* | AlertRulePatch | localSession | 200 |
| `v1:deleteAlertRule` | DELETE `/api/v1/alert-rules/{id}` | path:id* | — | localSession | 204 |
| `v1:listAlertEvents` | GET `/api/v1/alert-events` | query:active?, query:limit? | — | localSession | 200 |
| `v1:acknowledgeAlert` | POST `/api/v1/alert-events/{id}/acknowledge` | path:id* | — | localSession | 200 |
| `v1:listAlertsCompatibility` | GET `/api/v1/alerts` | query:active?, query:limit? | — | localSession | 200 |
| `v1:acknowledgeAlertCompatibility` | POST `/api/v1/alerts/{id}/acknowledge` | path:id* | — | localSession | 200 |
| `v1:getIOSNotificationRegistration` | GET `/api/v1/ios-notification-registrations/{id}` | path:id* | — | localSession | 200 |
| `v1:saveIOSNotificationRegistration` | PUT `/api/v1/ios-notification-registrations/{id}` | path:id* | IOSNotificationRegistrationInput | localSession | 200, 404, 409 |
| `v1:deleteIOSNotificationRegistration` | DELETE `/api/v1/ios-notification-registrations/{id}` | path:id* | — | localSession | 204 |
| `v1:listScheduledDataExports` | GET `/api/v1/houses/{houseId}/scheduled-data-exports` | path:houseId* | — | localSession | 200 |
| `v1:createScheduledDataExport` | POST `/api/v1/houses/{houseId}/scheduled-data-exports` | path:houseId* | ScheduledDataExportInput | localSession | 201, 409 |
| `v1:updateScheduledDataExport` | PUT `/api/v1/houses/{houseId}/scheduled-data-exports/{id}` | path:houseId*, path:id* | ScheduledDataExportUpdate | localSession | 200, 409 |
| `v1:deleteScheduledDataExport` | DELETE `/api/v1/houses/{houseId}/scheduled-data-exports/{id}` | path:houseId*, path:id* | — | localSession | 204, 409 |
| `v1:runScheduledDataExport` | POST `/api/v1/houses/{houseId}/scheduled-data-exports/{id}/run` | path:houseId*, path:id* | — | localSession | 202, 409 |
| `v1:listObservations` | GET `/api/v1/observations` | query:houseId? | — | localSession | 200 |
| `v1:createObservation` | POST `/api/v1/observations` | — | ObservationInput | localSession | 201 |
| `v1:updateObservation` | PATCH `/api/v1/observations/{id}` | path:id* | ObservationPatch | localSession | 200, 404, 409, 422 |
| `v1:deleteObservation` | DELETE `/api/v1/observations/{id}` | path:id* | — | localSession | 204, 404, 409 |
| `v1:listObservationRevisions` | GET `/api/v1/observations/{id}/revisions` | path:id* | — | localSession | 200, 404 |
| `v1:listMaintenanceTasks` | GET `/api/v1/maintenance-tasks` | query:propertyId?, query:houseId?, query:areaId?, query:equipmentId?, query:limit?, query:offset? | — | localSession | 200 |
| `v1:createMaintenanceTask` | POST `/api/v1/maintenance-tasks` | — | MaintenanceTaskInput | localSession | 201, 404, 409, 422 |
| `v1:getMaintenanceTask` | GET `/api/v1/maintenance-tasks/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:updateMaintenanceTask` | PATCH `/api/v1/maintenance-tasks/{id}` | path:id* | MaintenanceTaskPatch | localSession | 200, 404, 409, 422 |
| `v1:deleteMaintenanceTask` | DELETE `/api/v1/maintenance-tasks/{id}` | path:id* | — | localSession | 204, 404 |
| `v1:listMaintenanceTaskRevisions` | GET `/api/v1/maintenance-tasks/{id}/revisions` | path:id* | — | localSession | 200, 404 |
| `v1:listStaticParameters` | GET `/api/v1/parameters` | query:houseId? | — | localSession | 200 |
| `v1:upsertStaticParameter` | POST `/api/v1/parameters` | — | StaticParameterInput | localSession | 200 |
| `v1:deleteStaticParameter` | DELETE `/api/v1/parameters/{id}` | path:id* | — | localSession | 204 |
| `v1:listStaticParametersCompatibility` | GET `/api/v1/static-parameters` | query:houseId? | — | localSession | 200 |
| `v1:saveStaticParameterCompatibility` | POST `/api/v1/static-parameters` | — | StaticParameterInput | localSession | 201 |
| `v1:listAssets` | GET `/api/v1/assets` | query:houseId? | — | localSession | 200 |
| `v1:uploadAsset` | POST `/api/v1/assets` | — | AssetUploadInput | localSession | 201, 413, 415 |
| `v1:downloadAsset` | GET `/api/v1/assets/{id}` | path:id* | — | localSession | 200 |
| `v1:deleteAsset` | DELETE `/api/v1/assets/{id}` | path:id* | — | localSession | 204 |
| `v1:integrationStatus` | GET `/api/v1/integrations/status` | — | — | localSession | 200 |
| `v1:listSensorDataGaps` | GET `/api/v1/integrations/sensor-data-gaps` | query:houseId?, query:sensorId?, query:limit? | — | localSession | 200 |
| `v1:discoverIntegrations` | POST `/api/v1/integrations/discover` | — | inline schema | localSession | 200 |
| `v1:startIntegrationDiscovery` | POST `/api/v1/integrations/discovery-jobs` | — | inline schema | localSession | 202 |
| `v1:latestIntegrationDiscovery` | GET `/api/v1/integrations/discovery-jobs/latest` | query:houseId? | — | localSession | 200 |
| `v1:streamIntegrationDiscovery` | GET `/api/v1/integrations/discovery-jobs/events` | query:jobId* | — | localSession | 200, 404 |
| `v1:getIntegrationDiscovery` | GET `/api/v1/integrations/discovery-jobs/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:configureHomeAssistant` | PUT `/api/v1/integrations/home-assistant/config` | — | HomeAssistantConfigInput | localSession | 200, 400 |
| `v1:moveHouseHomeAssistant` | PATCH `/api/v1/integrations/home-assistant/config/{houseId}` | path:houseId* | inline schema | localSession | 200, 404, 409 |
| `v1:disconnectHouseHomeAssistant` | DELETE `/api/v1/integrations/home-assistant/config/{houseId}` | path:houseId* | — | localSession | 200, 404 |
| `v1:homeAssistantSetup` | GET `/api/v1/integrations/home-assistant/setup` | — | — | localSession | 200 |
| `v1:homeAssistantStatusTest` | POST `/api/v1/integrations/home-assistant/test` | — | — | localSession | 200 |
| `v1:testHomeAssistantDraft` | POST `/api/v1/integrations/home-assistant/test-draft` | — | HomeAssistantConfigInput | localSession | 200 |
| `v1:tpLinkSetup` | GET `/api/v1/integrations/tp-link/setup` | — | — | localSession | 200 |
| `v1:configureTpLink` | PUT `/api/v1/integrations/tp-link/config` | — | TpLinkConfigInput | localSession | 200, 400, 409 |
| `v1:moveTpLinkConnection` | PATCH `/api/v1/integrations/tp-link/config/{connectionId}` | path:connectionId* | inline schema | localSession | 200, 404, 409 |
| `v1:disconnectTpLinkConnection` | DELETE `/api/v1/integrations/tp-link/config/{connectionId}` | path:connectionId* | — | localSession | 200, 404 |
| `v1:listTpLinkDevices` | GET `/api/v1/integrations/tp-link/devices` | — | — | localSession | 200 |
| `v1:listTapoHistoryExportJobs` | GET `/api/v1/integrations/tp-link/history-export/jobs` | — | — | localSession | 200 |
| `v1:createTapoHistoryExportCanary` | POST `/api/v1/integrations/tp-link/history-export/canary` | — | inline schema | localSession | 202, 403, 409, 422 |
| `v1:createTapoHistoryBackfill` | POST `/api/v1/integrations/tp-link/history-export/backfill` | — | inline schema | localSession | 202, 403, 409, 422 |
| `v1:retryTapoHistoryExportJob` | POST `/api/v1/integrations/tp-link/history-export/jobs/{id}/retry` | path:id* | — | localSession | 200, 409 |
| `v1:cancelTapoHistoryExportJob` | DELETE `/api/v1/integrations/tp-link/history-export/jobs/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:claimTapoHistoryExportJob` | GET `/api/v1/internal/tapo-history/jobs/claim` | query:workerId*, query:deploymentFingerprint*, header:X-Tapo-Deployment-Fingerprint* | — | tapoWorkerBearer | 200, 204, 400, 401 |
| `v1:heartbeatTapoHistoryExportJob` | POST `/api/v1/internal/tapo-history/jobs/{id}/heartbeat` | path:id*, header:X-Tapo-Deployment-Fingerprint* | TapoHistoryWorkerLeaseInput | tapoWorkerBearer | 200, 409 |
| `v1:updateTapoHistoryExportJobStatus` | POST `/api/v1/internal/tapo-history/jobs/{id}/status` | path:id*, header:X-Tapo-Deployment-Fingerprint* | TapoHistoryWorkerStatusInput | tapoWorkerBearer | 200, 409 |
| `v1:tpLinkStatusTest` | POST `/api/v1/integrations/tp-link/test` | — | — | localSession | 200 |
| `v1:testTpLinkDraft` | POST `/api/v1/integrations/tp-link/test-draft` | — | TpLinkDraftInput | localSession | 200 |
| `v1:discoverTelegramChat` | POST `/api/v1/integrations/telegram/discover` | — | TelegramDiscoveryInput | localSession | 200, 400, 503 |
| `v1:configureTelegram` | PUT `/api/v1/integrations/telegram/config` | — | TelegramConfigInput | localSession | 200, 400, 503 |
| `v1:disconnectTelegram` | DELETE `/api/v1/integrations/telegram/config` | — | — | localSession | 200 |
| `v1:testTelegram` | POST `/api/v1/integrations/telegram/test` | — | — | localSession | 200, 409, 503 |
| `v1:telegramSetup` | GET `/api/v1/integrations/telegram/setup` | — | — | localSession | 200 |
| `v1:listAppleNotesGrants` | GET `/api/v1/integrations/apple-notes/grants` | — | — | localSession | 200 |
| `v1:createAppleNotesGrant` | POST `/api/v1/integrations/apple-notes/grants` | — | AppleNotesGrantInput | localSession | 201, 404 |
| `v1:revokeAppleNotesGrant` | DELETE `/api/v1/integrations/apple-notes/grants/{id}` | path:id* | — | localSession | 200, 404 |
| `v1:appleNotesSetup` | GET `/api/v1/integrations/apple-notes/setup` | — | — | localSession | 200 |
| `v1:appleNotesSnapshot` | GET `/api/v1/integrations/apple-notes/snapshot` | query:houseId* | — | notesGrant | 200, 401, 403, 404 |
| `v1:captureAppleNotesMaintenance` | POST `/api/v1/integrations/apple-notes/capture` | — | AppleNotesMaintenanceCaptureInput | notesGrant | 200, 201, 401, 403, 409, 422 |
| `v1:listMockScenarios` | GET `/api/v1/mock/scenarios` | — | — | localSession | 200 |
| `v1:selectMockScenarioCompatibility` | POST `/api/v1/mock/scenario` | — | inline schema | localSession | 200 |
| `v1:selectMockScenario` | PUT `/api/v1/mock/scenario` | — | inline schema | localSession | 200 |
| `v1:generateMockTick` | POST `/api/v1/mock/tick` | — | — | localSession | 201 |
| `v1:replayStatus` | GET `/api/v1/replay` | — | — | localSession | 200 |
| `v1:startReplay` | POST `/api/v1/replay` | — | ReplayInput | localSession | 202 |
| `v1:stopReplay` | DELETE `/api/v1/replay` | — | — | localSession | 200 |
| `v1:discoverGree` | POST `/api/v1/integrations/gree/discover` | — | inline schema | localSession + csrfToken | 200, 403, 404 |
| `v1:configureGree` | PUT `/api/v1/integrations/gree/config` | — | GreeConfigInput | localSession + csrfToken | 200, 403, 404, 409, 422 |
| `v1:discoverGreeCloud` | POST `/api/v1/integrations/gree/cloud/discover` | — | GreeCloudDiscoveryInput | localSession + csrfToken | 200, 403, 404, 422 |
| `v1:configureGreeCloud` | PUT `/api/v1/integrations/gree/cloud/config` | — | GreeCloudConfigInput | localSession + csrfToken | 200, 403, 404, 409, 422 |
| `v1:disconnectGree` | DELETE `/api/v1/integrations/gree/config/{connectionId}` | path:connectionId* | — | localSession + csrfToken | 200, 403, 404 |
| `v1:listHeatPumpStates` | GET `/api/v1/heat-pumps` | query:houseId? | — | localSession | 200, 404 |
| `v1:placeHeatPump` | PATCH `/api/v1/heat-pumps/{connectionId}/placement` | path:connectionId* | HeatPumpPlacementPatch | localSession + csrfToken | 200, 403, 404, 422 |
| `v1:getHeatPumpStateHistory` | GET `/api/v1/heat-pumps/{connectionId}/history` | path:connectionId*, query:from?, query:to?, query:limit? | — | localSession | 200, 404, 503 |
| `v1:discoverTuyaLanDevices` | POST `/api/v1/integrations/tuya/discover` | — | inline schema | localSession + csrfToken | 200, 403, 404 |
| `v1:configureTuyaLanDevice` | PUT `/api/v1/integrations/tuya/config` | — | TuyaConfigInput | localSession + csrfToken | 200, 400, 403, 404, 409, 422 |
| `v1:disconnectTuyaLanDevice` | DELETE `/api/v1/integrations/tuya/config/{connectionId}` | path:connectionId* | — | localSession + csrfToken | 200, 403, 404 |
| `v1:listConnectedDevices` | GET `/api/v1/connected-devices` | query:houseId? | — | localSession | 200, 404 |
| `v1:placeConnectedDevice` | PATCH `/api/v1/connected-devices/{connectionId}/placement` | path:connectionId* | ConnectedDevicePlacementPatch | localSession + csrfToken | 200, 403, 404, 422 |
| `v1:commandConnectedDevice` | POST `/api/v1/connected-devices/{connectionId}/commands` | path:connectionId* | ConnectedDeviceCommand | localSession + csrfToken | 200, 403, 404, 409, 422, 503 |
| `v1:getNexus433Status` | GET `/api/v1/integrations/nexus433/status` | query:houseId* | — | localSession | 200 |
| `v1:configureNexus433` | PUT `/api/v1/integrations/nexus433/config` | — | inline schema | localSession | 202, 409 |
| `v1:listNexus433Candidates` | GET `/api/v1/integrations/nexus433/candidates` | query:houseId* | — | localSession | 200 |
| `v1:listNexus433Bindings` | GET `/api/v1/integrations/nexus433/bindings` | query:houseId* | — | localSession | 200 |
| `v1:bindNexus433Candidate` | POST `/api/v1/integrations/nexus433/bindings` | — | inline schema | localSession | 201, 409 |
| `v1:reconnectNexus433Sensor` | POST `/api/v1/integrations/nexus433/bindings/{sensorId}/reconnect` | path:sensorId* | inline schema | localSession | 200, 409 |
| `v1:submitBugReport` | POST `/api/v1/bug-reports` | — | inline schema | localSession + csrfToken | 201, 400, 401, 403, 429, 502, 503 |
| `v1:getBugReportRelay` | GET `/api/v1/bug-reports/relay` | — | — | localSession | 200, 401, 403 |
| `v1:configureBugReportRelay` | PUT `/api/v1/bug-reports/relay` | — | inline schema | localSession + csrfToken | 200, 400, 401, 403, 409 |
| `v1:clearBugReportRelay` | DELETE `/api/v1/bug-reports/relay` | — | — | localSession + csrfToken | 200, 401, 403, 409 |
| `v2:openApiDocument` | GET `/api/v2/openapi.json` | — | — | public | 200 |
| `v2:listMeasurementDefinitions` | GET `/api/v2/measurement-definitions` | query:includeDisabled? | — | localSession | 200 |
| `v2:createMeasurementDefinition` | POST `/api/v2/measurement-definitions` | — | MeasurementDefinitionInput | localSession | 201, 409 |
| `v2:updateMeasurementDefinition` | PATCH `/api/v2/measurement-definitions/{id}` | path:id* | MeasurementDefinitionPatch | localSession | 200, 409 |
| `v2:disableMeasurementDefinition` | DELETE `/api/v2/measurement-definitions/{id}` | path:id* | — | localSession | 200 |
| `v2:queryAnalytics` | POST `/api/v2/analytics/query` | — | AnalyticsQueryRequest | localSession | 200, 400, 409, 422 |
| `v2:dailyAnalyticsFindings` | GET `/api/v2/analytics/findings` | query:houseId* | — | localSession | 200, 400, 404 |
| `v2:openingActivity` | POST `/api/v2/analytics/opening-activity` | — | OpeningActivityRequest | localSession | 200, 400, 404, 409, 503 |
| `v2:cachedThermalIsolation` | GET `/api/v2/analytics/thermal-isolation` | query:houseId*, query:dataMode*="live"/"demo", query:windowDays?=1/7/14 | — | localSession | 200, 400, 404, 409 |
| `v2:refreshCachedThermalIsolation` | POST `/api/v2/analytics/thermal-isolation` | query:houseId*, query:dataMode*="live"/"demo", query:windowDays?=1/7/14 | — | localSession | 202, 400, 403, 404, 409 |
| `v2:cachedMoistureResponse` | GET `/api/v2/analytics/moisture-response` | query:houseId*, query:dataMode*="live"/"demo", query:windowDays?=1/7/14 | — | localSession | 200, 400, 404, 409 |
| `v2:refreshCachedMoistureResponse` | POST `/api/v2/analytics/moisture-response` | query:houseId*, query:dataMode*="live"/"demo", query:windowDays?=1/7/14 | — | localSession | 202, 400, 403, 404, 409 |
| `v2:homePerformance` | GET `/api/v2/analytics/home-performance` | query:houseId*, query:dataMode*="live"/"demo" | — | localSession | 200, 400, 404, 409 |
| `v2:refreshHomePerformance` | POST `/api/v2/analytics/home-performance` | query:houseId*, query:dataMode*="live"/"demo" | — | localSession | 202, 400, 403, 404, 409 |
| `v2:analyticsCoverage` | POST `/api/v2/analytics/coverage` | — | AnalyticsCoverageRequest | localSession | 200, 400, 409, 422 |
| `v2:ingestMeasurements` | POST `/api/v2/measurements` | — | 4 oneOf shapes | ingestKey | 201, 422 |
| `v2:importHistoricalMeasurements` | POST `/api/v2/measurements/import` | — | inline schema | ingestKey | 201, 422 |
| `v2:measurementSnapshot` | GET `/api/v2/measurements/snapshot` | query:houseId? | — | localSession | 200 |
| `v2:measurementHistory` | GET `/api/v2/measurements/history` | query:sensorId*, query:metric*, query:from?, query:to?, query:limit?, query:cursor?, query:bucketSeconds? | — | localSession | 200 |
| `v2:outdoorTemperatureHistory` | GET `/api/v2/houses/{id}/outdoor-temperature/history` | path:id*, query:from?, query:to?, query:limit? | — | localSession | 200, 404 |
| `v2:sensorMeasurementPage` | GET `/api/v2/sensors/{id}/measurements` | path:id*, query:cursor?, query:limit? | — | localSession | 200, 400, 404 |
| `v2:streamMeasurements` | GET `/api/v2/measurements/events` | query:sensorId?, query:metric? | — | localSession | 200 |
| `v2:forecastMeasurement` | GET `/api/v2/measurements/forecast` | query:sensorId*, query:metric*, query:hours? | — | localSession | 200, 422 |
| `v2:compareCalendarPeriods` | POST `/api/v2/analytics/calendar-comparison` | — | CalendarComparisonRequest | localSession | 200, 400, 404, 409, 422, 503 |
| `v2:listHomeMonitoring` | GET `/api/v2/monitoring/houses` | query:dataMode*="live"/"demo" | — | localSession | 200, 400, 409 |
| `v2:getHomeMonitoring` | GET `/api/v2/monitoring/houses/{houseId}` | path:houseId*, query:dataMode*="live"/"demo", query:include? | — | localSession | 200, 400, 404, 409 |
| `relay:submitReport` | POST `/reports` | — | inline schema | relayBearer | 201, 400, 401, 404, 405, 413, 415, 429, 500, 502 |

## Regeneration and verification

Run from the repository root after installing its dependencies:

```sh
npm run build:packages
node --import tsx scripts/generate-api-endpoint-combinations.mjs
node --import tsx scripts/generate-api-endpoint-combinations.mjs --check
npm test -w @climate-twin/api -- tests/openapi-parity.test.ts
```

Generation imports the source OpenAPI documents and reads repository source files. It performs no HTTP requests and does not start the API, update an appliance or contact integrations. --check compares generated files with current contracts and workflow/profile definitions. The existing parity test checks the local contract against actual Express route registration. Add reviewed workflows when introducing new feature behavior; generated pairs/input cases do not establish domain oracles automatically.

For a test execution report, record case ID, operation/pair/workflow, synthetic fixture state, request variant, expected and actual status/body/state, and pass/fail/blocked/inapplicable. This document records a generated test catalogue; its execution status is **not run**.

Sources: [versioned OpenAPI](../../apps/api/src/openapi.ts), [route registration](../../apps/api/src/app/main.ts), [authorization middleware](../../apps/api/src/app/part-06.ts), [OpenAPI parity test](../../apps/api/tests/openapi-parity.test.ts), [optional relay](../../apps/bug-report-relay/src/index.ts), and [shared report validator](../../packages/contracts/src/bug-reports.ts). Exact source-document and supplemental-source hashes are in the JSON matrix.
