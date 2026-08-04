import XCTest
@testable import StuguCore

final class GlanceOverviewTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(
        from: "2026-08-04T10:00:00Z"
    )!

    func testEnvironmentalReadingsAreAveragedWithoutStaleEvidence() {
        let conditions = [
            condition(id: "one", metric: "temperature", value: 20),
            condition(id: "two", metric: "temperature", value: 22),
            condition(id: "stale", metric: "temperature", value: 35, quality: "stale"),
        ]
        let summary = GlanceOverviewAggregation.summarize(
            .temperature,
            conditions: conditions,
            now: now
        )
        XCTAssertEqual(summary.value, 21)
        XCTAssertEqual(summary.sampleCount, 2)
    }

    func testPropertyEnvironmentalAverageGivesEachHomeEqualWeight() {
        let conditions = [
            condition(id: "one", metric: "temperature", value: 20),
            condition(id: "two", metric: "temperature", value: 22),
            condition(
                id: "three",
                metric: "temperature",
                value: 30,
                homeID: "home-two"
            ),
        ]
        let summary = GlanceOverviewAggregation.summarize(
            .temperature,
            conditions: conditions,
            now: now
        )
        XCTAssertEqual(summary.value, 25.5)
        XCTAssertEqual(summary.sampleCount, 3)
    }

    func testWholeHomePowerAvoidsDoubleCountingSubmeters() {
        let conditions = [
            condition(id: "main", metric: "power", value: 1_200, role: "whole_home"),
            condition(id: "heater", metric: "power", value: 800, role: "submeter"),
        ]
        let summary = GlanceOverviewAggregation.summarize(
            .power,
            conditions: conditions,
            now: now
        )
        XCTAssertEqual(summary.value, 1_200)
        XCTAssertEqual(summary.sampleCount, 1)
    }

    func testPropertyPowerSelectsSourcesIndependentlyForEachHome() {
        let conditions = [
            condition(
                id: "main",
                metric: "power",
                value: 1_200,
                role: "whole_home"
            ),
            condition(
                id: "heater",
                metric: "power",
                value: 800,
                role: "submeter"
            ),
            condition(
                id: "cottage",
                metric: "power",
                value: 300,
                homeID: "home-two"
            ),
        ]
        let summary = GlanceOverviewAggregation.summarize(
            .power,
            conditions: conditions,
            now: now
        )
        XCTAssertEqual(summary.value, 1_500)
        XCTAssertEqual(summary.sampleCount, 2)
    }

    private func condition(
        id: String,
        metric: String,
        value: Double,
        quality: String = "good",
        role: String? = nil,
        homeID: String = "home-one"
    ) -> SensorCondition {
        let sensor = Sensor(
            id: id,
            houseId: homeID,
            floorId: "floor-one",
            name: id,
            roomId: "room-one",
            room: "Living room",
            model: "test",
            enabled: true,
            energyMeterRole: role
        )
        let sample = MeasurementSample(
            sensorId: id,
            metric: metric,
            value: value,
            canonicalUnit: metric == "power" ? "W" : "°C",
            timestamp: "2026-08-04T09:58:00.000Z",
            source: "api",
            quality: quality
        )
        return SensorCondition(sensor: sensor, measurements: [metric: sample])
    }
}
