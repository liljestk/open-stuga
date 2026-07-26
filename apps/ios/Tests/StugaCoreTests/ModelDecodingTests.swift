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
        XCTAssertTrue(object["manufacturer"] is NSNull)
        XCTAssertTrue(object["serialNumber"] is NSNull)
        XCTAssertTrue(object["notes"] is NSNull)
    }
}
