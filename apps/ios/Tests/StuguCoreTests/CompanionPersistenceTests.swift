import Foundation
import XCTest
@testable import StuguCore

final class CompanionPersistenceTests: XCTestCase {
    func testPendingActionsRequireExactlyTheirOwnPayload() {
        let valid = PendingCompanionAction(
            kind: .acknowledgeAlert,
            createdAt: "2027-01-15T08:00:00Z",
            alertId: "alert-1"
        )
        let invalid = PendingCompanionAction(
            kind: .acknowledgeAlert,
            createdAt: "2027-01-15T08:00:00Z",
            alertId: "alert-1",
            observation: observation()
        )
        XCTAssertTrue(valid.isWellFormed)
        XCTAssertFalse(invalid.isWellFormed)
    }

    func testCacheStoreRejectsAnotherServerAndBoundsHistory() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CompanionCacheStore(
            fileURL: directory.appendingPathComponent("cache.json")
        )
        let samples = (0..<700).map { index in
            MeasurementSample(
                sensorId: "sensor-1",
                metric: "temperature",
                value: Double(index),
                canonicalUnit: "°C",
                timestamp: "2027-01-15T08:00:00Z",
                source: "mock",
                quality: "good"
            )
        }
        let cache = fixtureCache(history: [
            CompanionHistorySeries(
                houseId: "home-1",
                sensorId: "sensor-1",
                metric: "temperature",
                hours: 24,
                samples: samples
            ),
        ])
        try await store.save(cache)
        let restored = try await store.load(serverOrigin: "https://stugu.example")
        XCTAssertEqual(restored?.history.first?.samples.count, 672)
        do {
            _ = try await store.load(serverOrigin: "https://other.example")
            XCTFail("Expected a server mismatch")
        } catch CompanionCacheStore.StoreError.serverMismatch {
            // Expected.
        }
        try await store.remove()
    }

    func testWidgetSnapshotRoundTripsThroughAnInjectedStore() throws {
        let suite = "stugu-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CompanionWidgetSnapshotStore(defaults: defaults)
        let snapshot = CompanionWidgetSnapshot(
            homeId: "home-1",
            homeName: "Forest cottage",
            state: "balanced",
            title: "Home is in balance",
            detail: "3 sensors reporting live",
            activeAlertCount: 0,
            updatedAt: "2027-01-15T08:00:00Z"
        )
        store.save(snapshot)
        XCTAssertEqual(store.load(), snapshot)
        store.remove()
        XCTAssertNil(store.load())
    }

    func testDeepLinksAreStrictlyScoped() throws {
        XCTAssertEqual(
            CompanionDeepLink.parse(try XCTUnwrap(URL(string: "stugu://alerts?id=alert-1"))),
            .alerts(alertId: "alert-1")
        )
        XCTAssertEqual(
            CompanionDeepLink.parse(try XCTUnwrap(URL(string: "stugu://room-scan"))),
            .roomScan
        )
        XCTAssertNil(CompanionDeepLink.parse(
            try XCTUnwrap(URL(string: "https://example.com/alerts"))
        ))
        XCTAssertNil(CompanionDeepLink.parse(
            try XCTUnwrap(URL(string: "stugu://capture?unexpected=true"))
        ))
        XCTAssertNil(CompanionDeepLink.parse(
            try XCTUnwrap(URL(string: "stugu://alerts?id=alert-1&id=alert-2"))
        ))
        XCTAssertNil(CompanionDeepLink.parse(
            try XCTUnwrap(URL(string: "stugu://room-scan?floor=ground"))
        ))
    }

    private func observation() -> QuickObservationInput {
        QuickObservationInput(
            houseId: "home-1",
            floorId: "ground",
            kind: "note",
            severity: "info",
            note: "Draft near the window",
            occurredAt: "2027-01-15T08:00:00Z"
        )
    }

    private func fixtureCache(history: [CompanionHistorySeries]) -> CompanionCache {
        CompanionCache(
            serverOrigin: "https://stugu.example",
            savedAt: "2027-01-15T08:00:00Z",
            session: AppSession(
                authenticated: true,
                principal: .init(type: "local", email: "owner@stugu"),
                tenant: .init(id: "local", name: "Stugu", role: "owner"),
                readOnly: false,
                csrfToken: nil,
                setupRequired: false
            ),
            properties: [],
            houses: [],
            sensors: [],
            definitions: [],
            measurementSnapshot: [],
            alerts: [],
            rules: [],
            propertyInventory: nil,
            selectedHomeId: nil,
            selectedPropertyId: nil,
            history: history,
            todayContext: nil,
            pendingActions: []
        )
    }
}
