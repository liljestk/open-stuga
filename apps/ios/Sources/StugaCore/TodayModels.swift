import Foundation

public struct OutdoorConditionsSummary: Codable, Equatable, Sendable {
    public let timestamp: String
    public let temperatureC: Double?
    public let dewPointC: Double?
    public let relativeHumidityPercent: Double?
    public let precipitationProbabilityPercent: Double?

    public init(
        timestamp: String,
        temperatureC: Double? = nil,
        dewPointC: Double? = nil,
        relativeHumidityPercent: Double? = nil,
        precipitationProbabilityPercent: Double? = nil
    ) {
        self.timestamp = timestamp
        self.temperatureC = temperatureC
        self.dewPointC = dewPointC
        self.relativeHumidityPercent = relativeHumidityPercent
        self.precipitationProbabilityPercent = precipitationProbabilityPercent
    }
}

public struct WeatherWarningSummary: Codable, Equatable, Sendable {
    public let id: String
    public let headline: String
    public let severity: String
    public let expiresAt: String?

    public init(id: String, headline: String, severity: String, expiresAt: String?) {
        self.id = id
        self.headline = headline
        self.severity = severity
        self.expiresAt = expiresAt
    }
}

public struct HouseWeatherSummary: Codable, Equatable, Sendable {
    public let houseId: String
    public let provider: String
    public let attribution: String
    public let fetchedAt: String
    public let stale: Bool
    public let current: OutdoorConditionsSummary?
    public let warnings: [WeatherWarningSummary]

    public init(
        houseId: String,
        provider: String,
        attribution: String,
        fetchedAt: String,
        stale: Bool,
        current: OutdoorConditionsSummary?,
        warnings: [WeatherWarningSummary]
    ) {
        self.houseId = houseId
        self.provider = provider
        self.attribution = attribution
        self.fetchedAt = fetchedAt
        self.stale = stale
        self.current = current
        self.warnings = warnings
    }
}

public struct EnergyOptimizationWindow: Codable, Equatable, Sendable {
    public let startAt: String
    public let endAt: String
    public let averagePriceCentsPerKwh: Double
    public let relativeToAveragePercent: Double
    public let rank: String

    public init(
        startAt: String,
        endAt: String,
        averagePriceCentsPerKwh: Double,
        relativeToAveragePercent: Double,
        rank: String
    ) {
        self.startAt = startAt
        self.endAt = endAt
        self.averagePriceCentsPerKwh = averagePriceCentsPerKwh
        self.relativeToAveragePercent = relativeToAveragePercent
        self.rank = rank
    }
}

public struct EnergyOptimizationInsightSummary: Codable, Equatable, Sendable {
    public let id: String
    public let severity: String
    public let title: String
    public let explanation: String
    public let estimatedSavingsEur: Double?

    public init(
        id: String,
        severity: String,
        title: String,
        explanation: String,
        estimatedSavingsEur: Double?
    ) {
        self.id = id
        self.severity = severity
        self.title = title
        self.explanation = explanation
        self.estimatedSavingsEur = estimatedSavingsEur
    }
}

public struct EnergyOptimizationSummary: Codable, Equatable, Sendable {
    public let propertyId: String
    public let generatedAt: String
    public let currentPriceCentsPerKwh: Double?
    public let suggestedWindows: [EnergyOptimizationWindow]
    public let insights: [EnergyOptimizationInsightSummary]
    public let limitations: [String]

    public init(
        propertyId: String,
        generatedAt: String,
        currentPriceCentsPerKwh: Double?,
        suggestedWindows: [EnergyOptimizationWindow],
        insights: [EnergyOptimizationInsightSummary],
        limitations: [String]
    ) {
        self.propertyId = propertyId
        self.generatedAt = generatedAt
        self.currentPriceCentsPerKwh = currentPriceCentsPerKwh
        self.suggestedWindows = suggestedWindows
        self.insights = insights
        self.limitations = limitations
    }
}

public struct TodayContext: Codable, Equatable, Sendable {
    public let weather: HouseWeatherSummary?
    public let energy: EnergyOptimizationSummary?

    public init(
        weather: HouseWeatherSummary? = nil,
        energy: EnergyOptimizationSummary? = nil
    ) {
        self.weather = weather
        self.energy = energy
    }
}

