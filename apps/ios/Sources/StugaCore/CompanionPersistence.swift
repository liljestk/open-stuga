import Foundation
#if os(iOS) && canImport(WidgetKit)
import WidgetKit
#endif

public struct CompanionHistorySeries: Codable, Equatable, Identifiable, Sendable {
    public let houseId: String
    public let sensorId: String
    public let metric: String
    public let hours: Int
    public let samples: [MeasurementSample]

    public var id: String {
        [houseId, sensorId, metric, String(hours)].joined(separator: "\u{1f}")
    }

    public init(
        houseId: String,
        sensorId: String,
        metric: String,
        hours: Int,
        samples: [MeasurementSample]
    ) {
        self.houseId = houseId
        self.sensorId = sensorId
        self.metric = metric
        self.hours = hours
        self.samples = samples
    }
}

public struct QuickObservationInput: Codable, Equatable, Sendable {
    public let id: String
    public let houseId: String
    public let floorId: String
    public let sensorId: String?
    public let kind: String
    public let severity: String
    public let note: String
    public let occurredAt: String
    public let timePrecision: String
    public let source: String
    public let confidence: String

    public init(
        id: String = UUID().uuidString.lowercased(),
        houseId: String,
        floorId: String,
        sensorId: String? = nil,
        kind: String,
        severity: String,
        note: String,
        occurredAt: String,
        timePrecision: String = "exact",
        source: String = "owner",
        confidence: String = "confirmed"
    ) {
        self.id = id
        self.houseId = houseId
        self.floorId = floorId
        self.sensorId = sensorId
        self.kind = kind
        self.severity = severity
        self.note = note
        self.occurredAt = occurredAt
        self.timePrecision = timePrecision
        self.source = source
        self.confidence = confidence
    }
}

public struct QuickMaintenanceInput: Codable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let houseId: String?
    public let floorId: String?
    public let areaId: String?
    public let equipmentId: String?
    public let title: String
    public let description: String?
    public let basis: String
    public let basisDetail: String?
    public let priority: String
    public let plannedFor: String?
    public let dueBy: String?
    public let observationIds: [String]

    public init(
        id: String = UUID().uuidString.lowercased(),
        propertyId: String,
        houseId: String?,
        floorId: String? = nil,
        areaId: String? = nil,
        equipmentId: String? = nil,
        title: String,
        description: String?,
        basis: String = "condition-based",
        basisDetail: String? = "Captured in the Stuga companion",
        priority: String = "normal",
        plannedFor: String? = nil,
        dueBy: String? = nil,
        observationIds: [String] = []
    ) {
        self.id = id
        self.propertyId = propertyId
        self.houseId = houseId
        self.floorId = floorId
        self.areaId = areaId
        self.equipmentId = equipmentId
        self.title = title
        self.description = description
        self.basis = basis
        self.basisDetail = basisDetail
        self.priority = priority
        self.plannedFor = plannedFor
        self.dueBy = dueBy
        self.observationIds = observationIds
    }
}

public struct PendingCompanionAction: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case acknowledgeAlert
        case createObservation
        case createMaintenance
    }

    public let id: String
    public let kind: Kind
    public let createdAt: String
    public let alertId: String?
    public let observation: QuickObservationInput?
    public let maintenance: QuickMaintenanceInput?
    public let attempts: Int
    public let lastError: String?

    public init(
        id: String = UUID().uuidString.lowercased(),
        kind: Kind,
        createdAt: String,
        alertId: String? = nil,
        observation: QuickObservationInput? = nil,
        maintenance: QuickMaintenanceInput? = nil,
        attempts: Int = 0,
        lastError: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.alertId = alertId
        self.observation = observation
        self.maintenance = maintenance
        self.attempts = attempts
        self.lastError = lastError
    }

    public func recordingFailure(_ message: String) -> PendingCompanionAction {
        PendingCompanionAction(
            id: id,
            kind: kind,
            createdAt: createdAt,
            alertId: alertId,
            observation: observation,
            maintenance: maintenance,
            attempts: attempts + 1,
            lastError: String(message.prefix(500))
        )
    }

    public var isWellFormed: Bool {
        switch kind {
        case .acknowledgeAlert:
            return alertId?.isEmpty == false && observation == nil && maintenance == nil
        case .createObservation:
            return alertId == nil && observation != nil && maintenance == nil
        case .createMaintenance:
            return alertId == nil && observation == nil && maintenance != nil
        }
    }
}

