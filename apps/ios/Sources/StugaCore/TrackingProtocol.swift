import Foundation

public struct ParsedTrackingAdvertisement: Equatable, Sendable {
    public static let byteCount = 18

    public let protocolVersion: Int
    public let flags: Int
    public let rotatingTagId: String
    public let epochCounter: Int
    public let eventCounter: Int
    public let batteryPercent: Int?
    public let authenticator: String
    public let rawPayload: String

    public var isMoving: Bool { flags & (1 << 0) != 0 }
    public var isLowBattery: Bool { flags & (1 << 1) != 0 }
    public var isSearchMode: Bool { flags & (1 << 3) != 0 }
}

public enum TrackingAdvertisementParser {
    public enum ParseError: LocalizedError, Equatable {
        case invalidLength
        case invalidBattery
        case unsupportedProtocol

        public var errorDescription: String? {
            switch self {
            case .invalidLength:
                "The BLE advertisement does not contain a complete Stuga tracking payload."
            case .invalidBattery:
                "The BLE advertisement contains an invalid battery value."
            case .unsupportedProtocol:
                "The BLE advertisement uses an unsupported Stuga tracking protocol."
            }
        }
    }

    public static func parse(_ data: Data, supportedVersions: Set<Int> = [1]) throws
        -> ParsedTrackingAdvertisement {
        guard data.count == ParsedTrackingAdvertisement.byteCount else {
            throw ParseError.invalidLength
        }
        let bytes = [UInt8](data)
        let header = Int(bytes[0])
        let protocolVersion = header >> 6
        guard supportedVersions.contains(protocolVersion) else {
            throw ParseError.unsupportedProtocol
        }
        let battery = Int(bytes[13])
        guard battery <= 100 || battery == 0xff else {
            throw ParseError.invalidBattery
        }
        return ParsedTrackingAdvertisement(
            protocolVersion: protocolVersion,
            flags: header & 0x3f,
            rotatingTagId: Data(bytes[1..<9]).base64URLEncodedString(),
            epochCounter: Int(bytes[9]) << 8 | Int(bytes[10]),
            eventCounter: Int(bytes[11]) << 8 | Int(bytes[12]),
            batteryPercent: battery == 0xff ? nil : battery,
            authenticator: Data(bytes[14..<18]).base64URLEncodedString(),
            rawPayload: data.base64URLEncodedString()
        )
    }
}

public extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
