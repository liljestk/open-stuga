import XCTest
@testable import StugaCore

final class ServerAddressTests: XCTestCase {
    func testBarePublicHostDefaultsToHTTPS() throws {
        let address = try ServerAddress("stuga.example.com")
        XCTAssertEqual(address.origin.absoluteString, "https://stuga.example.com")
    }

    func testAllowsPlainHTTPOnlyForLocalNetworks() throws {
        XCTAssertEqual(
            try ServerAddress("http://stuga.local:8080").origin.absoluteString,
            "http://stuga.local:8080"
        )
        XCTAssertEqual(
            try ServerAddress("http://192.168.1.20").origin.absoluteString,
            "http://192.168.1.20"
        )
        XCTAssertThrowsError(try ServerAddress("http://stuga.example.com")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .publicHTTPNotAllowed)
        }
    }

    func testNormalizesPastedAPIAddress() throws {
        let address = try ServerAddress("https://stuga.example.com/api/v1")
        XCTAssertEqual(address.origin.absoluteString, "https://stuga.example.com")
        XCTAssertEqual(
            address.apiURL(version: 2, path: "/measurements/snapshot?houseId=home%2Fone").absoluteString,
            "https://stuga.example.com/api/v2/measurements/snapshot?houseId=home%2Fone"
        )
    }

    func testRejectsCredentialsAndUnexpectedPaths() {
        XCTAssertThrowsError(try ServerAddress("https://owner:secret@stuga.example.com")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .credentialsNotAllowed)
        }
        XCTAssertThrowsError(try ServerAddress("https://stuga.example.com/nested")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .unsupportedPath)
        }
    }
}
