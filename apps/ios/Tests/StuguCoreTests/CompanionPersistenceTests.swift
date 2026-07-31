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

    func testVersionOneCacheMigratesWithoutDroppingPendingWork() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileURL = directory.appendingPathComponent("cache.json")
        let store = CompanionCacheStore(fileURL: fileURL)
        let pending = PendingCompanionAction(
            kind: .createObservation,
            createdAt: "2027-01-15T08:00:00Z",
            observation: observation()
        )
        let encoded = try JSONEncoder().encode(
            fixtureCache(history: [], pendingActions: [pending])
        )
        var legacy = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        legacy["schemaVersion"] = 1
        legacy.removeValue(forKey: "tpLinkDevices")
        legacy.removeValue(forKey: "latestOpeningStateObservation")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        try JSONSerialization.data(withJSONObject: legacy).write(to: fileURL)

        let restored = try await store.load(serverOrigin: "https://stugu.example")
        XCTAssertEqual(restored?.schemaVersion, CompanionCache.currentSchemaVersion)
        XCTAssertEqual(restored?.pendingActions, [pending])

        let migratedData = try Data(contentsOf: fileURL)
        let migrated = try XCTUnwrap(
            JSONSerialization.jsonObject(with: migratedData) as? [String: Any]
        )
        XCTAssertEqual(
            migrated["schemaVersion"] as? Int,
            CompanionCache.currentSchemaVersion
        )
        try await store.remove()
    }

    func testSaveDoesNotOverwriteANewerUnknownCache() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileURL = directory.appendingPathComponent("cache.json")
        let store = CompanionCacheStore(fileURL: fileURL)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let futureData = Data(#"{"schemaVersion":999,"pendingActions":[{"id":"future"}]}"#.utf8)
        try futureData.write(to: fileURL)

        do {
            try await store.save(fixtureCache(history: []))
            XCTFail("Expected an unsupported-schema error")
        } catch CompanionCacheStore.StoreError.unsupportedSchema(let version) {
            XCTAssertEqual(version, 999)
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), futureData)
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

    func testVersionOneWidgetSnapshotMigratesInPlace() throws {
        let suite = "stugu-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacy: [String: Any] = [
            "homeId": "home-1",
            "homeName": "Forest cottage",
            "state": "attention",
            "title": "Check the utility room",
            "detail": "One alert needs attention",
            "updatedAt": "2027-01-15T08:00:00Z",
        ]
        defaults.set(
            try JSONSerialization.data(withJSONObject: legacy),
            forKey: CompanionWidgetSnapshot.storageKey
        )
        let store = CompanionWidgetSnapshotStore(defaults: defaults)

        let restored = try XCTUnwrap(store.load())
        XCTAssertEqual(restored.schemaVersion, CompanionWidgetSnapshot.currentSchemaVersion)
        XCTAssertEqual(restored.activeAlertCount, 0)
        let migratedData = try XCTUnwrap(
            defaults.data(forKey: CompanionWidgetSnapshot.storageKey)
        )
        let migrated = try XCTUnwrap(
            JSONSerialization.jsonObject(with: migratedData) as? [String: Any]
        )
        XCTAssertEqual(
            migrated["schemaVersion"] as? Int,
            CompanionWidgetSnapshot.currentSchemaVersion
        )
    }

    func testWidgetSaveDoesNotOverwriteANewerUnknownSnapshot() throws {
        let suite = "stugu-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let futureData = Data(#"{"schemaVersion":999,"homeId":"future"}"#.utf8)
        defaults.set(futureData, forKey: CompanionWidgetSnapshot.storageKey)
        let store = CompanionWidgetSnapshotStore(defaults: defaults)

        store.save(CompanionWidgetSnapshot(
            homeId: "home-1",
            homeName: "Forest cottage",
            homeOrigin: nil,
            state: "good",
            title: "All clear",
            detail: "No active alerts",
            activeAlertCount: 0,
            updatedAt: "2027-01-15T08:00:00Z"
        ))

        XCTAssertEqual(
            defaults.data(forKey: CompanionWidgetSnapshot.storageKey),
            futureData
        )
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

    private func fixtureCache(
        history: [CompanionHistorySeries],
        pendingActions: [PendingCompanionAction] = []
    ) -> CompanionCache {
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
            pendingActions: pendingActions
        )
    }
}
