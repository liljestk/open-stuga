import Foundation

public struct AppSession: Codable, Equatable, Sendable {
    public struct Principal: Codable, Equatable, Sendable {
        public let type: String
        public let email: String?
    }

    public struct Tenant: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let role: String
    }

    public let authenticated: Bool
    public let principal: Principal
    public let tenant: Tenant
    public let readOnly: Bool
    public let csrfToken: String?
    public let setupRequired: Bool?
}

public struct HealthResponse: Codable, Equatable, Sendable {
    public let status: String
    public let systemVersion: String
    public let apiVersion: String
}

public struct StugbyPropertyLink: Codable, Equatable, Sendable {
    public let stugbyId: String
    public let authorityNodeId: String
    public let isAuthority: Bool
    public let editPolicy: String
    public let syncState: String
    public let authorityEpoch: Int
    public let lastSyncedRevision: Int
    public let pendingChangeCount: Int
    public let conflictCount: Int
    public let detachedAt: String?

    public var isForeignSharedProperty: Bool {
        !isAuthority && syncState != "detached"
    }

    public var isReadOnly: Bool {
        isForeignSharedProperty && editPolicy == "read-only"
    }
}

public struct StugbyHouseLink: Codable, Equatable, Sendable {
    public let stugbyId: String
    public let authorityNodeId: String
    public let publicationId: String
    public let ownership: String
    public let editPolicy: String
    public let syncState: String
    public let authorityEpoch: Int
    public let pendingChangeCount: Int
    public let conflictCount: Int
    public let recoveryState: String
    public let designatedSuccessorNodeId: String?
    public let recoverySyncedThrough: String?
    public let detachedAt: String?

    public var isForeignSharedHome: Bool {
        ownership == "shared" && syncState != "detached"
    }

    public var isReadOnly: Bool {
        isForeignSharedHome && editPolicy == "read-only"
    }
}

public struct StugaProperty: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let stugby: StugbyPropertyLink?
    public let createdAt: String
    public let updatedAt: String
}

public struct HouseLocation: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let label: String?
    public let countryCode: String?
    public let source: String?
    public let confidence: String?
    public let discoveredAt: String?
    public let userOverridden: Bool?
}

public struct HouseMapPlacement: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let metersPerPlanUnit: Double
    public let footprintFloorId: String?
}

public struct House: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let name: String
    public let timezone: String
    public let location: HouseLocation?
    public let mapPlacement: HouseMapPlacement?
    public let floors: [StugaFloor]
    public let stugby: StugbyHouseLink?
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        propertyId: String,
        name: String,
        timezone: String,
        location: HouseLocation? = nil,
        mapPlacement: HouseMapPlacement? = nil,
        floors: [StugaFloor] = [],
        stugby: StugbyHouseLink? = nil,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.propertyId = propertyId
        self.name = name
        self.timezone = timezone
        self.location = location
        self.mapPlacement = mapPlacement
        self.floors = floors
        self.stugby = stugby
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case propertyId
        case name
        case timezone
        case location
        case mapPlacement
        case floors
        case stugby
        case createdAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        propertyId = try values.decode(String.self, forKey: .propertyId)
        name = try values.decode(String.self, forKey: .name)
        timezone = try values.decode(String.self, forKey: .timezone)
        location = try values.decodeIfPresent(HouseLocation.self, forKey: .location)
        mapPlacement = try values.decodeIfPresent(HouseMapPlacement.self, forKey: .mapPlacement)
        floors = try values.decodeIfPresent([StugaFloor].self, forKey: .floors) ?? []
        stugby = try values.decodeIfPresent(StugbyHouseLink.self, forKey: .stugby)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
    }
}

public struct SystemUpdateSettings: Codable, Equatable, Sendable {
    public let mode: String
    public let includePrereleases: Bool
    public let checkIntervalHours: Int
    public let updateTime: String
    public let updateDays: [String]
    public let timezone: String
}

public struct SystemRelease: Codable, Equatable, Sendable {
    public let version: String
    public let tagName: String
    public let name: String
    public let notes: String
    public let publishedAt: String
    public let url: String
    public let prerelease: Bool
}

public struct SystemUpdateActivity: Codable, Equatable, Sendable {
    public let phase: String
    public let at: String
    public let detail: String
}

