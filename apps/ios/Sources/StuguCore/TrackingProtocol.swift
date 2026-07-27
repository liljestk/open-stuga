import Foundation

/// Raw advertisements exist only in observer memory. They are never part of an upload model.
public struct TrackingLocalAdvertisementFrame: Equatable, Sendable {
    public let serviceUuids: [String]
    public let manufacturerData: [String: Data]
    public let serviceData: [String: Data]
    public let localName: String?
    public let peripheralIdentifier: String?
    public let address: String?
    public let connectable: Bool?
    public let rssi: Int
    public let observedAt: String

    public init(
        serviceUuids: [String],
        manufacturerData: [String: Data],
        serviceData: [String: Data],
        localName: String?,
        peripheralIdentifier: String?,
        address: String? = nil,
        connectable: Bool?,
        rssi: Int,
        observedAt: String
    ) {
        self.serviceUuids = serviceUuids
        self.manufacturerData = manufacturerData
        self.serviceData = serviceData
        self.localName = localName
        self.peripheralIdentifier = peripheralIdentifier
        self.address = address
        self.connectable = connectable
        self.rssi = rssi
        self.observedAt = observedAt
    }
}

public struct TrackingProfileMatch: Equatable, Sendable {
    public let profileId: String
    public let profileVersion: String
    public let identityFields: [String: String]
    public let canonicalIdentity: String?
    public let telemetry: [String: JSONValue]
}

public struct ResolvedTrackingAdvertisement: Equatable, Sendable {
    public let resolution: TrackingResolutionEntry
    public let match: TrackingProfileMatch

    public init(resolution: TrackingResolutionEntry, match: TrackingProfileMatch) {
        self.resolution = resolution
        self.match = match
    }
}

public enum TrackingAdvertisementParser {
    public static func matches(
        _ frame: TrackingLocalAdvertisementFrame,
        profiles: [TrackingProfile],
        includeEnrollmentProfiles: Bool = false
    ) -> [TrackingProfileMatch] {
        profiles.compactMap { profile in
            guard includeEnrollmentProfiles || !profile.match.isEmpty else { return nil }
            return parse(frame, profile: profile)
        }
    }

    public static func resolve(
        _ frame: TrackingLocalAdvertisementFrame,
        profiles: [TrackingProfile],
        entries: [TrackingResolutionEntry]
    ) -> ResolvedTrackingAdvertisement? {
        let candidates = matches(frame, profiles: profiles).flatMap { match in
            entries.compactMap { entry -> ResolvedTrackingAdvertisement? in
                guard entry.profileId == match.profileId,
                      entry.profileVersion == match.profileVersion,
                      entry.identityFields == match.identityFields else {
                    return nil
                }
                return ResolvedTrackingAdvertisement(resolution: entry, match: match)
            }
        }
        guard candidates.count == 1 else { return nil }
        return candidates[0]
    }

    public static func parse(
        _ frame: TrackingLocalAdvertisementFrame,
        profile: TrackingProfile
    ) -> TrackingProfileMatch? {
        guard validate(profile),
              profile.match.allSatisfy({ matchesRule($0, frame: frame) }) else {
            return nil
        }
        var parsed: [String: JSONValue] = [:]
        for field in profile.fields {
            guard let value = decode(field, frame: frame) else {
                if field.optional == true { continue }
                return nil
            }
            parsed[field.name] = scaled(value, by: field.scale)
        }
        var identityFields: [String: String] = [:]
        for name in profile.identity.fields {
            guard let value = parsed[name], let text = stringValue(value) else { return nil }
            identityFields[name] = text
        }
        let identityValues = profile.identity.fields.compactMap { identityFields[$0] }
        let canonicalIdentity = profile.identity.scope == "NONE" ? nil : [
            profile.identity.namespace,
            String(profile.identity.namespaceVersion),
            identityValues.joined(separator: profile.identity.separator ?? "\u{001f}"),
        ].joined(separator: "\u{001e}")
        let telemetry = parsed.filter { !profile.identity.fields.contains($0.key) }
        return TrackingProfileMatch(
            profileId: profile.id,
            profileVersion: profile.version,
            identityFields: identityFields,
            canonicalIdentity: canonicalIdentity,
            telemetry: telemetry
        )
    }

    private static func validate(_ profile: TrackingProfile) -> Bool {
        guard profile.schemaVersion == TrackingSchema.profileVersion,
              !profile.id.isEmpty,
              !profile.version.isEmpty,
              (1...512).contains(profile.maximumFrameBytes),
              profile.identity.namespaceVersion > 0 else {
            return false
        }
        let fieldNames = Set(profile.fields.map(\.name))
        guard fieldNames.count == profile.fields.count,
              profile.identity.fields.allSatisfy(fieldNames.contains) else {
            return false
        }
        return profile.fields.allSatisfy { field in
            let offset = field.offset ?? 0
            let length = field.length ?? 0
            let mapped = field.source == "manufacturerData" || field.source == "serviceData"
            return !field.name.isEmpty
                && offset >= 0
                && length >= 0
                && offset + length <= profile.maximumFrameBytes
                && (!mapped || field.key != nil)
        } && profile.match.allSatisfy { rule in
            guard Data(hexadecimal: rule.value) != nil,
                  (rule.offset ?? 0) >= 0 else {
                return false
            }
            if let mask = rule.mask {
                guard mask.count == rule.value.count, Data(hexadecimal: mask) != nil else {
                    return false
                }
            }
            let mapped = rule.source == "manufacturerData" || rule.source == "serviceData"
            return !mapped || rule.key != nil
        }
    }

