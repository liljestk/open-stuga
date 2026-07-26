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

public struct StugaProperty: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let createdAt: String
    public let updatedAt: String
}

public struct House: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let name: String
    public let timezone: String
    public let createdAt: String
    public let updatedAt: String
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
