import Foundation
import XCTest
@testable import StuguCore

final class TrackingTests: XCTestCase {
    func testParsesCompactTrackingAdvertisement() throws {
        let bytes: [UInt8] = [
            0b0100_0011,
            1, 2, 3, 4, 5, 6, 7, 8,
            0x12, 0x34,
            0x01, 0x02,
            72,
            9, 10, 11, 12,
        ]
        let parsed = try TrackingAdvertisementParser.parse(Data(bytes))

        XCTAssertEqual(parsed.protocolVersion, 1)
        XCTAssertEqual(parsed.flags, 3)
        XCTAssertEqual(parsed.epochCounter, 0x1234)
        XCTAssertEqual(parsed.eventCounter, 0x0102)
        XCTAssertEqual(parsed.batteryPercent, 72)
        XCTAssertTrue(parsed.isMoving)
        XCTAssertTrue(parsed.isLowBattery)
        XCTAssertEqual(Data(base64Encoded: parsed.rawPayload.base64URLToStandard())?.count, 18)
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
          "generatedAt":"2026-07-25T19:14:25.000Z",
          "sequence":12,
          "settings":{
            "propertyId":"property-main","enabled":true,"propertyBoundary":[],
            "liveNearbySeconds":10,"recentlySeenSeconds":120,"staleSeconds":1800,
            "unknownSeconds":604800,"movementThresholdMeters":8,
            "movementMaximumIntervalSeconds":120,"minimumMovementConfidence":0.55,
            "exitAlertDebounceSeconds":120,"updatedAt":"2026-07-25T19:00:00.000Z"
          },
          "zones":[],
          "gateways":[],
          "assets":[],
          "members":[]
        }
        """#.utf8)

        let snapshot = try JSONDecoder().decode(TrackingMapSnapshot.self, from: data)
        XCTAssertEqual(snapshot.propertyId, "property-main")
        XCTAssertEqual(snapshot.settings.liveNearbySeconds, 10)
        XCTAssertTrue(snapshot.assets.isEmpty)
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
            observationId: id,
            propertyId: "property-main",
            observerId: "observer-ios",
            observedAt: "2026-07-25T19:14:22.341Z",
            rotatingTagId: "AQIDBAUGBwg",
            authenticator: "CQoLDA",
            protocolVersion: 1,
            advertisementFlags: 1,
            epochCounter: 1,
            eventCounter: 2,
            rssi: -67,
            motion: true,
            batteryPercent: 72,
            scanMode: "property",
            appState: "background",
            rawPayload: "QwECAwQFBgcIAAEAAkgJCgsM"
        )
    }
}

private extension String {
    func base64URLToStandard() -> String {
        var value = replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        return value
    }
}
