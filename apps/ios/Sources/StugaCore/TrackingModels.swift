import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct GeoCoordinate: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

public struct PropertyArea: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let name: String
    public let kind: String
    public let description: String?
    public let location: GeoCoordinate?
    public let polygon: [GeoCoordinate]
    public let createdAt: String
    public let updatedAt: String
}

public struct AreaEquipment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let areaId: String
    public let name: String
    public let kind: String
    public let manufacturer: String?
    public let model: String?
    public let serialNumber: String?
    public let status: String
    public let notes: String?
    public let createdAt: String
    public let updatedAt: String
}

public enum AreaEquipmentServiceStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case active
    case outOfService = "out-of-service"
    case retired

    public var id: String { rawValue }
}

public struct AreaEquipmentCreateInput: Encodable, Equatable, Sendable {
    public let areaId: String
    public let name: String
    public let kind: String
    public let manufacturer: String?
    public let model: String?
    public let serialNumber: String?
    public let status: AreaEquipmentServiceStatus
    public let notes: String?

    public init(
        areaId: String,
        name: String,
        kind: String,
        manufacturer: String? = nil,
        model: String? = nil,
        serialNumber: String? = nil,
        status: AreaEquipmentServiceStatus = .active,
        notes: String? = nil
    ) {
        self.areaId = areaId
        self.name = name
        self.kind = kind
        self.manufacturer = manufacturer
        self.model = model
        self.serialNumber = serialNumber
        self.status = status
        self.notes = notes
    }
}

/// A complete update of the mutable inventory fields. Optional values encode
/// as explicit `null` so clearing a previously stored value reaches the API.
public struct AreaEquipmentUpdateInput: Encodable, Equatable, Sendable {
    public let areaId: String
    public let name: String
    public let kind: String
    public let manufacturer: String?
    public let model: String?
    public let serialNumber: String?
    public let status: AreaEquipmentServiceStatus
    public let notes: String?

    public init(
        areaId: String,
        name: String,
        kind: String,
        manufacturer: String? = nil,
        model: String? = nil,
        serialNumber: String? = nil,
        status: AreaEquipmentServiceStatus,
        notes: String? = nil
    ) {
        self.areaId = areaId
        self.name = name
        self.kind = kind
        self.manufacturer = manufacturer
        self.model = model
        self.serialNumber = serialNumber
        self.status = status
        self.notes = notes
    }

    enum CodingKeys: String, CodingKey {
        case areaId
        case name
        case kind
        case manufacturer
        case model
        case serialNumber
        case status
        case notes
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(areaId, forKey: .areaId)
        try container.encode(name, forKey: .name)
        try container.encode(kind, forKey: .kind)
        try container.encode(status, forKey: .status)
        if let manufacturer {
            try container.encode(manufacturer, forKey: .manufacturer)
        } else {
            try container.encodeNil(forKey: .manufacturer)
        }
        if let model {
            try container.encode(model, forKey: .model)
        } else {
            try container.encodeNil(forKey: .model)
        }
        if let serialNumber {
            try container.encode(serialNumber, forKey: .serialNumber)
        } else {
            try container.encodeNil(forKey: .serialNumber)
        }
        if let notes {
            try container.encode(notes, forKey: .notes)
        } else {
            try container.encodeNil(forKey: .notes)
        }
    }
}

public struct PropertyInventorySnapshot: Codable, Equatable, Sendable {
    public let propertyId: String
    public let generatedAt: String
    public let syncToken: String
    public let areas: [PropertyArea]
    public let equipment: [AreaEquipment]
}

public struct TrackingCapabilities: Codable, Equatable, Sendable {
    public let flags: [String: Bool]
    public let bleServiceUUID: String
    public let protocolVersions: [Int]
    public let maximumObservationBatchSize: Int
    public let observerModes: [String]

    enum CodingKeys: String, CodingKey {
        case flags
        case bleServiceUUID = "bleServiceUuid"
        case protocolVersions
        case maximumObservationBatchSize
        case observerModes
    }

    public func featureEnabled(_ name: String) -> Bool {
        flags[name] == true
    }
}