    private static func matchesRule(
        _ rule: TrackingProfileMatchRule,
        frame: TrackingLocalAdvertisementFrame
    ) -> Bool {
        guard let source = ruleData(rule, frame: frame),
              let expected = Data(hexadecimal: rule.value) else {
            return false
        }
        let offset = rule.offset ?? 0
        guard offset >= 0, source.count >= offset + expected.count else { return false }
        let mask = rule.mask.flatMap { Data(hexadecimal: $0) }
        guard rule.mask == nil || mask?.count == expected.count else { return false }
        return expected.indices.allSatisfy { index in
            let bitmask = mask?[index] ?? 0xff
            return source[offset + index] & bitmask == expected[index] & bitmask
        }
    }

    private static func ruleData(
        _ rule: TrackingProfileMatchRule,
        frame: TrackingLocalAdvertisementFrame
    ) -> Data? {
        switch rule.source {
        case "manufacturerData":
            return mapped(frame.manufacturerData, key: rule.key)?.data
        case "serviceData":
            return mapped(frame.serviceData, key: rule.key)?.data
        case "localName":
            return frame.localName?.data(using: .utf8)
        default:
            return nil
        }
    }

    private static func decode(
        _ field: TrackingProfileField,
        frame: TrackingLocalAdvertisementFrame
    ) -> JSONValue? {
        let source: (key: String?, data: Data)?
        switch field.source {
        case "manufacturerData":
            source = mapped(frame.manufacturerData, key: field.key)
        case "serviceData":
            source = mapped(frame.serviceData, key: field.key)
        case "localName":
            source = frame.localName.map { (nil, Data($0.utf8)) }
        case "peripheralIdentifier":
            source = frame.peripheralIdentifier.map { (nil, Data($0.utf8)) }
        case "address":
            source = frame.address.map { (nil, Data($0.utf8)) }
        default:
            source = nil
        }
        guard let source else { return nil }
        if field.key == "*", field.encoding == "utf8", let key = source.key {
            return .string(key)
        }
        let offset = field.offset ?? 0
        let length = field.length ?? (source.data.count - offset)
        guard offset >= 0, length >= 0, source.data.count >= offset + length else {
            return nil
        }
        let bytes = source.data.subdata(in: offset..<(offset + length))
        switch field.encoding {
        case "hex":
            return .string(bytes.hexadecimalString)
        case "utf8":
            return String(data: bytes, encoding: .utf8).map(JSONValue.string)
        case "uint8":
            guard bytes.count == 1 else { return nil }
            return .number(Double(bytes[0]))
        case "int8":
            guard bytes.count == 1 else { return nil }
            return .number(Double(Int8(bitPattern: bytes[0])))
        case "uint16be":
            guard bytes.count == 2 else { return nil }
            return .number(Double(Int(bytes[0]) << 8 | Int(bytes[1])))
        case "uint16le":
            guard bytes.count == 2 else { return nil }
            return .number(Double(Int(bytes[0]) | Int(bytes[1]) << 8))
        case "uuid":
            guard bytes.count == 16 else { return nil }
            let value = bytes.hexadecimalString
            return .string(
                "\(value.prefix(8))-\(value.dropFirst(8).prefix(4))-"
                    + "\(value.dropFirst(12).prefix(4))-\(value.dropFirst(16).prefix(4))-"
                    + "\(value.dropFirst(20))"
            )
        default:
            return nil
        }
    }

    private static func mapped(
        _ values: [String: Data],
        key: String?
    ) -> (key: String?, data: Data)? {
        if key == "*" {
            guard values.count == 1, let item = values.first else { return nil }
            return (item.key, item.value)
        }
        guard let key else { return nil }
        let normalized = normalize(key)
        guard let item = values.first(where: { normalize($0.key) == normalized }) else {
            return nil
        }
        return (item.key, item.value)
    }

    private static func normalize(_ value: String) -> String {
        value.lowercased().filter(\.isHexDigit)
    }

    private static func scaled(_ value: JSONValue, by scale: Double?) -> JSONValue {
        guard let scale else { return value }
        if case let .number(number) = value { return .number(number * scale) }
        return value
    }

    private static func stringValue(_ value: JSONValue) -> String? {
        switch value {
        case let .string(text):
            return text
        case let .number(number):
            return number.rounded() == number ? String(Int(number)) : String(number)
        case let .bool(value):
            return String(value)
        case .null:
            return nil
        }
    }
}

private extension Data {
    init?(hexadecimal value: String) {
        guard value.count.isMultiple(of: 2), value.allSatisfy(\.isHexDigit) else { return nil }
        var output = Data()
        output.reserveCapacity(value.count / 2)
        var index = value.startIndex
        while index < value.endIndex {
            let end = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<end], radix: 16) else { return nil }
            output.append(byte)
            index = end
        }
        self = output
    }

    var hexadecimalString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
