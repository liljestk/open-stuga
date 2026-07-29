import Foundation

public enum HomeMonitoringAvailability: Equatable, Sendable {
    case available
    case serverUpgradeRequired
    case unavailable
}

public enum ServerFeatureSupport {
    public static let homeMonitoringMinimumVersion = "0.20.0"

    public static func homeMonitoring(systemVersion: String?) -> Bool {
        guard let systemVersion else { return false }
        return compare(systemVersion, to: homeMonitoringMinimumVersion) != .orderedAscending
    }

    private static func compare(_ first: String, to second: String) -> ComparisonResult {
        guard let firstParts = versionParts(first),
              let secondParts = versionParts(second) else {
            return .orderedAscending
        }
        for index in 0..<3 {
            if firstParts[index] < secondParts[index] { return .orderedAscending }
            if firstParts[index] > secondParts[index] { return .orderedDescending }
        }
        return .orderedSame
    }

    private static func versionParts(_ value: String) -> [Int]? {
        var normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.hasPrefix("v") {
            normalized.removeFirst()
        }
        let core = normalized.split(separator: "-", maxSplits: 1).first
        guard let core else { return nil }
        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
            .compactMap { Int($0) }
        return parts.count == 3 && parts.allSatisfy({ $0 >= 0 }) ? parts : nil
    }
}

public struct DerivedAnalyticsWarning: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let details: [String: JSONValue]?
}

public struct DerivedAnalyticsProvenance: Codable, Equatable, Sendable {
    public let algorithmKey: String
    public let algorithmVersion: String
    public let evaluatedAt: String
    public let sourceIds: [String]
}

public struct HomeMonitoringAlgorithm: Codable, Equatable, Sendable {
    public let key: String
    public let version: String
}

public struct HomeMonitoringCoverage: Codable, Equatable, Sendable {
    public let enabledSensors: Int
    public let freshSensors: Int
    public let estimatedSensors: Int
    public let agingSensors: Int
    public let staleSensors: Int
    public let sensorsWithoutData: Int
}

public struct HomeMonitoringBlocker: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let code: String
    public let parameters: [String: JSONValue]
    public let fallbackMessage: String
    public let count: Int
    public let sensorIds: [String]
    public let evidenceAt: String?
    public let acknowledged: Bool
}

public struct HomeMonitoringHouseSummary: Codable, Equatable, Sendable {
    public let houseId: String
    public let generatedAt: String
    public let status: String
    public let pulseStatus: String
    public let coverage: HomeMonitoringCoverage
    public let activeAlertCount: Int
    public let blockers: [HomeMonitoringBlocker]
}

public struct HomeMonitoringFreshness: Codable, Equatable, Sendable {
    public let state: String
    public let evidenceAt: String?
    public let ageMinutes: Double?
}

public struct HomeMonitoringSensorCoverage: Codable, Equatable, Sendable {
    public let sensorId: String
    public let freshness: HomeMonitoringFreshness
    public let requiredMetrics: [String]
}

public struct HomeMonitoringInsightTarget: Codable, Equatable, Sendable {
    public let houseId: String
    public let sensorId: String?
    public let sensorName: String?
    public let floorId: String?
    public let floorName: String?
    public let room: String?
}

public struct HomeMonitoringEvidence: Codable, Equatable, Sendable {
    public let label: String
    public let value: JSONValue
    public let unit: String?
    public let metric: String?
    public let sensorId: String?
    public let observedAt: String?
}

public struct HomeMonitoringConfidence: Codable, Equatable, Sendable {
    public let level: String
    public let score: Double
    public let reasonCode: String
    public let fallbackReason: String
}

public struct HomeMonitoringInsight: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let rank: Int
    public let kind: String
    public let severity: String
    public let priority: Double
    public let titleCode: String
    public let summaryCode: String
    public let actionCode: String
    public let parameters: [String: JSONValue]
    public let fallbackTitle: String
    public let fallbackSummary: String
    public let fallbackAction: String
    public let target: HomeMonitoringInsightTarget
    public let evidence: [HomeMonitoringEvidence]
    public let freshness: HomeMonitoringFreshness
    public let confidence: HomeMonitoringConfidence
    public let safetyNote: String?
}

public struct HomeMonitoringDetailResponse: Codable, Equatable, Sendable {
    public let apiVersion: String
    public let dataMode: String
    public let algorithm: HomeMonitoringAlgorithm
    public let generatedAt: String
    public let evaluatedAt: String
    public let completeness: String
    public let warnings: [DerivedAnalyticsWarning]
    public let provenance: DerivedAnalyticsProvenance
    public let house: HomeMonitoringHouseSummary
    public let sensorCoverage: [HomeMonitoringSensorCoverage]
    public let insights: [HomeMonitoringInsight]
    public let advisoryCode: String
    public let fallbackAdvisory: String
}

public extension HomeMonitorSummary {
    static func from(server response: HomeMonitoringDetailResponse) -> HomeMonitorSummary {
        let state: HomeMonitorState
        switch response.house.pulseStatus {
        case "critical":
            state = .critical
        case "attention", "watch":
            state = .attention
        case "steady":
            state = .balanced
        default:
            state = .limited
        }

        if let insight = response.insights.first {
            return HomeMonitorSummary(
                state: state,
                title: insight.fallbackTitle,
                detail: insight.fallbackSummary
            )
        }

        switch state {
        case .critical:
            return HomeMonitorSummary(
                state: .critical,
                title: "One condition needs urgent attention",
                detail: "Open the monitoring details before checking routine readings."
            )
        case .attention:
            return HomeMonitorSummary(
                state: .attention,
                title: "One or more conditions need attention",
                detail: "Open the monitoring details to review the server findings."
            )
        case .balanced:
            return HomeMonitorSummary(
                state: .balanced,
                title: "Your Home looks balanced",
                detail: "The server found no current monitoring issue."
            )
        case .limited:
            return HomeMonitorSummary(
                state: .limited,
                title: "Current conditions are unavailable",
                detail: "The server could not establish a current monitoring state."
            )
        }
    }

    static let serverUpgradeRequired = HomeMonitorSummary(
        state: .limited,
        title: "Server upgrade required",
        detail: "Update Stugu Server to use server-authoritative Home monitoring."
    )

    static let serverUnavailable = HomeMonitorSummary(
        state: .limited,
        title: "Current monitoring is unavailable",
        detail: "Reconnect or refresh to retrieve the server monitoring result."
    )
}

public extension TodayRecommendation {
    static func from(server response: HomeMonitoringDetailResponse) -> TodayRecommendation? {
        guard let insight = response.insights.first else { return nil }
        return TodayRecommendation(
            kind: .monitoring,
            title: insight.fallbackTitle,
            detail: insight.fallbackSummary,
            evidence: insight.fallbackAction
        )
    }
}