public struct CompanionCache: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let serverOrigin: String
    public let savedAt: String
    public let session: AppSession
    public let properties: [StugaProperty]
    public let houses: [House]
    public let sensors: [Sensor]
    public let definitions: [MeasurementDefinition]
    public let measurementSnapshot: [MeasurementSnapshotEntry]
    public let alerts: [AlertEvent]
    public let rules: [AlertRule]
    public let propertyInventory: PropertyInventorySnapshot?
    public let selectedHomeId: String?
    public let selectedPropertyId: String?
    public let history: [CompanionHistorySeries]
    public let todayContext: TodayContext?
    public let pendingActions: [PendingCompanionAction]

    public init(
        serverOrigin: String,
        savedAt: String,
        session: AppSession,
        properties: [StugaProperty],
        houses: [House],
        sensors: [Sensor],
        definitions: [MeasurementDefinition],
        measurementSnapshot: [MeasurementSnapshotEntry],
        alerts: [AlertEvent],
        rules: [AlertRule],
        propertyInventory: PropertyInventorySnapshot?,
        selectedHomeId: String?,
        selectedPropertyId: String?,
        history: [CompanionHistorySeries],
        todayContext: TodayContext?,
        pendingActions: [PendingCompanionAction]
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.serverOrigin = serverOrigin
        self.savedAt = savedAt
        self.session = session
        self.properties = properties
        self.houses = houses
        self.sensors = sensors
        self.definitions = definitions
        self.measurementSnapshot = measurementSnapshot
        self.alerts = alerts
        self.rules = rules
        self.propertyInventory = propertyInventory
        self.selectedHomeId = selectedHomeId
        self.selectedPropertyId = selectedPropertyId
        self.history = history
        self.todayContext = todayContext
        self.pendingActions = pendingActions
    }

    public func bounded(
        maximumHistorySeries: Int = 24,
        maximumSamplesPerSeries: Int = 672,
        maximumPendingActions: Int = 100
    ) -> CompanionCache {
        let boundedHistory = history.suffix(maximumHistorySeries).map { series in
            CompanionHistorySeries(
                houseId: series.houseId,
                sensorId: series.sensorId,
                metric: series.metric,
                hours: series.hours,
                samples: Array(series.samples.suffix(maximumSamplesPerSeries))
            )
        }
        return CompanionCache(
            serverOrigin: serverOrigin,
            savedAt: savedAt,
            session: session,
            properties: properties,
            houses: houses,
            sensors: sensors,
            definitions: definitions,
            measurementSnapshot: measurementSnapshot,
            alerts: alerts,
            rules: rules,
            propertyInventory: propertyInventory,
            selectedHomeId: selectedHomeId,
            selectedPropertyId: selectedPropertyId,
            history: boundedHistory,
            todayContext: todayContext,
            pendingActions: Array(pendingActions.filter(\.isWellFormed).suffix(maximumPendingActions))
        )
    }
}

public actor CompanionCacheStore {
    public enum StoreError: Error {
        case cacheTooLarge
        case unsupportedSchema
        case serverMismatch
    }

    private static let maximumEncodedBytes = 16 * 1_024 * 1_024

    public let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL) {
        self.fileURL = fileURL
        encoder = JSONEncoder()
        decoder = JSONDecoder()
    }

    public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return base
            .appendingPathComponent("Stuga", isDirectory: true)
            .appendingPathComponent("companion-cache-v1.json", isDirectory: false)
    }

    public func load(serverOrigin: String) throws -> CompanionCache? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let cache = try decoder.decode(CompanionCache.self, from: Data(contentsOf: fileURL))
        guard cache.schemaVersion == CompanionCache.currentSchemaVersion else {
            throw StoreError.unsupportedSchema
        }
        guard cache.serverOrigin == serverOrigin else {
            throw StoreError.serverMismatch
        }
        return cache.bounded()
    }

    public func save(_ cache: CompanionCache) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let data = try encoder.encode(cache.bounded())
        guard data.count <= Self.maximumEncodedBytes else {
            throw StoreError.cacheTooLarge
        }
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS) || os(tvOS) || os(watchOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try data.write(to: fileURL, options: options)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedURL = fileURL
        try? protectedURL.setResourceValues(values)
    }

    public func remove() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }
}