public struct TrackingTagCapabilities: Codable, Equatable, Sendable {
    public let motion: Bool
    public let battery: Bool
    public let buzzer: Bool
    public let button: Bool
    public let tamper: Bool
    public let connectable: Bool
}

public struct TrackingTag: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let tenantId: String
    public let propertyId: String
    public let serialNumber: String
    public let hardwareModel: String
    public let firmwareVersion: String?
    public let protocolVersion: Int
    public let rotationWindowMinutes: Int
    public let batteryType: String?
    public let batteryPercent: Int?
    public let capabilities: TrackingTagCapabilities
    public let status: String
    public let pairedAt: String?
    public let lastSeenAt: String?
    public let createdAt: String
    public let updatedAt: String
}

public struct TrackingAssetTagAssignment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let equipmentId: String
    public let tagId: String
    public let validFrom: String
    public let validTo: String?
    public let assignedBy: String
}

public struct TrackingObserver: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let tenantId: String
    public let propertyId: String
    public let type: String
    public let name: String
    public let trustLevel: Double
    public let fixedPosition: GeoCoordinate?
    public let fixedPositionAccuracyMeters: Double?
    public let zoneId: String?
    public let appInstallationId: String?
    public let hardwareMetadata: [String: JSONValue]
    public let lastHeartbeatAt: String?
    public let status: String
    public let createdAt: String
    public let updatedAt: String
}

public struct TrackingObserverRegistrationInput: Encodable, Equatable, Sendable {
    public let propertyId: String
    public let type: String
    public let name: String
    public let appInstallationId: String
    public let hardwareMetadata: [String: JSONValue]

    public init(
        propertyId: String,
        type: String = "ios-phone",
        name: String,
        appInstallationId: String,
        hardwareMetadata: [String: JSONValue] = [:]
    ) {
        self.propertyId = propertyId
        self.type = type
        self.name = name
        self.appInstallationId = appInstallationId
        self.hardwareMetadata = hardwareMetadata
    }
}

public struct TrackingObserverRegistration: Codable, Equatable, Sendable {
    public let observer: TrackingObserver
    public let credential: String
}

public struct TrackingObserverPosition: Codable, Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let horizontalAccuracyMeters: Double
    public let source: String
    public let capturedAt: String?
    public let reducedAccuracy: Bool?

    public init(
        latitude: Double,
        longitude: Double,
        horizontalAccuracyMeters: Double,
        source: String,
        capturedAt: String? = nil,
        reducedAccuracy: Bool? = nil
    ) {
        self.latitude = latitude
        self.longitude = longitude
        self.horizontalAccuracyMeters = horizontalAccuracyMeters
        self.source = source
        self.capturedAt = capturedAt
        self.reducedAccuracy = reducedAccuracy
    }
}

public struct TrackingObservationInput: Codable, Identifiable, Equatable, Sendable {
    public var id: String { observationId }

    public let observationId: String
    public let propertyId: String
    public let observerId: String
    public let observedAt: String
    public let rotatingTagId: String
    public let authenticator: String
    public let protocolVersion: Int
    public let advertisementFlags: Int
    public let epochCounter: Int
    public let eventCounter: Int
    public let rssi: Int
    public let txPower: Int?
    public let motion: Bool?
    public let batteryPercent: Int?
    public let observerPosition: TrackingObserverPosition?
    public let scanMode: String
    public let appState: String
    public let deviceTimeOffsetMs: Int?
    public let rawPayload: String
    public let metadata: [String: JSONValue]

