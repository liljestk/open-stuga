import XCTest
@testable import StuguCore

final class CompanionLogicTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testFreshnessUsesTheDisplayWindow() {
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-60), now: now), .live)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-600), now: now), .aging)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(-1_000), now: now), .stale)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: nil, now: now), .missing)
        XCTAssertEqual(ReadingFreshness.evaluate(sampleDate: now.addingTimeInterval(600), now: now), .stale)
    }

    func testHomeSummaryMapsServerPulseAndCopy() throws {
        let result = HomeMonitorSummary.from(server: try monitoringResponse())
        XCTAssertEqual(result.state, .attention)
        XCTAssertEqual(result.title, "Humidity is elevated in Kitchen")
    }

    func testSteadyServerPulseProducesBalancedSummary() throws {
        let result = HomeMonitorSummary.from(
            server: try monitoringResponse(pulseStatus: "steady", insightKind: nil)
        )
        XCTAssertEqual(result.state, .balanced)
    }

    func testMetricOrderKeepsCommonHomeValuesFirst() {
        XCTAssertEqual(
            MetricOrder.sort(["custom", "battery", "temperature", "co2", "humidity"]),
            ["temperature", "humidity", "co2", "battery", "custom"]
        )
    }

    func testAbsoluteTimesUseTwentyFourHourClock() throws {
        let timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
        let late = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T23:05:06Z"))
        let midnight = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T00:05:06Z"))

        XCTAssertEqual(StuguDateParser.time(from: late, timeZone: timeZone), "23:05")
        XCTAssertEqual(StuguDateParser.time(from: midnight, timeZone: timeZone), "00:05")
        XCTAssertTrue(
            StuguDateParser.dateTime(
                from: late,
                includesSeconds: true,
                timeZone: timeZone
            ).hasSuffix("23:05:06")
        )
    }

    func testImperialDisplayConvertsOnlyTemperature() {
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

    func testContactHistoryUsesSeedStateAndBoundsConfirmedOpenTime() throws {
        let from = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T08:00:00Z"))
        let to = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T10:00:00Z"))
        let observations = [
            opening("seed", state: .closed, at: "2026-07-28T07:55:00Z"),
            opening("opened", state: .open, at: "2026-07-28T08:15:00Z"),
            opening("closed", state: .closed, at: "2026-07-28T08:45:00Z"),
        ]

        let summary = ContactHistoryAnalyzer.analyze(
            observations,
            deviceId: "contact-1",
            connectionId: "connection-1",
            floorId: "ground",
            elementId: "door-1",
            invert: false,
            staleAfterSeconds: 900,
            from: from,
            to: to
        )

        XCTAssertEqual(summary.openingCount, 1)
        XCTAssertEqual(summary.closingCount, 1)
        XCTAssertEqual(summary.confirmedOpenDuration, 15 * 60)
        XCTAssertEqual(summary.currentState, .unknown)
        XCTAssertEqual(summary.transitions.map(\.kind), [.opened, .closed])
    }

    func testContactHistoryAppliesInvertedOpeningBinding() throws {
        let from = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T08:00:00Z"))
        let to = try XCTUnwrap(StuguDateParser.date(from: "2026-07-28T08:20:00Z"))
        let observations = [
            opening("raw-open", state: .open, at: "2026-07-28T08:05:00Z"),
            opening("raw-closed", state: .closed, at: "2026-07-28T08:10:00Z"),
            opening("heartbeat", state: .closed, at: "2026-07-28T08:19:00Z"),
        ]

        let summary = ContactHistoryAnalyzer.analyze(
            observations,
            deviceId: "contact-1",
            connectionId: "connection-1",
            floorId: "ground",
            elementId: "door-1",
            invert: true,
            staleAfterSeconds: 900,
            from: from,
            to: to
        )

        XCTAssertEqual(summary.openingCount, 1)
        XCTAssertEqual(summary.currentState, .open)
    }

    private func opening(
        _ id: String,
        state: StuguOpeningState,
        at: String
    ) -> OpeningStateObservation {
        OpeningStateObservation(
            id: id,
            houseId: "home-1",
            floorId: "ground",
            elementId: "door-1",
            state: state,
            openFraction: nil,
            source: "tapo",
            observedAt: at,
            validUntil: nil,
            externalId: "contact-1",
            connectionId: "connection-1"
        )
    }
}
