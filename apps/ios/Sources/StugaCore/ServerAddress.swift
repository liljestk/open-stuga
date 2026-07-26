import Foundation

public struct ServerAddress: Equatable, Hashable, Sendable {
    public enum ValidationError: LocalizedError, Equatable {
        case empty
        case invalid
        case unsupportedScheme
        case credentialsNotAllowed
        case publicHTTPNotAllowed
        case unsupportedPath

        public var errorDescription: String? {
            switch self {
            case .empty:
                return "Enter the address of your Stuga server."
            case .invalid:
                return "This does not look like a valid server address."
            case .unsupportedScheme:
                return "Use an HTTPS address, or HTTP on a trusted local network."
            case .credentialsNotAllowed:
                return "Remove the username or password from the server address."
            case .publicHTTPNotAllowed:
                return "Public Stuga addresses must use HTTPS."
            case .unsupportedPath:
                return "Use the Stuga server address without an extra path."
            }
        }
    }

    public let origin: URL

    public init(_ input: String) throws {
        var candidate = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { throw ValidationError.empty }

        if !candidate.contains("://") {
            candidate = "https://\(candidate)"
        }
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            throw ValidationError.invalid
        }
        guard scheme == "https" || scheme == "http" else {
            throw ValidationError.unsupportedScheme
        }
        guard components.user == nil, components.password == nil else {
            throw ValidationError.credentialsNotAllowed
        }
        guard components.query == nil, components.fragment == nil else {
            throw ValidationError.unsupportedPath
        }
        if scheme == "http" && !Self.isLocalHost(host) {
            throw ValidationError.publicHTTPNotAllowed
        }

        let normalizedPath = components.percentEncodedPath
        if normalizedPath == "/api/v1" || normalizedPath == "/api/v2" || normalizedPath == "/api" {
            components.path = ""
        } else if !normalizedPath.isEmpty && normalizedPath != "/" {
            throw ValidationError.unsupportedPath
        } else {
            components.path = ""
        }
        components.query = nil
        components.fragment = nil

        guard let url = components.url else { throw ValidationError.invalid }
        origin = url
    }

    public var displayName: String {
        origin.host ?? origin.absoluteString
    }

    public func apiURL(version: Int = 1, path: String) -> URL {
        precondition(path.hasPrefix("/") && !path.hasPrefix("//"), "API paths must be root-relative")
        let pieces = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = "/api/v\(version)\(pieces[0])"
        components.percentEncodedQuery = pieces.count == 2 ? String(pieces[1]) : nil
        return components.url!
    }

    public func webURL() -> URL {
        origin
    }

    public static func isLocalHost(_ host: String) -> Bool {
        let value = host
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            .lowercased()
        if value == "localhost" || value == "::1" || value.hasSuffix(".localhost")
            || value.hasSuffix(".local") || value == "home.arpa"
            || value.hasSuffix(".home.arpa") || value.hasSuffix(".lan") {
            return true
        }
        if value.hasPrefix("fc") || value.hasPrefix("fd") || value.hasPrefix("fe80:") {
            return value.contains(":")
        }

        let octets = value.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4,
              let first = Int(octets[0]), let second = Int(octets[1]),
              octets.allSatisfy({ part in
                  guard let number = Int(part) else { return false }
                  return number >= 0 && number <= 255
              }) else {
            return false
        }
        return first == 10
            || first == 127
            || (first == 169 && second == 254)
            || (first == 172 && (16...31).contains(second))
            || (first == 192 && second == 168)
    }
}
