import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import StugaCore

final class EdgeCredentialTests: XCTestCase {
    func testTrimsAndAcceptsAServiceToken() throws {
        let credential = try EdgeCredential(
            clientID: "  0123abc.access\n",
            clientSecret: " s3cret "
        )
        XCTAssertEqual(credential.clientID, "0123abc.access")
        XCTAssertEqual(credential.clientSecret, "s3cret")
    }

    func testRejectsAClientIDThatIsNotAnAccessToken() {
        XCTAssertThrowsError(
            try EdgeCredential(clientID: "0123abc", clientSecret: "s3cret")
        ) { error in
            XCTAssertEqual(error as? EdgeCredential.ValidationError, .invalidClientID)
        }
    }

    func testRejectsAHalfFilledPair() {
        XCTAssertThrowsError(
            try EdgeCredential.optional(clientID: "0123abc.access", clientSecret: "  ")
        ) { error in
            XCTAssertEqual(error as? EdgeCredential.ValidationError, .incomplete)
        }
    }

    func testBlankFieldsMeanNoServiceToken() throws {
        XCTAssertNil(try EdgeCredential.optional(clientID: "", clientSecret: " "))
    }

    func testHeadersAreSentOverHTTPS() throws {
        let credential = try EdgeCredential(clientID: "0123abc.access", clientSecret: "s3cret")
        var request = URLRequest(url: URL(string: "https://stuga.example.com/api/v1/health")!)
        StugaAPIClient.apply(credential, to: &request)
        XCTAssertEqual(
            request.value(forHTTPHeaderField: EdgeCredential.clientIDHeader),
            "0123abc.access"
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: EdgeCredential.clientSecretHeader),
            "s3cret"
        )
    }

    func testHeadersAreWithheldFromCleartextOrigins() throws {
        let credential = try EdgeCredential(clientID: "0123abc.access", clientSecret: "s3cret")
        var request = URLRequest(url: URL(string: "http://stuga.local/api/v1/health")!)
        StugaAPIClient.apply(credential, to: &request)
        XCTAssertNil(request.value(forHTTPHeaderField: EdgeCredential.clientIDHeader))
        XCTAssertNil(request.value(forHTTPHeaderField: EdgeCredential.clientSecretHeader))
    }

    func testAccessLoginPageIsReportedAsAMissingServiceToken() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://lively-wood-3eff.cloudflareaccess.com/cdn-cgi/access/login/stuga.example.com")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "text/html; charset=UTF-8"]
        ))
        let challenge = StugaAPIClient.edgeChallenge(response, hasCredential: false)
        XCTAssertEqual(challenge?.code, "EDGE_ACCESS_REQUIRED")
    }

    func testAccessChallengeHeaderIsRecognisedOnTheStugaOrigin() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://stuga.example.com/api/v1/health")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: ["WWW-Authenticate": "Cloudflare-Access resource_metadata=\"https://stuga.example.com/.well-known\""]
        ))
        let challenge = StugaAPIClient.edgeChallenge(response, hasCredential: true)
        XCTAssertEqual(challenge?.code, "EDGE_ACCESS_REJECTED")
    }

    func testOrdinaryStugaResponsesAreNotTreatedAsChallenges() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://stuga.example.com/api/v1/health")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ))
        XCTAssertNil(StugaAPIClient.edgeChallenge(response, hasCredential: false))
    }

    func testRedirectToAnotherHostIsRefusedSoTheTokenStaysOnTheOrigin() async throws {
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(
            with: URL(string: "https://stuga.example.com/api/v1/health")!
        )
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://stuga.example.com/api/v1/health")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: [:]
        ))
        let offOrigin = URLRequest(
            url: URL(string: "https://team.cloudflareaccess.com/cdn-cgi/access/login")!
        )
        let sameOrigin = URLRequest(url: URL(string: "https://stuga.example.com/api/v1/health/")!)

        let refused = await withCheckedContinuation { continuation in
            SameHostRedirectGuard().urlSession(
                session,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: offOrigin
            ) { continuation.resume(returning: $0) }
        }
        XCTAssertNil(refused)

        let allowed = await withCheckedContinuation { continuation in
            SameHostRedirectGuard().urlSession(
                session,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: sameOrigin
            ) { continuation.resume(returning: $0) }
        }
        XCTAssertEqual(allowed?.url, sameOrigin.url)
    }

    func testAHostEndingInACloudflareLookalikeDomainIsNotAChallenge() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://notcloudflareaccess.com/api/v1/health")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: [:]
        ))
        XCTAssertNil(StugaAPIClient.edgeChallenge(response, hasCredential: false))
    }
}
