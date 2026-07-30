import XCTest
@testable import StuguCore

final class ServerAddressTests: XCTestCase {
    func testBarePublicHostDefaultsToHTTPS() throws {
        let address = try ServerAddress("stugu.example.com")
        XCTAssertEqual(address.origin.absoluteString, "https://stugu.example.com")
    }

    func testAllowsPlainHTTPOnlyForLocalNetworks() throws {
        XCTAssertEqual(
            try ServerAddress("http://stugu.local:8080").origin.absoluteString,
            "http://stugu.local:8080"
        )
        XCTAssertEqual(
            try ServerAddress("http://192.168.1.20").origin.absoluteString,
            "http://192.168.1.20"
        )
        XCTAssertThrowsError(try ServerAddress("http://stugu.example.com")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .publicHTTPNotAllowed)
        }
    }

    func testNormalizesPastedAPIAddress() throws {
        let address = try ServerAddress("https://stugu.example.com/api/v1")
        XCTAssertEqual(address.origin.absoluteString, "https://stugu.example.com")
        XCTAssertEqual(
            address.apiURL(version: 2, path: "/measurements/snapshot?houseId=home%2Fone").absoluteString,
            "https://stugu.example.com/api/v2/measurements/snapshot?houseId=home%2Fone"
        )
    }

    func testRejectsCredentialsAndUnexpectedPaths() {
        XCTAssertThrowsError(try ServerAddress("https://owner:secret@stugu.example.com")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .credentialsNotAllowed)
        }
        XCTAssertThrowsError(try ServerAddress("https://stugu.example.com/nested")) {
            XCTAssertEqual($0 as? ServerAddress.ValidationError, .unsupportedPath)
        }
    }

    func testHTTPOriginNormalizesDefaultPortsWithoutWeakeningOriginChecks() throws {
        XCTAssertEqual(
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com/home"))),
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com:443/api")))
        )
        XCTAssertNotEqual(
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com"))),
            HTTPOrigin(try XCTUnwrap(URL(string: "http://stugu.example.com")))
        )
        XCTAssertNotEqual(
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com"))),
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com:8443")))
        )
        XCTAssertNotEqual(
            HTTPOrigin(try XCTUnwrap(URL(string: "https://stugu.example.com"))),
            HTTPOrigin(try XCTUnwrap(URL(string: "https://login.example.com")))
        )
    }
}
