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

public enum ContactTransitionKind: String, Equatable, Sendable {
    case opened
    case closed
}

public struct ContactTransition: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: ContactTransitionKind
    public let observedAt: Date
}

public struct ContactHistorySummary: Equatable, Sendable {
    public let openingCount: Int
    public let closingCount: Int
    public let confirmedOpenDuration: TimeInterval
    public let currentState: StuguOpeningState
    public let transitions: [ContactTransition]
}

public enum ContactHistoryAnalyzer {
    private struct Point {
        let observation: OpeningStateObservation
        let date: Date
        let state: StuguOpeningState
    }

    public static func analyze(
        _ observations: [OpeningStateObservation],
        deviceId: String,
        connectionId: String?,
        floorId: String,
        elementId: String,
        invert: Bool,
        staleAfterSeconds: Int,
        from: Date,
        to: Date
    ) -> ContactHistorySummary {
        guard to > from else {
            return ContactHistorySummary(
                openingCount: 0,
                closingCount: 0,
                confirmedOpenDuration: 0,
                currentState: .unknown,
                transitions: []
            )
        }
        let points = observations.compactMap { observation -> Point? in
            guard observation.floorId == floorId,
                  observation.elementId == elementId,
                  observation.source == "tapo",
                  observation.externalId == deviceId,
                  connectionId == nil || observation.connectionId == connectionId,
                  let date = observation.observedDate,
                  date <= to else {
                return nil
            }
            return Point(
                observation: observation,
                date: date,
                state: normalized(observation.state, invert: invert)
            )
        }.sorted {
            $0.date == $1.date
                ? $0.observation.id < $1.observation.id
                : $0.date < $1.date
        }

        var transitions: [ContactTransition] = []
        var previousState: StuguOpeningState?
        var confirmedOpenDuration: TimeInterval = 0
        let maximumAge = TimeInterval(max(1, staleAfterSeconds))

        for (index, point) in points.enumerated() {
            if point.state == .open {
                let nextDate = points.indices.contains(index + 1)
                    ? points[index + 1].date
                    : to
                let declaredEnd = validityEnd(for: point)
                let start = max(point.date, from)
                let end = [
                    to,
                    nextDate,
                    declaredEnd,
                    point.date.addingTimeInterval(maximumAge),
                ].min() ?? to
                if end > start {
                    confirmedOpenDuration += end.timeIntervalSince(start)
                }
            }

            if point.state != previousState, point.date >= from {
                if previousState == .closed, point.state == .open {
                    transitions.append(ContactTransition(
                        id: point.observation.id,
                        kind: .opened,
                        observedAt: point.date
                    ))
                } else if previousState == .open, point.state == .closed {
                    transitions.append(ContactTransition(
                        id: point.observation.id,
                        kind: .closed,
                        observedAt: point.date
                    ))
                }
            }
            previousState = point.state
        }

        let currentState: StuguOpeningState
        if let latest = points.last,
           latest.state != .unknown,
           latest.date.addingTimeInterval(maximumAge) >= to,
           validityEnd(for: latest) >= to {
            currentState = latest.state
        } else {
            currentState = .unknown
        }

        return ContactHistorySummary(
            openingCount: transitions.filter { $0.kind == .opened }.count,
            closingCount: transitions.filter { $0.kind == .closed }.count,
            confirmedOpenDuration: confirmedOpenDuration,
            currentState: currentState,
            transitions: transitions
        )
    }

    private static func normalized(
        _ state: StuguOpeningState,
        invert: Bool
    ) -> StuguOpeningState {
        guard invert else { return state }
        switch state {
        case .open: return .closed
        case .closed: return .open
        case .unknown: return .unknown
        }
    }

    private static func validityEnd(for point: Point) -> Date {
        guard let validUntil = point.observation.validUntil else {
            return .distantFuture
        }
        return StuguDateParser.date(from: validUntil) ?? point.date
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
