import Foundation
import XCTest
@testable import StugaCore

final class TodayRecommendationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testVentilationRequiresMeaningfullyDrierFreshOutdoorAir() {
        let result = TodayRecommendation.evaluate(
            conditions: [condition(temperature: 22, humidity: 72)],
            context: TodayContext(weather: HouseWeatherSummary(
                houseId: "home-1",
                provider: "fmi",
                attribution: "FMI",
                fetchedAt: "2027-01-15T08:00:00Z",
                stale: false,
                current: OutdoorConditionsSummary(
                    timestamp: "2027-01-15T08:00:00Z",
                    temperatureC: 5,
                    dewPointC: 1,
                    relativeHumidityPercent: 75
                ),
                warnings: []
            )),
            now: now
        )
        XCTAssertEqual(result?.kind, .ventilation)
    }

    func testStaleWeatherNeverProducesVentilationAdvice() {
        let result = TodayRecommendation.evaluate(
            conditions: [condition(temperature: 22, humidity: 72)],
            context: TodayContext(weather: HouseWeatherSummary(
                houseId: "home-1",
                provider: "fmi",
                attribution: "FMI",
                fetchedAt: "2027-01-15T08:00:00Z",
                stale: true,
                current: OutdoorConditionsSummary(
                    timestamp: "2027-01-15T08:00:00Z",
                    temperatureC: 5,
                    dewPointC: 1
                ),
                warnings: []
            )),
            now: now
        )
        XCTAssertNil(result)
    }

    func testStaleIndoorReadingsNeverProduceVentilationAdvice() {
        let result = TodayRecommendation.evaluate(
            conditions: [
                condition(
                    temperature: 22,
                    humidity: 72,
                    timestamp: "2026-01-15T08:00:00Z"
                ),
            ],
            context: TodayContext(weather: HouseWeatherSummary(
                houseId: "home-1",
                provider: "fmi",
                attribution: "FMI",
                fetchedAt: "2027-01-15T08:00:00Z",
                stale: false,
                current: OutdoorConditionsSummary(
                    timestamp: "2027-01-15T08:00:00Z",
                    temperatureC: 5,
                    dewPointC: 1
                ),
                warnings: []
            )),
            now: now
        )
        XCTAssertNil(result)
    }

    func testSevereWeatherWarningOutranksEnergyAdvice() {
        let context = TodayContext(
            weather: HouseWeatherSummary(
                houseId: "home-1",
                provider: "fmi",
                attribution: "FMI",
                fetchedAt: "2027-01-15T08:00:00Z",
                stale: false,
                current: nil,
                warnings: [
                    WeatherWarningSummary(
                        id: "warning-1",
                        headline: "Severe wind warning",
                        severity: "severe",
                        expiresAt: "2030-01-15T12:00:00Z"
                    ),
                ]
            ),
            energy: EnergyOptimizationSummary(
                propertyId: "property-1",
                generatedAt: "2027-01-15T08:00:00Z",
                currentPriceCentsPerKwh: 8,
                suggestedWindows: [
                    EnergyOptimizationWindow(
                        startAt: "2027-01-15T09:00:00Z",
                        endAt: "2027-01-15T11:00:00Z",
                        averagePriceCentsPerKwh: 5,
                        relativeToAveragePercent: -30,
                        rank: "best"
                    ),
                ],
                insights: [],
                limitations: []
            )
        )
        XCTAssertEqual(
            TodayRecommendation.evaluate(conditions: [], context: context, now: now)?.kind,
            .weatherWarning
        )
    }

    private func condition(
        temperature: Double,
        humidity: Double,
        timestamp: String = "2027-01-15T08:00:00Z"
    ) -> SensorCondition {
        let sensor = Sensor(
            id: "sensor-1",
            houseId: "home-1",
            floorId: "ground",
            name: "Bathroom",
            roomId: "bathroom",
            room: "Bathroom",
            model: "T315",
            enabled: true
        )
        return SensorCondition(sensor: sensor, measurements: [
            "temperature": MeasurementSample(
                sensorId: sensor.id,
                metric: "temperature",
                value: temperature,
                canonicalUnit: "°C",
                timestamp: timestamp,
                source: "tp-link",
                quality: "good"
            ),
            "humidity": MeasurementSample(
                sensorId: sensor.id,
                metric: "humidity",
                value: humidity,
                canonicalUnit: "%",
                timestamp: timestamp,
                source: "tp-link",
                quality: "good"
            ),
        ])
    }
}