public struct SystemUpdateOperation: Codable, Equatable, Sendable {
    public let id: String
    public let version: String
    public let tagName: String
    public let phase: String
    public let requestedAt: String
    public let startedAt: String?
    public let completedAt: String?
    public let updatedAt: String
    public let phaseStartedAt: String
    public let detail: String?
    public let previousVersion: String
    public let activity: [SystemUpdateActivity]

    public var isActive: Bool {
        [
            "queued",
            "preparing",
            "backup",
            "pulling",
            "applying",
            "verifying",
            "rolling-back",
        ].contains(phase)
    }

    public var completedProgressSteps: Int {
        let phases = ["preparing", "backup", "pulling", "applying", "verifying"]
        if phase == "complete" { return phases.count }
        if let index = phases.firstIndex(of: phase) { return index }
        for entry in activity.reversed() {
            if let index = phases.firstIndex(of: entry.phase) {
                return phase == "failed" || phase == "rolling-back"
                    ? index
                    : min(index + 1, phases.count)
            }
        }
        return 0
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case version
        case tagName
        case phase
        case requestedAt
        case startedAt
        case completedAt
        case updatedAt
        case phaseStartedAt
        case detail
        case previousVersion
        case activity
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        version = try values.decode(String.self, forKey: .version)
        tagName = try values.decode(String.self, forKey: .tagName)
        phase = try values.decode(String.self, forKey: .phase)
        requestedAt = try values.decode(String.self, forKey: .requestedAt)
        startedAt = try values.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try values.decodeIfPresent(String.self, forKey: .completedAt)
        detail = try values.decodeIfPresent(String.self, forKey: .detail)
        previousVersion = try values.decode(String.self, forKey: .previousVersion)
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
            ?? completedAt
            ?? startedAt
            ?? requestedAt
        phaseStartedAt = try values.decodeIfPresent(String.self, forKey: .phaseStartedAt)
            ?? updatedAt
        activity = try values.decodeIfPresent(
            [SystemUpdateActivity].self,
            forKey: .activity
        ) ?? [
            SystemUpdateActivity(
                phase: phase,
                at: phaseStartedAt,
                detail: detail ?? phase
            ),
        ]
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(version, forKey: .version)
        try values.encode(tagName, forKey: .tagName)
        try values.encode(phase, forKey: .phase)
        try values.encode(requestedAt, forKey: .requestedAt)
        try values.encodeIfPresent(startedAt, forKey: .startedAt)
        try values.encodeIfPresent(completedAt, forKey: .completedAt)
        try values.encode(updatedAt, forKey: .updatedAt)
        try values.encode(phaseStartedAt, forKey: .phaseStartedAt)
        try values.encodeIfPresent(detail, forKey: .detail)
        try values.encode(previousVersion, forKey: .previousVersion)
        try values.encode(activity, forKey: .activity)
    }
}

public struct SystemUpdateCapability: Codable, Equatable, Sendable {
    public let available: Bool
    public let runtime: String?
    public let agentLastSeenAt: String?
    public let reason: String
}

public struct SystemUpdateStatus: Codable, Equatable, Sendable {
    public let currentVersion: String
    public let latestVersion: String?
    public let updateAvailable: Bool
    public let latestRelease: SystemRelease?
    public let releases: [SystemRelease]
    public let lastCheckedAt: String?
    public let checkError: String?
    public let settings: SystemUpdateSettings
    public let nextUpdateWindowAt: String?
    public let capability: SystemUpdateCapability
    public let operation: SystemUpdateOperation?
}

public struct SystemUpdateEvent: Codable, Equatable, Sendable {
    public let currentVersion: String
    public let latestVersion: String?
    public let updateAvailable: Bool
    public let capability: SystemUpdateCapability
    public let operation: SystemUpdateOperation?
}