public struct CompanionWidgetSnapshot: Codable, Equatable, Sendable {
    public static let appGroupIdentifier = "group.net.nysta.stuga"
    public static let storageKey = "stuga.widget.snapshot.v1"

    public let homeId: String
    public let homeName: String
    public let homeOrigin: String?
    public let state: String
    public let title: String
    public let detail: String
    public let activeAlertCount: Int
    public let updatedAt: String

    public init(
        homeId: String,
        homeName: String,
        homeOrigin: String? = nil,
        state: String,
        title: String,
        detail: String,
        activeAlertCount: Int,
        updatedAt: String
    ) {
        self.homeId = homeId
        self.homeName = homeName
        self.homeOrigin = homeOrigin
        self.state = state
        self.title = title
        self.detail = detail
        self.activeAlertCount = activeAlertCount
        self.updatedAt = updatedAt
    }
}

public struct CompanionWidgetSnapshotStore {
    public static let widgetKind = "StugaStatusWidget"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults? = UserDefaults(
        suiteName: CompanionWidgetSnapshot.appGroupIdentifier
    )) {
        self.defaults = defaults ?? .standard
    }

    public func load() -> CompanionWidgetSnapshot? {
        guard let data = defaults.data(forKey: CompanionWidgetSnapshot.storageKey) else {
            return nil
        }
        return try? JSONDecoder().decode(CompanionWidgetSnapshot.self, from: data)
    }

    public func save(_ snapshot: CompanionWidgetSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: CompanionWidgetSnapshot.storageKey)
        reloadWidget()
    }

    public func remove() {
        defaults.removeObject(forKey: CompanionWidgetSnapshot.storageKey)
        reloadWidget()
    }

    private func reloadWidget() {
        #if os(iOS) && canImport(WidgetKit)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        #endif
    }
}

public enum CompanionDeepLink: Equatable, Sendable {
    case home
    case alerts(alertId: String?)
    case inventory
    case capture
    case roomScan
    case equipment(EquipmentQRCode)

    public static func parse(_ url: URL) -> CompanionDeepLink? {
        guard url.scheme?.lowercased() == "stuga",
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.path.isEmpty,
              url.fragment == nil,
              let components = URLComponents(
                  url: url,
                  resolvingAgainstBaseURL: false
              ) else {
            return nil
        }
        let queryItems = components.queryItems ?? []
        switch url.host?.lowercased() {
        case "home":
            guard queryItems.isEmpty else { return nil }
            return .home
        case "alerts":
            guard queryItems.count <= 1,
                  queryItems.allSatisfy({ $0.name == "id" }) else {
                return nil
            }
            let alert = queryItems.first?.value
            if let alert {
                guard !alert.isEmpty,
                      alert.count <= 200,
                      alert.unicodeScalars.allSatisfy({
                          CharacterSet.alphanumerics.contains($0)
                              || "-._:".unicodeScalars.contains($0)
                      }) else {
                    return nil
                }
            }
            return .alerts(alertId: alert)
        case "inventory":
            guard queryItems.isEmpty else { return nil }
            return .inventory
        case "capture":
            guard queryItems.isEmpty else { return nil }
            return .capture
        case "room-scan":
            guard queryItems.isEmpty else { return nil }
            return .roomScan
        case "equipment":
            guard let code = EquipmentQRCode.parse(url.absoluteString) else { return nil }
            return .equipment(code)
        default:
            return nil
        }
    }
}
