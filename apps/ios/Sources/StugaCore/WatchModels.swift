import Foundation

public struct WatchAlertSummary: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let severity: String
    public let title: String
    public let startedAt: String

    public init(id: String, severity: String, title: String, startedAt: String) {
        self.id = id
        self.severity = severity
        self.title = String(title.prefix(160))
        self.startedAt = startedAt
    }
}

public struct WatchHomeSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let available: Bool
    public let homeId: String?
    public let homeName: String
    public let state: String
    public let title: String
    public let detail: String
    public let updatedAt: String
    public let cached: Bool
    public let readOnly: Bool
    public let alerts: [WatchAlertSummary]

    public init(
        available: Bool = true,
        homeId: String?,
        homeName: String,
        state: String,
        title: String,
        detail: String,
        updatedAt: String,
        cached: Bool,
        readOnly: Bool,
        alerts: [WatchAlertSummary]
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.available = available
        self.homeId = homeId
        self.homeName = String(homeName.prefix(120))
        self.state = state
        self.title = String(title.prefix(160))
        self.detail = String(detail.prefix(240))
        self.updatedAt = updatedAt
        self.cached = cached
        self.readOnly = readOnly
        self.alerts = Array(alerts.prefix(8))
    }

    public static func unavailable(at timestamp: String) -> WatchHomeSnapshot {
        WatchHomeSnapshot(
            available: false,
            homeId: nil,
            homeName: "Stuga",
            state: "unavailable",
            title: "Open Stuga on iPhone",
            detail: "The watch has no current Home summary.",
            updatedAt: timestamp,
            cached: true,
            readOnly: true,
            alerts: []
        )
    }
}

public struct WatchCompanionAction: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case acknowledgeAlert
    }

    public let id: String
    public let kind: Kind
    public let alertId: String
    public let createdAt: String

    public init(
        id: String = UUID().uuidString.lowercased(),
        kind: Kind = .acknowledgeAlert,
        alertId: String,
        createdAt: String
    ) {
        self.id = id
        self.kind = kind
        self.alertId = alertId
        self.createdAt = createdAt
    }
}

public enum WatchCompanionPayload {
    public static let snapshotDataKey = "stugaWatchSnapshot"
    public static let actionDataKey = "stugaWatchAction"
    public static let requestKey = "stugaWatchRequest"
    public static let snapshotRequest = "snapshot"
}