public struct Sensor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let houseId: String
    public let floorId: String
    public let name: String
    public let roomId: String?
    public let room: String
    public let model: String
    public let enabled: Bool
    public let temperatureEntityId: String?
    public let humidityEntityId: String?
    public let batteryEntityId: String?
    public let tpLinkDeviceId: String?
    public let measurementEntityIds: [String: String]?

    public init(
        id: String,
        houseId: String,
        floorId: String,
        name: String,
        roomId: String?,
        room: String,
        model: String,
        enabled: Bool,
        temperatureEntityId: String? = nil,
        humidityEntityId: String? = nil,
        batteryEntityId: String? = nil,
        tpLinkDeviceId: String? = nil,
        measurementEntityIds: [String: String]? = nil
    ) {
        self.id = id
        self.houseId = houseId
        self.floorId = floorId
        self.name = name
        self.roomId = roomId
        self.room = room
        self.model = model
        self.enabled = enabled
        self.temperatureEntityId = temperatureEntityId
        self.humidityEntityId = humidityEntityId
        self.batteryEntityId = batteryEntityId
        self.tpLinkDeviceId = tpLinkDeviceId
        self.measurementEntityIds = measurementEntityIds
    }
}

public struct MeasurementDefinition: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let labels: [String: String]
    public let unit: String
    public let precision: Int
    public let enabled: Bool
    public let colorScale: String

    public func label(for locale: Locale = .current) -> String {
        let language = locale.language.languageCode?.identifier ?? "en"
        return labels[language] ?? labels["en"] ?? labels.values.first ?? id
    }
}

public struct MeasurementSample: Codable, Equatable, Sendable {
    public let sensorId: String
    public let metric: String
    public let value: Double
    public let canonicalUnit: String
    public let timestamp: String
    public let source: String
    public let quality: String

    public var observedAt: Date? {
        StugaDateParser.date(from: timestamp)
    }
}

public struct MeasurementSnapshotEntry: Codable, Equatable, Sendable {
    public let sensorId: String
    public let measurements: [String: MeasurementSample]
}

public struct AlertRule: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let sensorId: String?
    public let metric: String
    public let `operator`: String
    public let threshold: Double
    public let durationSeconds: Int
    public let severity: String
    public let enabled: Bool
}

public struct AlertEvent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let ruleId: String
    public let sensorId: String
    public let metric: String
    public let value: Double
    public let threshold: Double
    public let severity: String
    public let startedAt: String
    public let acknowledgedAt: String?
    public let resolvedAt: String?

    public var isActive: Bool { resolvedAt == nil }
    public var startedDate: Date? { StugaDateParser.date(from: startedAt) }
}

public struct SensorCondition: Identifiable, Equatable, Sendable {
    private static let operationalMetrics: Set<String> = [
        "battery", "power", "energy", "voltage", "current", "signal-strength",
    ]

    public let sensor: Sensor
    public let measurements: [String: MeasurementSample]

    public var id: String { sensor.id }
    public var newestSample: MeasurementSample? {
        measurements.values.max {
            ($0.observedAt ?? .distantPast) < ($1.observedAt ?? .distantPast)
        }
    }
    public var newestEnvironmentalSample: MeasurementSample? {
        measurements
            .filter { !Self.operationalMetrics.contains($0.key) }
            .map(\.value)
            .max { ($0.observedAt ?? .distantPast) < ($1.observedAt ?? .distantPast) }
    }
    public var monitorsEnvironmentalConditions: Bool {
        if newestEnvironmentalSample != nil { return true }
        if sensor.temperatureEntityId != nil || sensor.humidityEntityId != nil { return true }
        if sensor.measurementEntityIds?.keys.contains(where: {
            !Self.operationalMetrics.contains($0)
        }) == true {
            return true
        }
        let normalizedModel = sensor.model.uppercased()
        return normalizedModel.hasPrefix("T310") || normalizedModel.hasPrefix("T315")
    }

    public init(sensor: Sensor, measurements: [String: MeasurementSample]) {
        self.sensor = sensor
        self.measurements = measurements
    }
}

public struct DashboardSnapshot: Equatable, Sendable {
    public let sensors: [Sensor]
    public let conditions: [SensorCondition]
    public let alerts: [AlertEvent]
    public let rules: [AlertRule]

    public init(
        sensors: [Sensor],
        conditions: [SensorCondition],
        alerts: [AlertEvent],
        rules: [AlertRule]
    ) {
        self.sensors = sensors
        self.conditions = conditions
        self.alerts = alerts
        self.rules = rules
    }
}

enum StugaDateParser {
    static func date(from value: String) -> Date? {
        if let date = try? Date(
            value,
            strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        ) {
            return date
        }
        return try? Date(
            value,
            strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: false)
        )
    }
}
