import Foundation

public enum ReadingFreshness: String, Equatable, Sendable {
    case live
    case aging
    case stale
    case missing

    public static func evaluate(sampleDate: Date?, now: Date = Date()) -> ReadingFreshness {
        guard let sampleDate else { return .missing }
        let signedAge = now.timeIntervalSince(sampleDate)
        if signedAge < -5 * 60 { return .stale }
        let age = max(0, signedAge)
        if age <= 5 * 60 { return .live }
        if age <= 15 * 60 { return .aging }
        return .stale
    }
}

public enum HomeMonitorState: String, Equatable, Sendable {
    case critical
    case attention
    case limited
    case balanced
}

public struct HomeMonitorSummary: Equatable, Sendable {
    public let state: HomeMonitorState
    public let title: String
    public let detail: String

    public static func evaluate(
        conditions: [SensorCondition],
        alerts: [AlertEvent],
        now: Date = Date()
    ) -> HomeMonitorSummary {
        let active = alerts.filter(\.isActive)
        if active.contains(where: { $0.severity == "critical" }) {
            return .init(
                state: .critical,
                title: "One condition needs urgent attention",
                detail: "Open the alert before checking routine readings."
            )
        }
        if !active.isEmpty {
            let count = active.count
            return .init(
                state: .attention,
                title: count == 1 ? "One condition needs attention" : "\(count) conditions need attention",
                detail: "Review the active alerts and decide what to do next."
            )
        }
        if conditions.isEmpty {
            return .init(
                state: .limited,
                title: "Monitoring is not ready",
                detail: "No enabled sensors are available for this Home."
            )
        }

        let environmentalConditions = conditions.filter(\.monitorsEnvironmentalConditions)
        if environmentalConditions.isEmpty {
            return .init(
                state: .limited,
                title: "Current conditions are unavailable",
                detail: "No current indoor-condition measurements are available."
            )
        }
        let environmentalSamples = environmentalConditions.map(\.newestEnvironmentalSample)
        let freshness = environmentalSamples.map { sample in
            guard let sample else { return ReadingFreshness.missing }
            return sample.quality == "stale"
                ? .stale
                : ReadingFreshness.evaluate(sampleDate: sample.observedAt, now: now)
        }
        if freshness.allSatisfy({ $0 == .missing || $0 == .stale }) {
            return .init(
                state: .limited,
                title: "Current conditions are unavailable",
                detail: "The latest readings are missing or more than 15 minutes old."
            )
        }
        if freshness.contains(.missing) || freshness.contains(.stale) || freshness.contains(.aging)
            || environmentalSamples.compactMap({ $0 }).contains(where: { $0.quality != "good" }) {
            return .init(
                state: .limited,
                title: "Some monitoring needs a check",
                detail: "At least one reading is aging, stale, missing, or estimated."
            )
        }
        return .init(
            state: .balanced,
            title: "Your Home looks balanced",
            detail: "No active alerts, and current sensor readings are available."
        )
    }
}

public enum MetricOrder {
    private static let preferred = ["temperature", "humidity", "co2", "battery", "power", "energy"]

    public static func sort(_ metrics: some Sequence<String>) -> [String] {
        Array(metrics).sorted { left, right in
            let leftIndex = preferred.firstIndex(of: left) ?? preferred.count
            let rightIndex = preferred.firstIndex(of: right) ?? preferred.count
            return leftIndex == rightIndex ? left.localizedStandardCompare(right) == .orderedAscending : leftIndex < rightIndex
        }
    }
}

public enum DisplayUnitSystem: String, CaseIterable, Codable, Equatable, Sendable {
    case metric
    case imperial
}

public enum MetricValueFormatter {
    public static func convertedValue(
        _ value: Double,
        metric: String,
        units: DisplayUnitSystem
    ) -> Double {
        metric == "temperature" && units == .imperial ? value * 9 / 5 + 32 : value
    }

    public static func displayUnit(
        metric: String,
        canonicalUnit: String,
        units: DisplayUnitSystem
    ) -> String {
        metric == "temperature" && units == .imperial ? "°F" : canonicalUnit
    }

    public static func text(
        value: Double,
        precision: Int,
        unit: String,
        metric: String = "",
        units: DisplayUnitSystem = .metric
    ) -> String {
        let digits = max(0, min(3, precision))
        let converted = convertedValue(value, metric: metric, units: units)
        let displayUnit = displayUnit(metric: metric, canonicalUnit: unit, units: units)
        let formatted = converted.formatted(.number.precision(.fractionLength(digits)))
        return displayUnit.isEmpty ? formatted : "\(formatted) \(displayUnit)"
    }
}
