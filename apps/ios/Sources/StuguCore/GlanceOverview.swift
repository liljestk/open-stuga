import Foundation

public enum GlanceOverviewScope: String, CaseIterable, Codable, Sendable {
    case home
    case property
}

public enum GlanceOverviewMetric: String, CaseIterable, Codable, Sendable {
    case temperature
    case humidity
    case power
    case co2
}

public struct GlanceOverviewSummary: Equatable, Sendable {
    public let metric: GlanceOverviewMetric
    public let value: Double?
    public let sampleCount: Int
    public let latestAt: Date?

    public init(
        metric: GlanceOverviewMetric,
        value: Double?,
        sampleCount: Int,
        latestAt: Date?
    ) {
        self.metric = metric
        self.value = value
        self.sampleCount = sampleCount
        self.latestAt = latestAt
    }
}

public enum GlanceOverviewAggregation {
    public static func summarize(
        _ metric: GlanceOverviewMetric,
        conditions: [SensorCondition],
        now: Date = Date()
    ) -> GlanceOverviewSummary {
        var samples = conditions.compactMap { condition -> (
            sensor: Sensor,
            sample: MeasurementSample
        )? in
            guard condition.sensor.enabled,
                  let sample = condition.measurements[metric.rawValue],
                  sample.quality != "stale",
                  [.live, .aging].contains(
                    ReadingFreshness.evaluate(sampleDate: sample.observedAt, now: now)
                  ),
                  sample.value.isFinite else {
                return nil
            }
            return (condition.sensor, sample)
        }

        if metric == .power {
            samples = Dictionary(grouping: samples) { $0.sensor.houseId }
                .values
                .flatMap { homeSamples in
                    let wholeHome = homeSamples.filter {
                        $0.sensor.energyMeterRole == "whole_home"
                    }
                    if !wholeHome.isEmpty { return wholeHome }
                    let standalone = homeSamples.filter {
                        $0.sensor.energyMeterRole != "submeter"
                    }
                    return standalone.isEmpty ? homeSamples : standalone
                }
        }

        guard !samples.isEmpty else {
            return GlanceOverviewSummary(
                metric: metric,
                value: nil,
                sampleCount: 0,
                latestAt: nil
            )
        }
        let total = samples.reduce(0) { $0 + $1.sample.value }
        let environmentalValue = Dictionary(grouping: samples) { $0.sensor.houseId }
            .values
            .map { homeSamples in
                homeSamples.reduce(0) { $0 + $1.sample.value }
                    / Double(homeSamples.count)
            }
            .reduce(0, +) / Double(Set(samples.map { $0.sensor.houseId }).count)
        return GlanceOverviewSummary(
            metric: metric,
            value: metric == .power ? total : environmentalValue,
            sampleCount: samples.count,
            latestAt: samples.compactMap { $0.sample.observedAt }.max()
        )
    }
}
