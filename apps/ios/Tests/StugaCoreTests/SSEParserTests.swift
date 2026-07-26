import XCTest
@testable import StugaCore

final class SSEParserTests: XCTestCase {
    func testParsesNamedMultilineEvent() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(line: "id: weather-12"))
        XCTAssertNil(parser.consume(line: "event: weather"))
        XCTAssertNil(parser.consume(line: "data: {\"status\":\"partial\","))
        XCTAssertNil(parser.consume(line: "data: \"stale\":false}"))
        XCTAssertEqual(
            parser.consume(line: ""),
            ServerEvent(
                id: "weather-12",
                type: "weather",
                data: "{\"status\":\"partial\",\n\"stale\":false}"
            )
        )
    }

    func testIgnoresHeartbeatCommentsAndResetsFields() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(line: ": heartbeat"))
        XCTAssertNil(parser.consume(line: ""))
        XCTAssertNil(parser.consume(line: "data: next"))
        XCTAssertEqual(
            parser.consume(line: ""),
            ServerEvent(id: nil, type: "message", data: "next")
        )
    }
}
