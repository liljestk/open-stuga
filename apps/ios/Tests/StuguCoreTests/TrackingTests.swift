import Foundation
import XCTest
@testable import StuguCore

final class TrackingTests: XCTestCase {
    func testDeclarativeProfileResolvesOnlyClaimedEndpoint() throws {
        let profile = try JSONDecoder().decode(TrackingProfile.self, from: Data(#"""
        {
          "schemaVersion":"2026-07-01",
          "id":"org.bluetooth.ibeacon",
          "version":"2026.07",
          "displayName":"iBeacon",
          "description":"Test profile",
          "serviceUuids":[],
          "match":[{"source":"manufacturerData","key":"004c","offset":0,"value":"0215"}],
          "fields":[
            {"name":"proximityUuid","source":"manufacturerData","key":"004c","offset":2,"length":16,"encoding":"uuid"},
            {"name":"major","source":"manufacturerData","key":"004c","offset":18,"length":2,"encoding":"uint16be"},
            {"name":"minor","source":"manufacturerData","key":"004c","offset":20,"length":2,"encoding":"uint16be"},
            {"name":"txPower","source":"manufacturerData","key":"004c","offset":22,"length":1,"encoding":"int8"}
          ],
          "identity":{
            "namespace":"org.bluetooth.ibeacon","namespaceVersion":1,
            "scope":"GLOBAL","strength":"STATIC_CLEAR",
            "fields":["proximityUuid","major","minor"],"separator":":"
          },
          "capabilities":{
            "trackabilityTier":"PROPERTY_BEACON","discoverability":"FOREGROUND",
            "backgroundSupport":"FOREGROUND_ONLY","mapCapability":"ZONE",
            "connectable":false,"reportsBattery":false,
            "reportsMotion":false,"reportsCounter":false
          },
          "platformSupport":[{"platform":"ios","scanContexts":["foreground","foreground-find"],"notes":[]}],
          "maximumFrameBytes":31,
          "deprecatedAt":null
        }
        """#.utf8))
        let payload = Data([
            0x02, 0x15,
            0x7f, 0x7e, 0x4b, 0x10, 0x2f, 0x5f, 0x4f, 0xc9,
            0xa6, 0x6a, 0x06, 0xdb, 0x0f, 0xa0, 0x42, 0xf8,
            0x00, 0x01, 0x00, 0x07, 0xc5,
        ])
        let frame = TrackingLocalAdvertisementFrame(
            serviceUuids: [],
            manufacturerData: ["004c": payload],
            serviceData: [:],
            localName: nil,
            peripheralIdentifier: "observer-local-id",
            connectable: false,
            rssi: -63,
            observedAt: "2026-07-27T08:00:00.000Z"
        )
        let entry = TrackingResolutionEntry(
            equipmentId: "equipment-main",
            endpointId: "endpoint-main",
            profileId: profile.id,
            profileVersion: profile.version,
            identityFields: [
                "proximityUuid": "7f7e4b10-2f5f-4fc9-a66a-06db0fa042f8",
                "major": "1",
                "minor": "7",
            ]
        )

        let resolved = TrackingAdvertisementParser.resolve(
            frame,
            profiles: [profile],
            entries: [entry]
        )
        XCTAssertEqual(resolved?.resolution.endpointId, "endpoint-main")
        XCTAssertEqual(resolved?.match.identityFields, entry.identityFields)
        XCTAssertEqual(resolved?.match.telemetry["txPower"], .number(-59))
        XCTAssertNil(TrackingAdvertisementParser.resolve(
            frame,
            profiles: [profile],
            entries: []
        ))
    }

    func testSignalSmoothingUsesWordsRatherThanDistance() {
        var smoother = TrackingSignalSmoother()
        let start = Date(timeIntervalSince1970: 100)
        _ = smoother.add(rssi: -82, at: start)
        _ = smoother.add(rssi: -74, at: start.addingTimeInterval(1))
        _ = smoother.add(rssi: -64, at: start.addingTimeInterval(2))
        let reading = smoother.add(rssi: -52, at: start.addingTimeInterval(3))

        XCTAssertGreaterThan(reading.smoothedRSSI, -82)
        XCTAssertEqual(reading.trend, .gettingCloser)
        XCTAssertTrue([TrackingProximityBand.nearby, .close].contains(reading.band))
    }

    func testObservationQueuePersistsAndAcknowledgesIdempotently() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("queue.json")
        let observation = fixtureObservation(id: "observation-1")

        let first = TrackingObservationQueue(storageURL: url, maximumCount: 100)
        _ = try await first.enqueue(observation)
        _ = try await first.enqueue(observation)
        let firstStatus = await first.status
        XCTAssertEqual(firstStatus.queuedCount, 1)

        let restored = TrackingObservationQueue(storageURL: url, maximumCount: 100)
        let restoredBatch = try await restored.nextBatch(
            limit: 100,
            referenceDate: Date(timeIntervalSince1970: 1_775_000_000)
        )
        XCTAssertEqual(restoredBatch, [observation])
        _ = try await restored.acknowledge(observationIDs: [observation.id])
        let finalStatus = await restored.status
        XCTAssertEqual(finalStatus.queuedCount, 0)
    }

    func testObservationQueueExpiresOldEvidence() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString,
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = TrackingObservationQueue(
            storageURL: directory.appendingPathComponent("queue.json"),
            maximumCount: 100,
            maximumAge: 60
        )
        _ = try await queue.enqueue(fixtureObservation(id: "expired"))

        let batch = try await queue.nextBatch(
            limit: 100,
            referenceDate: Date(timeIntervalSince1970: 1_800_000_000)
        )

        XCTAssertTrue(batch.isEmpty)
        let status = await queue.status
        XCTAssertEqual(status.queuedCount, 0)
    }

    func testDecodesUncertaintyAwareTrackingSnapshot() throws {
        let data = Data(#"""
        {
          "propertyId":"property-main",
          "dataMode":"demo",
          "generatedAt":"2026-07-25T19:14:25.000Z",
          "sequence":12,
          "settings":{
            "propertyId":"property-main","enabled":true,"propertyBoundary":[],
            "liveNearbySeconds":10,"recentlySeenSeconds":120,"staleSeconds":1800,
            "unknownSeconds":604800,"movementThresholdMeters":8,
            "movementMaximumIntervalSeconds":120,"minimumMovementConfidence":0.55,
            "exitAlertDebounceSeconds":120,"observationRetentionDays":30,
            "rollupRetentionDays":180,"estimateRetentionDays":365,
            "updatedAt":"2026-07-25T19:00:00.000Z"
          },
          "zones":[],
          "gateways":[],
          "equipment":[],
          "members":[]
        }
        """#.utf8)

        let snapshot = try JSONDecoder().decode(TrackingMapSnapshot.self, from: data)
        XCTAssertEqual(snapshot.propertyId, "property-main")
        XCTAssertEqual(snapshot.dataMode, "demo")
        XCTAssertEqual(snapshot.settings.liveNearbySeconds, 10)
        XCTAssertTrue(snapshot.equipment.isEmpty)
    }

    func testEquipmentQRCodeRoundTripsAndRejectsAmbiguousValues() {
        let code = EquipmentQRCode(
            propertyId: "property-main",
            equipmentId: "equipment/chainsaw #1"
        )
        XCTAssertEqual(EquipmentQRCode.parse(code.payload), code)
        XCTAssertNil(EquipmentQRCode.parse("https://example.com/equipment/123"))
        XCTAssertNil(EquipmentQRCode.parse(
            "stugu://equipment?property=one&property=two&id=item&v=1"
        ))
        XCTAssertNil(EquipmentQRCode.parse("stugu://equipment?property=one&id=item&v=2"))
    }

    func testDecodesEquipmentLoanAndCurrentMemberLocation() throws {
        let loan = try JSONDecoder().decode(EquipmentLoan.self, from: Data(#"""
        {
          "id":"loan-1",
          "propertyId":"property-main",
          "equipmentId":"equipment-mower",
          "borrowerLabel":"Member",
          "borrowedAt":"2026-07-26T08:00:00.000Z",
          "expectedReturnAt":"2026-07-27T08:00:00.000Z",
          "note":"North field",
          "returnedAt":null,
          "returnedByLabel":null,
          "returnNote":null
        }
        """#.utf8))
        XCTAssertTrue(loan.isActive)

        let location = try JSONDecoder().decode(
            PropertyMemberLocation.self,
            from: Data(#"""
            {
              "id":"member-location-1",
              "propertyId":"property-main",
              "memberLabel":"Member",
              "coordinate":{"latitude":60.17015,"longitude":24.93018},
              "horizontalAccuracyMeters":18,
              "reducedAccuracy":true,
              "capturedAt":"2026-07-26T08:00:00.000Z",
              "updatedAt":"2026-07-26T08:00:01.000Z",
              "sharingUntil":"2026-07-26T09:00:00.000Z"
            }
            """#.utf8)
        )
        XCTAssertEqual(location.horizontalAccuracyMeters, 18)
        XCTAssertTrue(location.reducedAccuracy)
    }

    private func fixtureObservation(id: String) -> TrackingObservationInput {
        TrackingObservationInput(
            dataMode: "demo",
            observationId: id,
            propertyId: "property-main",
            endpointId: "endpoint-main",
            equipmentId: "equipment-main",
            observerId: "observer-ios",
            observedAt: "2026-07-25T19:14:22.341Z",
            profileId: "org.bluetooth.ibeacon",
            profileVersion: "2026.07",
            rssi: -67,
            txPower: -59,
            observerPosition: TrackingObserverPosition(
                latitude: 60.17,
                longitude: 24.93,
                horizontalAccuracyMeters: 15,
                source: "gps",
                capturedAt: "2026-07-25T19:14:22.000Z"
            ),
            scanContext: "background",
            telemetry: ["platform": .string("IOS")]
        )
    }
}
