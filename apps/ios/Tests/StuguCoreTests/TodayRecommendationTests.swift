import XCTest
@testable import StuguCore

final class TodayRecommendationTests: XCTestCase {
    func testMapsTheTopServerInsightWithoutRecomputingIt() throws {
        let response = try monitoringResponse()
        let result = TodayRecommendation.from(server: response)

        XCTAssertEqual(result?.kind, .monitoring)
        XCTAssertEqual(result?.title, "Humidity is elevated in Kitchen")
        XCTAssertEqual(result?.detail, "The latest relative humidity is 72%.")
        XCTAssertEqual(
            result?.evidence,
            "Inspect the room and ventilate when appropriate."
        )
    }

    func testNoServerInsightProducesNoTodayRecommendation() throws {
        XCTAssertNil(
            TodayRecommendation.from(
                server: try monitoringResponse(pulseStatus: "steady", insightKind: nil)
            )
        )
    }

    func testUnknownFutureInsightKindUsesServerFallbackCopy() throws {
        let result = TodayRecommendation.from(
            server: try monitoringResponse(insightKind: "future-condition")
        )
        XCTAssertEqual(result?.title, "Humidity is elevated in Kitchen")
        XCTAssertEqual(result?.kind, .monitoring)
    }

    func testHomeMonitoringRequiresTheVersionThatIntroducedTheEndpoint() {
        XCTAssertFalse(ServerFeatureSupport.homeMonitoring(systemVersion: nil))
        XCTAssertFalse(ServerFeatureSupport.homeMonitoring(systemVersion: "0.19.10"))
        XCTAssertTrue(ServerFeatureSupport.homeMonitoring(systemVersion: "0.20.0"))
        XCTAssertTrue(ServerFeatureSupport.homeMonitoring(systemVersion: "v1.2.3"))
        XCTAssertFalse(ServerFeatureSupport.homeMonitoring(systemVersion: "not-a-version"))
    }
}
