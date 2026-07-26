import XCTest
@testable import StugaCore

final class ModelDecodingTests: XCTestCase {
    func testDecodesCurrentSessionContractWithAdditiveFields() throws {
        let data = Data(#"""
        {
          "authenticated": true,
          "principal": { "type": "local", "email": "owner@example.test" },
          "tenant": { "id": "local", "name": "Local Stuga", "role": "owner" },
          "availableTenants": [{ "id": "local", "name": "Local Stuga", "role": "owner" }],
          "readOnly": false,
          "grants": [],
          "csrfToken": "csrf-token"
        }
        """#.utf8)

        let session = try JSONDecoder().decode(AppSession.self, from: data)
        XCTAssertTrue(session.authenticated)
        XCTAssertEqual(session.principal.email, "owner@example.test")
        XCTAssertEqual(session.csrfToken, "csrf-token")
    }

    func testDecodesRegistryDrivenMeasurementSnapshot() throws {
        let data = Data(#"""
        {
          "sensorId": "sensor-hall",
          "measurements": {
            "temperature": {
              "sensorId": "sensor-hall",
              "metric": "temperature",
              "value": 21.4,
              "canonicalUnit": "°C",
              "timestamp": "2027-01-15T08:00:00.000Z",
              "source": "tp-link",
              "quality": "good"
            },
            "co2": {
              "sensorId": "sensor-hall",
              "metric": "co2",
              "value": 722,
              "canonicalUnit": "ppm",
              "timestamp": "2027-01-15T08:00:00.000Z",
              "source": "api",
              "quality": "estimated"
            }
          }
        }
        """#.utf8)

        let snapshot = try JSONDecoder().decode(MeasurementSnapshotEntry.self, from: data)
        XCTAssertEqual(snapshot.measurements["temperature"]?.value, 21.4)
        XCTAssertEqual(snapshot.measurements["co2"]?.quality, "estimated")
    }

    func testDecodesSensorWithOptionalIntegrationBindingsOmitted() throws {
        let data = Data(#"""
        {
          "id": "sensor-hall",
          "houseId": "home-main",
          "floorId": "ground",
          "name": "Hall sensor",
          "room": "Hall",
          "model": "T315",
          "x": 4.0,
          "y": 3.0,
          "z": 1.2,
          "tags": [],
          "enabled": true
        }
        """#.utf8)

        let sensor = try JSONDecoder().decode(Sensor.self, from: data)
        XCTAssertEqual(sensor.room, "Hall")
        XCTAssertNil(sensor.measurementEntityIds)
        XCTAssertTrue(SensorCondition(sensor: sensor, measurements: [:]).monitorsEnvironmentalConditions)
    }

    func testDecodesPropertyInventorySnapshotUsedByTrackingJoin() throws {
        let data = Data(#"""
        {
          "propertyId": "property-main",
          "generatedAt": "2026-07-26T10:00:00.000Z",
          "syncToken": "inventory-token",
          "areas": [{
            "id": "area-shed",
            "propertyId": "property-main",
            "name": "Tool shed",
            "kind": "building",
            "description": null,
            "polygon": [],
            "createdAt": "2026-07-20T10:00:00.000Z",
            "updatedAt": "2026-07-20T10:00:00.000Z"
          }],
          "equipment": [{
            "id": "equipment-mower",
            "propertyId": "property-main",
            "areaId": "area-shed",
            "name": "Lawn mower",
            "kind": "mower",
            "manufacturer": "Stuga Test",
            "model": "M1",
            "serialNumber": "1234",
            "status": "active",
            "notes": null,
            "createdAt": "2026-07-20T10:00:00.000Z",
            "updatedAt": "2026-07-20T10:00:00.000Z"
          }]
        }
        """#.utf8)

        let inventory = try JSONDecoder().decode(PropertyInventorySnapshot.self, from: data)
        XCTAssertEqual(inventory.propertyId, "property-main")
        XCTAssertEqual(inventory.areas.first?.id, inventory.equipment.first?.areaId)
        XCTAssertEqual(inventory.equipment.first?.id, "equipment-mower")
    }

    func testInventoryUpdateEncodesNullsWhenOptionalFieldsAreCleared() throws {
        let input = AreaEquipmentUpdateInput(
            areaId: "area-shed",
            houseId: nil,
            location: nil,
            name: "Lawn mower",
            kind: "mower",
            manufacturer: nil,
            model: "M1",
            serialNumber: nil,
            status: .outOfService,
            notes: nil
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(input))
                as? [String: Any]
        )
        XCTAssertEqual(object["areaId"] as? String, "area-shed")
        XCTAssertEqual(object["status"] as? String, "out-of-service")
        XCTAssertTrue(object["houseId"] is NSNull)
        XCTAssertTrue(object["location"] is NSNull)
        XCTAssertTrue(object["manufacturer"] is NSNull)
        XCTAssertTrue(object["serialNumber"] is NSNull)
        XCTAssertTrue(object["notes"] is NSNull)

        let metadataOnly = AreaEquipmentUpdateInput(
            areaId: nil,
            houseId: "home-remote",
            location: nil,
            updatesPlacement: false,
            updatesLocation: false,
            name: "Lawn mower",
            kind: "mower",
            status: .active
        )
        let metadataObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(metadataOnly))
                as? [String: Any]
        )
        XCTAssertNil(metadataObject["areaId"])
        XCTAssertNil(metadataObject["houseId"])
        XCTAssertNil(metadataObject["location"])
    }

    func testInventoryCreateEncodesHomePlacementAndMapPin() throws {
        let input = AreaEquipmentCreateInput(
            propertyId: "property-main",
            houseId: "home-main",
            location: GeoCoordinate(latitude: 60.1699, longitude: 24.9384),
            name: "Toolbox",
            kind: "tools"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(input))
                as? [String: Any]
        )
        XCTAssertEqual(object["propertyId"] as? String, "property-main")
        XCTAssertNil(object["areaId"])
        XCTAssertEqual(object["houseId"] as? String, "home-main")
        let location = try XCTUnwrap(object["location"] as? [String: Any])
        XCTAssertEqual(location["latitude"] as? Double, 60.1699)
        XCTAssertEqual(location["longitude"] as? Double, 24.9384)
    }

    func testDecodesHomeAssignedAndUnassignedEquipmentPlacements() throws {
        let data = Data(#"""
        {
          "propertyId": "property-main",
          "generatedAt": "2026-07-26T10:00:00.000Z",
          "syncToken": "placement-token",
          "areas": [],
          "equipment": [{
            "id": "equipment-home",
            "propertyId": "property-main",
            "areaId": null,
            "houseId": "home-main",
            "location": { "latitude": 60.1699, "longitude": 24.9384 },
            "name": "Toolbox",
            "kind": "tools",
            "manufacturer": null,
            "model": null,
            "serialNumber": null,
            "status": "active",
            "notes": null,
            "createdAt": "2026-07-20T10:00:00.000Z",
            "updatedAt": "2026-07-26T10:00:00.000Z"
          }, {
            "id": "equipment-unassigned",
            "propertyId": "property-main",
            "areaId": null,
            "name": "Spare cable",
            "kind": "electrical",
            "manufacturer": null,
            "model": null,
            "serialNumber": null,
            "status": "active",
            "notes": null,
            "createdAt": "2026-07-20T10:00:00.000Z",
            "updatedAt": "2026-07-26T10:00:00.000Z"
          }]
        }
        """#.utf8)

        let inventory = try JSONDecoder().decode(PropertyInventorySnapshot.self, from: data)
        XCTAssertNil(inventory.equipment[0].areaId)
        XCTAssertEqual(inventory.equipment[0].houseId, "home-main")
        XCTAssertEqual(inventory.equipment[0].location?.latitude, 60.1699)
        XCTAssertNil(inventory.equipment[1].areaId)
        XCTAssertNil(inventory.equipment[1].houseId)
        XCTAssertNil(inventory.equipment[1].location)
    }

    func testDecodesStugbyHomeAndPropertyOwnership() throws {
        let homeData = Data(#"""
        {
          "id": "home-shared",
          "propertyId": "property-shared",
          "name": "Lake cabin",
          "timezone": "Europe/Helsinki",
          "location": {
            "latitude": 60.1699,
            "longitude": 24.9384,
            "label": "Shore road",
            "source": "manual",
            "userOverridden": true
          },
          "mapPlacement": {
            "latitude": 60.17,
            "longitude": 24.94,
            "metersPerPlanUnit": 0.1,
            "footprintFloorId": "floor-main"
          },
          "floors": [],
          "stugby": {
            "stugbyId": "stugby-main",
            "authorityNodeId": "remote-node",
            "publicationId": "publication-home",
            "ownership": "shared",
            "editPolicy": "read-only",
            "syncState": "current",
            "authorityEpoch": 2,
            "pendingChangeCount": 0,
            "conflictCount": 0,
            "recoveryState": "not-enabled"
          },
          "createdAt": "2026-07-20T10:00:00.000Z",
          "updatedAt": "2026-07-26T10:00:00.000Z"
        }
        """#.utf8)
        let propertyData = Data(#"""
        {
          "id": "property-shared",
          "name": "Shared shore",
          "description": null,
          "stugby": {
            "stugbyId": "stugby-main",
            "authorityNodeId": "remote-node",
            "isAuthority": false,
            "editPolicy": "read-only",
            "syncState": "current",
            "authorityEpoch": 2,
            "lastSyncedRevision": 4,
            "pendingChangeCount": 0,
            "conflictCount": 0
          },
          "createdAt": "2026-07-20T10:00:00.000Z",
          "updatedAt": "2026-07-26T10:00:00.000Z"
        }
        """#.utf8)

        let home = try JSONDecoder().decode(House.self, from: homeData)
        let property = try JSONDecoder().decode(StugaProperty.self, from: propertyData)

        XCTAssertTrue(home.stugby?.isForeignSharedHome == true)
        XCTAssertTrue(home.stugby?.isReadOnly == true)
        XCTAssertEqual(home.location?.label, "Shore road")
        XCTAssertEqual(home.mapPlacement?.footprintFloorId, "floor-main")
        XCTAssertTrue(property.stugby?.isForeignSharedProperty == true)
        XCTAssertTrue(property.stugby?.isReadOnly == true)
    }

    func testDecodesDurableSystemUpdateProgress() throws {
        let data = Data(#"""
        {
          "currentVersion": "0.13.0",
          "latestVersion": "0.14.0",
          "updateAvailable": true,
          "latestRelease": null,
          "releases": [],
          "lastCheckedAt": "2026-07-26T10:00:00.000Z",
          "checkError": null,
          "settings": {
            "mode": "manual",
            "includePrereleases": false,
            "checkIntervalHours": 24,
            "updateTime": "03:00",
            "updateDays": ["sun"],
            "timezone": "Europe/Helsinki"
          },
          "nextUpdateWindowAt": null,
          "capability": {
            "available": true,
            "runtime": "docker",
            "agentLastSeenAt": "2026-07-26T10:00:05.000Z",
            "reason": "ready"
          },
          "operation": {
            "id": "update-1",
            "version": "0.14.0",
            "tagName": "v0.14.0",
            "phase": "applying",
            "requestedAt": "2026-07-26T10:00:00.000Z",
            "startedAt": "2026-07-26T10:00:01.000Z",
            "completedAt": null,
            "updatedAt": "2026-07-26T10:00:04.000Z",
            "phaseStartedAt": "2026-07-26T10:00:04.000Z",
            "detail": "Replacing application services",
            "previousVersion": "0.13.0",
            "activity": [
              {
                "phase": "preparing",
                "at": "2026-07-26T10:00:01.000Z",
                "detail": "Preparing update"
              },
              {
                "phase": "backup",
                "at": "2026-07-26T10:00:02.000Z",
                "detail": "Backup complete"
              },
              {
                "phase": "pulling",
                "at": "2026-07-26T10:00:03.000Z",
                "detail": "Images downloaded"
              },
              {
                "phase": "applying",
                "at": "2026-07-26T10:00:04.000Z",
                "detail": "Replacing application services"
              }
            ]
          }
        }
        """#.utf8)

        let status = try JSONDecoder().decode(SystemUpdateStatus.self, from: data)

        XCTAssertEqual(status.operation?.phase, "applying")
        XCTAssertEqual(status.operation?.activity.count, 4)
        XCTAssertEqual(status.operation?.completedProgressSteps, 3)
        XCTAssertTrue(status.operation?.isActive == true)
    }

    func testDecodesLiveSystemUpdateEvent() throws {
        let data = Data(#"""
        {
          "currentVersion": "0.13.0",
          "latestVersion": "0.14.0",
          "updateAvailable": true,
          "capability": {
            "available": true,
            "runtime": "docker",
            "agentLastSeenAt": "2026-07-26T10:00:00.000Z",
            "reason": "ready"
          },
          "operation": null
        }
        """#.utf8)

        let event = try JSONDecoder().decode(SystemUpdateEvent.self, from: data)

        XCTAssertEqual(event.latestVersion, "0.14.0")
        XCTAssertTrue(event.updateAvailable)
        XCTAssertEqual(event.capability.runtime, "docker")
        XCTAssertNil(event.operation)
    }

    func testNormalizesLegacySystemUpdateOperationForCompatibility() throws {
        let data = Data(#"""
        {
          "id": "update-legacy",
          "version": "0.13.0",
          "tagName": "v0.13.0",
          "phase": "backup",
          "requestedAt": "2026-07-26T10:00:00.000Z",
          "startedAt": "2026-07-26T10:00:01.000Z",
          "completedAt": null,
          "detail": "Creating backup",
          "previousVersion": "0.12.0"
        }
        """#.utf8)

        let operation = try JSONDecoder().decode(SystemUpdateOperation.self, from: data)

        XCTAssertEqual(operation.updatedAt, "2026-07-26T10:00:01.000Z")
        XCTAssertEqual(operation.phaseStartedAt, "2026-07-26T10:00:01.000Z")
        XCTAssertEqual(operation.activity.first?.detail, "Creating backup")
    }
}
