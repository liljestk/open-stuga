import Foundation

public enum TrackingProximityBand: String, Codable, Equatable, Sendable {
    case far
    case nearby
    case close
    case veryClose

    public static func classify(rssi: Double) -> Self {
        if rssi >= -55 { return .veryClose }
        if rssi >= -67 { return .close }
        if rssi >= -78 { return .nearby }
        return .far
    }
}

public enum TrackingSignalTrend: String, Codable, Equatable, Sendable {
    case gettingCloser
    case gettingFarther
    case steady
}

public struct TrackingProximityReading: Equatable, Sendable {
    public let rawRSSI: Int
    public let medianRSSI: Double
    public let smoothedRSSI: Double
    public let band: TrackingProximityBand
    public let trend: TrackingSignalTrend
}

public struct TrackingSignalSmoother: Sendable {
    private let medianWindowSize: Int
    private let alpha: Double
    private let trendWindowSeconds: TimeInterval
    private var window: [Int] = []
    private var ema: Double?
    private var trendSamples: [(Date, Double)] = []

    public init(
        medianWindowSize: Int = 5,
        alpha: Double = 0.25,
        trendWindowSeconds: TimeInterval = 4
    ) {
        self.medianWindowSize = max(1, medianWindowSize)
        self.alpha = min(1, max(0.01, alpha))
        self.trendWindowSeconds = max(1, trendWindowSeconds)
    }

    public mutating func add(rssi: Int, at date: Date = Date()) -> TrackingProximityReading {
        window.append(rssi)
        if window.count > medianWindowSize {
            window.removeFirst(window.count - medianWindowSize)
        }
        let ordered = window.sorted()
        let middle = ordered.count / 2
        let median = ordered.count.isMultiple(of: 2)
            ? Double(ordered[middle - 1] + ordered[middle]) / 2
            : Double(ordered[middle])
        let smoothed = ema.map { alpha * median + (1 - alpha) * $0 } ?? median
        ema = smoothed

        trendSamples.append((date, smoothed))
        trendSamples.removeAll { date.timeIntervalSince($0.0) > trendWindowSeconds }
        let change = smoothed - (trendSamples.first?.1 ?? smoothed)
        let trend: TrackingSignalTrend = change > 2
            ? .gettingCloser
            : change < -2 ? .gettingFarther : .steady
        return TrackingProximityReading(
            rawRSSI: rssi,
            medianRSSI: median,
            smoothedRSSI: smoothed,
            band: .classify(rssi: smoothed),
            trend: trend
        )
    }

    public mutating func reset() {
        window.removeAll(keepingCapacity: true)
        trendSamples.removeAll(keepingCapacity: true)
        ema = nil
    }
}
