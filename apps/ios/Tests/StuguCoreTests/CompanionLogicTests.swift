import XCTest
@testable import StuguCore

final class CompanionLogicTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testFreshnessUsesTheServerMonitoringWindow() {
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-60), now: now), .live)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-600), now: now), .aging)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-1_000), now: now), .stale)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: nil, now: now), .missing)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(600), now: now), .stale)
    }

    func testCriticalAlertLeadsTheHomeSummary() {
        let alert = AlertEvent(
            id: "alert-1",
            ruleId: "rule-1",
            sensorId: "sensor-1",
            metric: "humidity",
            value: 82,
            threshold: 70,
            severity: "critical",
            startedAt: "2027-01-15T08:00:00Z",
            acknowledgedAt: nil,
            resolvedAt: nil
        )
        let result = HomeMonitorSummary.evaluate(conditions: [], alerts: [alert], now: now)
        XCTAssertEqual(result.state, .critical)
    }

    func testNoSensorsNeverProducesAnAllClear() {
        let result = HomeMonitorSummary.evaluate(conditions: [], alerts: [], now: now)
        XCTAssertEqual(result.state, .limited)
    }

    func testBatteryOnlyTelemetryIsNotProofOfIndoorConditions() {
        let sensor = Sensor(
            id: "sensor-1",
            houseId: "home-1",
            floorId: "ground",
            name: "Hall",
            roomId: "hall",
            room: "Hall",
            model: "T315",
            enabled: true
        )
        let sample = MeasurementSample(
            sensorId: sensor.id,
            metric: "battery",
            value: 92,
            canonicalUnit: "%",
            timestamp: "2027-01-15T08:00:00Z",
            source: "tp-link",
            quality: "good"
        )
        let result = HomeMonitorSummary.evaluate(
            conditions: [SensorCondition(sensor: sensor, measurements: ["battery": sample])],
            alerts: [],
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )
        XCTAssertEqual(result.state, .limited)
    }

    func testEstimatedEnvironmentalSampleDoesNotProduceAnAllClear() {
        let sensor = Sensor(
            id: "sensor-1",
            houseId: "home-1",
            floorId: "ground",
            name: "Hall",
            roomId: "hall",
            room: "Hall",
            model: "T315",
            enabled: true
        )
        let sample = MeasurementSample(
            sensorId: sensor.id,
            metric: "temperature",
            value: 21.5,
            canonicalUnit: "°C",
            timestamp: "2027-01-15T08:00:00Z",
            source: "home-assistant",
            quality: "estimated"
        )
        let result = HomeMonitorSummary.evaluate(
            conditions: [SensorCondition(sensor: sensor, measurements: ["temperature": sample])],
            alerts: [],
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )
        XCTAssertEqual(result.state, .limited)
    }

    func testMetricOrderKeepsCommonHomeValuesFirst() {
        XCTAssertEqual(
            MetricOrder.sort(["custom", "battery", "temperature", "co2", "humidity"]),
            ["temperature", "humidity", "co2", "battery", "custom"]
        )
    }

    func testImperialDisplayConvertsOnlyTemperature() {
        // The formatter is deliberately locale-aware, so the expected decimal
        // separator has to come from the running locale rather than a literal.
        let expectedFahrenheit = 68.0.formatted(.number.precision(.fractionLength(1)))
        XCTAssertEqual(
            MetricValueFormatter.text(
                value: 20,
                precision: 1,
                unit: "°C",
                metric: "temperature",
                units: .imperial
            ),
            "\(expectedFahrenheit) °F"
        )
        XCTAssertEqual(
            MetricValueFormatter.text(
                value: 65,
                precision: 0,
                unit: "%",
                metric: "humidity",
                units: .imperial
            ),
            "65 %"
        )
    }
}
