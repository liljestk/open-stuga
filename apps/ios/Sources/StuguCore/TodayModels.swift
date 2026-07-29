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
        case monitoring
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
}
