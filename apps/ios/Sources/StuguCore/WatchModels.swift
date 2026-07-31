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

public struct WatchActionContext: Codable, Equatable, Sendable {
    public let serverBinding: String
    public let accountBinding: String
    public let homeId: String

    public init(serverBinding: String, accountBinding: String, homeId: String) {
        self.serverBinding = serverBinding
        self.accountBinding = accountBinding
        self.homeId = homeId
    }

    public var isWellFormed: Bool {
        [serverBinding, accountBinding, homeId].allSatisfy {
            !$0.isEmpty && $0.count <= 200
        }
    }
}

public struct WatchHomeSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2
    public static let minimumSupportedSchemaVersion = 1

    public let schemaVersion: Int
    public let available: Bool
    public let homeId: String?
    public let homeName: String
    public let homeOrigin: String?
    public let state: String
    public let title: String
    public let detail: String
    public let updatedAt: String
    public let cached: Bool
    public let readOnly: Bool
    public let alerts: [WatchAlertSummary]
    public let actionContext: WatchActionContext?

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case available
        case homeId
        case homeName
        case homeOrigin
        case state
        case title
        case detail
        case updatedAt
        case cached
        case readOnly
        case alerts
        case actionContext
    }

    public init(
        available: Bool = true,
        homeId: String?,
        homeName: String,
        homeOrigin: String? = nil,
        state: String,
        title: String,
        detail: String,
        updatedAt: String,
        cached: Bool,
        readOnly: Bool,
        alerts: [WatchAlertSummary],
        actionContext: WatchActionContext? = nil
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.available = available
        self.homeId = homeId
        self.homeName = String(homeName.prefix(120))
        self.homeOrigin = homeOrigin
        self.state = state
        self.title = String(title.prefix(160))
        self.detail = String(detail.prefix(240))
        self.updatedAt = updatedAt
        self.cached = cached
        self.readOnly = readOnly
        self.alerts = Array(alerts.prefix(8))
        self.actionContext = actionContext?.homeId == homeId ? actionContext : nil
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let storedSchemaVersion = try values.decodeIfPresent(
            Int.self,
            forKey: .schemaVersion
        ) ?? Self.minimumSupportedSchemaVersion
        guard (Self.minimumSupportedSchemaVersion...Self.currentSchemaVersion)
            .contains(storedSchemaVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: values,
                debugDescription: "Unsupported Watch snapshot schema \(storedSchemaVersion)."
            )
        }
        schemaVersion = Self.currentSchemaVersion
        available = try values.decodeIfPresent(Bool.self, forKey: .available) ?? true
        homeId = try values.decodeIfPresent(String.self, forKey: .homeId)
        homeName = try values.decode(String.self, forKey: .homeName)
        homeOrigin = try values.decodeIfPresent(String.self, forKey: .homeOrigin)
        state = try values.decode(String.self, forKey: .state)
        title = try values.decode(String.self, forKey: .title)
        detail = try values.decode(String.self, forKey: .detail)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        cached = try values.decodeIfPresent(Bool.self, forKey: .cached) ?? true
        readOnly = try values.decodeIfPresent(Bool.self, forKey: .readOnly) ?? true
        let decodedAlerts = try values.decodeIfPresent(
            [WatchAlertSummary].self,
            forKey: .alerts
        ) ?? []
        alerts = Array(decodedAlerts.prefix(8))
        let decodedContext = try values.decodeIfPresent(
            WatchActionContext.self,
            forKey: .actionContext
        )
        actionContext = decodedContext?.homeId == homeId ? decodedContext : nil
    }

    public static func unavailable(at timestamp: String) -> WatchHomeSnapshot {
        WatchHomeSnapshot(
            available: false,
            homeId: nil,
            homeName: "Stugu",
            state: "unavailable",
            title: "Open Stugu on iPhone",
            detail: "The watch has no current Home summary.",
            updatedAt: timestamp,
            cached: true,
            readOnly: true,
            alerts: []
        )
    }
}

public struct WatchCompanionAction: Codable, Identifiable, Equatable, Sendable {
    public static let currentSchemaVersion = 2
    public static let minimumSupportedSchemaVersion = 1

    public enum Kind: String, Codable, Sendable {
        case acknowledgeAlert
    }

    public let schemaVersion: Int
    public let id: String
    public let kind: Kind
    public let alertId: String
    public let createdAt: String
    public let context: WatchActionContext?

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case kind
        case alertId
        case createdAt
        case context
    }

    public init(
        id: String = UUID().uuidString.lowercased(),
        kind: Kind = .acknowledgeAlert,
        alertId: String,
        createdAt: String,
        context: WatchActionContext
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.id = id
        self.kind = kind
        self.alertId = alertId
        self.createdAt = createdAt
        self.context = context
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let storedSchemaVersion = try values.decodeIfPresent(
            Int.self,
            forKey: .schemaVersion
        ) ?? Self.minimumSupportedSchemaVersion
        guard (Self.minimumSupportedSchemaVersion...Self.currentSchemaVersion)
            .contains(storedSchemaVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: values,
                debugDescription: "Unsupported Watch action schema \(storedSchemaVersion)."
            )
        }
        schemaVersion = Self.currentSchemaVersion
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(Kind.self, forKey: .kind)
        alertId = try values.decode(String.self, forKey: .alertId)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        context = try values.decodeIfPresent(WatchActionContext.self, forKey: .context)
    }

    public func isBound(to expectedContext: WatchActionContext) -> Bool {
        context == expectedContext && expectedContext.isWellFormed
    }
}

public enum WatchCompanionPayload {
    public static let snapshotDataKey = "stuguWatchSnapshot"
    public static let actionDataKey = "stuguWatchAction"
    public static let requestKey = "stuguWatchRequest"
    public static let snapshotRequest = "snapshot"
}
