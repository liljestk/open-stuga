import Foundation

/// A Cloudflare Access service token, used when the Stugu origin sits behind an
/// Access application that would otherwise demand an interactive browser login.
public struct EdgeCredential: Equatable, Hashable, Sendable, Codable {
    public enum ValidationError: LocalizedError, Equatable {
        case incomplete
        case invalidClientID

        public var errorDescription: String? {
            switch self {
            case .incomplete:
                return "Enter both the Access client ID and client secret, or leave both empty."
            case .invalidClientID:
                return "A Cloudflare Access client ID ends in .access."
            }
        }
    }

    public static let clientIDHeader = "CF-Access-Client-Id"
    public static let clientSecretHeader = "CF-Access-Client-Secret"

    public let clientID: String
    public let clientSecret: String

    public init(clientID: String, clientSecret: String) throws {
        let id = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !secret.isEmpty else { throw ValidationError.incomplete }
        guard id.hasSuffix(".access") else { throw ValidationError.invalidClientID }
        self.clientID = id
        self.clientSecret = secret
    }

    /// Returns `nil` when both fields are blank, so an untouched pair of form
    /// fields means "no service token" rather than an error.
    public static func optional(clientID: String, clientSecret: String) throws -> EdgeCredential? {
        let id = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty && secret.isEmpty { return nil }
        return try EdgeCredential(clientID: id, clientSecret: secret)
    }
}