    public init(
        observationId: String = UUID().uuidString.lowercased(),
        propertyId: String,
        observerId: String,
        observedAt: String,
        rotatingTagId: String,
        authenticator: String,
        protocolVersion: Int,
        advertisementFlags: Int,
        epochCounter: Int,
        eventCounter: Int,
        rssi: Int,
        txPower: Int? = nil,
        motion: Bool? = nil,
        batteryPercent: Int? = nil,
        observerPosition: TrackingObserverPosition? = nil,
        scanMode: String,
        appState: String,
        deviceTimeOffsetMs: Int? = nil,
        rawPayload: String,
        metadata: [String: JSONValue] = [:]
    ) {
        self.observationId = observationId
        self.propertyId = propertyId
        self.observerId = observerId
        self.observedAt = observedAt
        self.rotatingTagId = rotatingTagId
        self.authenticator = authenticator
        self.protocolVersion = protocolVersion
        self.advertisementFlags = advertisementFlags
        self.epochCounter = epochCounter
        self.eventCounter = eventCounter
        self.rssi = rssi
        self.txPower = txPower
        self.motion = motion
        self.batteryPercent = batteryPercent
        self.observerPosition = observerPosition
        self.scanMode = scanMode
        self.appState = appState
        self.deviceTimeOffsetMs = deviceTimeOffsetMs
        self.rawPayload = rawPayload
        self.metadata = metadata
    }
}

public struct TrackingObservationBatchInput: Encodable, Equatable, Sendable {
    public let observations: [TrackingObservationInput]
}

public struct TrackingObservationBatchError: Codable, Equatable, Sendable {
    public let index: Int
    public let code: String
}

public struct TrackingObservationBatchResult: Codable, Equatable, Sendable {
    public let accepted: Int
    public let duplicates: Int
    public let rejected: Int
    public let serverTime: String
    public let errors: [TrackingObservationBatchError]
}

public struct TrackingInferenceExplanation: Codable, Equatable, Sendable {
    public let method: String
    public let inputObservationCount: Int
    public let acceptedObservationCount: Int
    public let rejectedObservationCount: Int
    public let primaryFactors: [String]
}

public struct AssetPositionEstimate: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let equipmentId: String
    public let propertyId: String
    public let calculatedAt: String
    public let effectiveAt: String
    public let positionType: String
    public let coordinate: GeoCoordinate?
    public let accuracyRadiusMeters: Double?
    public let zoneId: String?
    public let confidence: Double
    public let confidenceLevel: String
    public let movementState: String
    public let freshnessState: String
    public let lastObservedAt: String?
    public let observerCount: Int
    public let algorithmVersion: String
    public let evidenceObservationIds: [String]
    public let explanation: TrackingInferenceExplanation
    public let version: Int

    public var lastObservedDate: Date? {
        lastObservedAt.flatMap(StugaDateParser.date(from:))
    }
}

public struct TrackedEquipmentState: Codable, Identifiable, Equatable, Sendable {
    public var id: String { equipment.id }
    public let equipment: AreaEquipment
    public let tag: TrackingTag?
    public let assignment: TrackingAssetTagAssignment?
    public let position: AssetPositionEstimate?

    public init(
        equipment: AreaEquipment,
        tag: TrackingTag? = nil,
        assignment: TrackingAssetTagAssignment? = nil,
        position: AssetPositionEstimate? = nil
    ) {
        self.equipment = equipment
        self.tag = tag
        self.assignment = assignment
        self.position = position
    }
}

public struct TrackingPropertySettings: Codable, Equatable, Sendable {
    public let propertyId: String
    public let enabled: Bool
    public let propertyBoundary: [GeoCoordinate]
    public let liveNearbySeconds: Int
    public let recentlySeenSeconds: Int
    public let staleSeconds: Int
    public let unknownSeconds: Int
    public let movementThresholdMeters: Double
    public let movementMaximumIntervalSeconds: Int
    public let minimumMovementConfidence: Double
    public let exitAlertDebounceSeconds: Int
    public let updatedAt: String
}

public struct TrackingMapSnapshot: Codable, Equatable, Sendable {
    public let propertyId: String
    public let generatedAt: String
    public let sequence: Int
    public let settings: TrackingPropertySettings
    public let zones: [PropertyArea]
    public let gateways: [TrackingObserver]
    public let assets: [TrackedEquipmentState]
    public let members: [PropertyMemberLocation]
}

public struct TrackingScanToken: Codable, Equatable, Sendable {
    public let equipmentId: String
    public let bleServiceUUID: String
    public let protocolVersion: Int
    public let rotatingTagIds: [String]
    public let validUntil: String

    enum CodingKeys: String, CodingKey {
        case equipmentId
        case bleServiceUUID = "bleServiceUuid"
        case protocolVersion
        case rotatingTagIds
        case validUntil
    }
}
