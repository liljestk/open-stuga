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

    func testServiceTokenRedirectsStayOnTheExactHTTPSOrigin() throws {
        var request = URLRequest(
            url: try XCTUnwrap(URL(string: "https://stugu.example.com/api/v1/session"))
        )
        request.setValue("client-id", forHTTPHeaderField: EdgeCredential.clientIDHeader)
        request.setValue("secret", forHTTPHeaderField: EdgeCredential.clientSecretHeader)

        XCTAssertTrue(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "https://stugu.example.com:443/api/v1/session")
        ))
        XCTAssertFalse(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "http://stugu.example.com/api/v1/session")
        ))
        XCTAssertFalse(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "https://stugu.example.com:8443/api/v1/session")
        ))
        XCTAssertFalse(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "https://login.example.com/")
        ))
    }

    func testLocalRedirectWithoutAServiceTokenMayStayOnItsHTTPOrigin() throws {
        let request = URLRequest(
            url: try XCTUnwrap(URL(string: "http://stugu.local:8080/api/v1/session"))
        )
        XCTAssertTrue(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "http://stugu.local:8080/api/v1/health")
        ))
        XCTAssertFalse(SameOriginRedirectGuard.allowsRedirect(
            originalRequest: request,
            destination: URL(string: "http://stugu.local:8081/api/v1/health")
        ))
    }
}