public struct TodayRecommendation: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case weatherWarning
        case ventilation
        case electricity
    }

    public let kind: Kind
    public let title: String
    public let detail: String
    public let evidence: String
    public let startsAt: Date?
    public let endsAt: Date?

    public init(
        kind: Kind,
        title: String,
        detail: String,
        evidence: String,
        startsAt: Date? = nil,
        endsAt: Date? = nil
    ) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.evidence = evidence
        self.startsAt = startsAt
        self.endsAt = endsAt
    }

    public static func evaluate(
        conditions: [SensorCondition],
        context: TodayContext?,
        now: Date = Date()
    ) -> TodayRecommendation? {
        if let warning = context?.weather?.warnings.first(where: {
            ["severe", "extreme"].contains($0.severity.lowercased())
                && ($0.expiresAt.flatMap { StugaDateParser.date(from: $0) } ?? .distantFuture) > now
        }) {
            return TodayRecommendation(
                kind: .weatherWarning,
                title: warning.headline,
                detail: "Review the official warning before planning outdoor work.",
                evidence: context?.weather?.attribution ?? "Official weather warning"
            )
        }

        if let weather = context?.weather,
           !weather.stale,
           let outdoor = weather.current,
           let outdoorDewPoint = outdoor.dewPointC
                ?? dewPoint(temperature: outdoor.temperatureC, humidity: outdoor.relativeHumidityPercent),
           let indoor = highestMoistureCondition(conditions, now: now),
           indoor.humidity >= 60,
           indoor.dewPoint - outdoorDewPoint >= 2 {
            return TodayRecommendation(
                kind: .ventilation,
                title: "Outdoor air is drier",
                detail: "A short ventilation period may help reduce indoor moisture.",
                evidence: String(
                    format: "Highest indoor humidity %.0f%%; indoor dew point %.1f°C and outdoor %.1f°C. %@.",
                    indoor.humidity,
                    indoor.dewPoint,
                    outdoorDewPoint,
                    weather.attribution
                )
            )
        }

        if let energy = context?.energy,
           let window = energy.suggestedWindows
                .filter({
                    $0.rank == "best"
                        && (StugaDateParser.date(from: $0.endAt) ?? .distantPast) > now
                        && $0.relativeToAveragePercent <= -5
                })
                .min(by: { $0.startAt < $1.startAt }),
           let startsAt = StugaDateParser.date(from: window.startAt),
           let endsAt = StugaDateParser.date(from: window.endAt) {
            return TodayRecommendation(
                kind: .electricity,
                title: startsAt <= now ? "A cheaper electricity window is active" : "A cheaper electricity window is coming",
                detail: "Consider moving flexible electricity use into this period.",
                evidence: String(
                    format: "%.2f c/kWh, %.0f%% below the available-period average. Read-only advice; Stuga controls nothing.",
                    window.averagePriceCentsPerKwh,
                    abs(window.relativeToAveragePercent)
                ),
                startsAt: startsAt,
                endsAt: endsAt
            )
        }

        return nil
    }

    private static func highestMoistureCondition(
        _ conditions: [SensorCondition],
        now: Date
    ) -> (humidity: Double, dewPoint: Double)? {
        conditions.compactMap { condition in
            guard let temperatureSample = condition.measurements["temperature"],
                  let humiditySample = condition.measurements["humidity"],
                  temperatureSample.quality == "good",
                  humiditySample.quality == "good",
                  [.live, .aging].contains(
                      ReadingFreshness.evaluate(
                          sampleDate: temperatureSample.observedAt,
                          now: now
                      )
                  ),
                  [.live, .aging].contains(
                      ReadingFreshness.evaluate(
                          sampleDate: humiditySample.observedAt,
                          now: now
                      )
                  ) else {
                return nil
            }
            let temperature = temperatureSample.value
            let humidity = humiditySample.value
            guard let dewPoint = dewPoint(temperature: temperature, humidity: humidity),
                  humidity >= 0,
                  humidity <= 100 else {
                return nil
            }
            return (humidity, dewPoint)
        }.max(by: { $0.humidity < $1.humidity })
    }

    private static func dewPoint(temperature: Double?, humidity: Double?) -> Double? {
        guard let temperature,
              let humidity,
              temperature.isFinite,
              humidity.isFinite,
              humidity > 0,
              humidity <= 100 else {
            return nil
        }
        let a = 17.62
        let b = 243.12
        let gamma = log(humidity / 100) + (a * temperature) / (b + temperature)
        return (b * gamma) / (a - gamma)
    }
}
