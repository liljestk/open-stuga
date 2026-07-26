import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import StuguCore

final class APIClientTests: XCTestCase {
    func testClearCookiesIncludesTheAPICookiePath() async throws {
        let address = try ServerAddress("https://stugu-cookie-test.invalid")
        let storage = HTTPCookieStorage.shared
        let apiURL = address.apiURL(version: 1, path: "/session")
        storage.cookies(for: apiURL)?.forEach(storage.deleteCookie)

        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "stugu-cookie-test.invalid",
            .path: "/api",
            .name: "stuga_session",
            .value: "secret",
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(3_600),
        ]))
        storage.setCookie(cookie)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = storage
        let client = StuguAPIClient(
            address: address,
            session: URLSession(configuration: configuration)
        )

        XCTAssertEqual(storage.cookies(for: apiURL)?.map(\.name), ["stuga_session"])
        await client.clearCookies()
        XCTAssertTrue(storage.cookies(for: apiURL)?.isEmpty ?? true)
    }
}
