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
    public let areaId: String?
    public let houseId: String?
    public let location: GeoCoordinate?
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
    public let propertyId: String
    public let areaId: String?
    public let houseId: String?
    public let location: GeoCoordinate?
    public let name: String
    public let kind: String
    public let manufacturer: String?
    public let model: String?
    public let serialNumber: String?
    public let status: AreaEquipmentServiceStatus
    public let notes: String?

    public init(
        propertyId: String,
        areaId: String? = nil,
        houseId: String? = nil,
        location: GeoCoordinate? = nil,
        name: String,
        kind: String,
        manufacturer: String? = nil,
        model: String? = nil,
        serialNumber: String? = nil,
        status: AreaEquipmentServiceStatus = .active,
        notes: String? = nil
    ) {
        self.propertyId = propertyId
        self.areaId = areaId
        self.houseId = houseId
        self.location = location
        self.name = name
        self.kind = kind
        self.manufacturer = manufacturer
        self.model = model
        self.serialNumber = serialNumber
        self.status = status
        self.notes = notes
    }
}

/// A complete metadata update. Placement and map-pin changes are independently
/// optional so an unchanged remote Home need not be re-authorized.
public struct AreaEquipmentUpdateInput: Encodable, Equatable, Sendable {
    public let areaId: String?
    public let houseId: String?
    public let location: GeoCoordinate?
    public let updatesPlacement: Bool
    public let updatesLocation: Bool
    public let name: String
    public let kind: String
    public let manufacturer: String?
    public let model: String?
    public let serialNumber: String?
    public let status: AreaEquipmentServiceStatus
    public let notes: String?

    public init(
        areaId: String?,
        houseId: String?,
        location: GeoCoordinate?,
        updatesPlacement: Bool = true,
        updatesLocation: Bool = true,
        name: String,
        kind: String,
        manufacturer: String? = nil,
        model: String? = nil,
        serialNumber: String? = nil,
        status: AreaEquipmentServiceStatus,
        notes: String? = nil
    ) {
        self.areaId = areaId
        self.houseId = houseId
        self.location = location
        self.updatesPlacement = updatesPlacement
        self.updatesLocation = updatesLocation
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
        case houseId
        case location
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
        if updatesPlacement {
            if let areaId {
                try container.encode(areaId, forKey: .areaId)
            } else {
                try container.encodeNil(forKey: .areaId)
            }
            if let houseId {
                try container.encode(houseId, forKey: .houseId)
            } else {
                try container.encodeNil(forKey: .houseId)
            }
        }
        if updatesLocation {
            if let location {
                try container.encode(location, forKey: .location)
            } else {
                try container.encodeNil(forKey: .location)
            }
        }
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

public enum EquipmentAttachmentKind: String, Codable, Sendable {
    case photo
    case document
}

public struct EquipmentAttachment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let equipmentId: String
    public let kind: EquipmentAttachmentKind
    public let name: String
    public let mimeType: String
    public let size: Int
    public let createdAt: String
}

public struct EquipmentLink: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let equipmentId: String
    public let label: String
    public let url: String
    public let createdAt: String
    public let updatedAt: String
}

public struct PropertyInventorySnapshot: Codable, Equatable, Sendable {
    public let propertyId: String
    public let generatedAt: String
    public let syncToken: String
    public let areas: [PropertyArea]
    public let equipment: [AreaEquipment]
    public let attachments: [EquipmentAttachment]
    public let links: [EquipmentLink]

    enum CodingKeys: String, CodingKey {
        case propertyId
        case generatedAt
        case syncToken
        case areas
        case equipment
        case attachments
        case links
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        propertyId = try container.decode(String.self, forKey: .propertyId)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        syncToken = try container.decode(String.self, forKey: .syncToken)
        areas = try container.decode([PropertyArea].self, forKey: .areas)
        equipment = try container.decode([AreaEquipment].self, forKey: .equipment)
        attachments = try container.decodeIfPresent(
            [EquipmentAttachment].self,
            forKey: .attachments
        ) ?? []
        links = try container.decodeIfPresent([EquipmentLink].self, forKey: .links) ?? []
    }
}

public enum TrackingSchema {
    public static let version = "2026-07-01"
    public static let profileVersion = "2026-07-01"
}

public struct TrackingCapabilities: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let profileSchemaVersion: String
    public let flags: [String: Bool]
    public let maximumObservationBatchSize: Int
    public let maximumRollupBatchSize: Int
    public let observerTypes: [String]

    public func featureEnabled(_ name: String) -> Bool {
        flags[name] == true
    }
}

public struct TrackingPlatformCondition: Codable, Equatable, Sendable {
    public let platform: String
    public let scanContexts: [String]
    public let minimumOsVersion: String?
    public let maximumOsVersion: String?
    public let requiresServiceFilter: Bool?
    public let requiresLiveActivity: Bool?
    public let requiresScreenAwake: Bool?
    public let notes: [String]
}

public struct TrackingProfileMatchRule: Codable, Equatable, Sendable {
    public let source: String
    public let key: String?
    public let offset: Int?
    public let value: String
    public let mask: String?
}

public struct TrackingProfileField: Codable, Equatable, Sendable {
    public let name: String
    public let source: String
    public let key: String?
    public let offset: Int?
    public let length: Int?
    public let encoding: String
    public let optional: Bool?
    public let scale: Double?
}

public struct TrackingProfileIdentity: Codable, Equatable, Sendable {
    public let namespace: String
    public let namespaceVersion: Int
    public let scope: String
    public let strength: String
    public let fields: [String]
    public let separator: String?
}

public struct TrackingProfileCapabilities: Codable, Equatable, Sendable {
    public let trackabilityTier: String
    public let discoverability: String
    public let backgroundSupport: String
    public let mapCapability: String
    public let connectable: Bool
    public let reportsBattery: Bool
    public let reportsMotion: Bool
    public let reportsCounter: Bool
}

public struct TrackingProfile: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: String
    public let id: String
    public let version: String
    public let displayName: String
    public let description: String
    public let serviceUuids: [String]
    public let match: [TrackingProfileMatchRule]
    public let fields: [TrackingProfileField]
    public let identity: TrackingProfileIdentity
    public let capabilities: TrackingProfileCapabilities
    public let platformSupport: [TrackingPlatformCondition]
    public let maximumFrameBytes: Int
    public let deprecatedAt: String?
}

public struct TrackingProfileIntegrity: Codable, Equatable, Sendable {
    public let digestAlgorithm: String
    public let digest: String
    public let signatureAlgorithm: String?
    public let keyId: String?
    public let signature: String?
}

public struct TrackingProfileEnvelope: Codable, Equatable, Sendable {
    public let profile: TrackingProfile
    public let integrity: TrackingProfileIntegrity
    public let source: String
}

public struct TrackingProfileManifest: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let registryVersion: String
    public let generatedAt: String
    public let profiles: [TrackingProfileEnvelope]
}

public struct TrackingEndpoint: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let tenantId: String
    public let propertyId: String
    public let profileId: String
    public let profileVersion: String
    public let identityNamespaceVersion: Int
    public let identityReference: String
    public let identityScope: String
    public let identityStrength: String
    public let observerScopeId: String?
    public let trackabilityTier: String
    public let displayName: String
    public let manufacturer: String?
    public let model: String?
    public let firmwareVersion: String?
    public let claimStatus: String
    public let proofKind: String?
    public let proofVerifiedAt: String?
    public let lastSeenAt: String?
    public let telemetry: [String: JSONValue]
    public let createdAt: String
    public let updatedAt: String
}

public struct TrackingEndpointProof: Encodable, Equatable, Sendable {
    public let kind: String
    public let challengeId: String?
    public let response: String?
    public let attestation: String?

    public init(
        kind: String,
        challengeId: String? = nil,
        response: String? = nil,
        attestation: String? = nil
    ) {
        self.kind = kind
        self.challengeId = challengeId
        self.response = response
        self.attestation = attestation
    }
}

public struct TrackingEndpointEnrollmentInput: Encodable, Equatable, Sendable {
    public let propertyId: String
    public let profileId: String
    public let profileVersion: String
    public let identityFields: [String: String]
    public let observerScopeId: String?
    public let displayName: String
    public let manufacturer: String?
    public let model: String?
    public let firmwareVersion: String?
    public let proof: TrackingEndpointProof

    public init(
        propertyId: String,
        profileId: String,
        profileVersion: String,
        identityFields: [String: String],
        observerScopeId: String? = nil,
        displayName: String,
        manufacturer: String? = nil,
        model: String? = nil,
        firmwareVersion: String? = nil,
        proof: TrackingEndpointProof
    ) {
        self.propertyId = propertyId
        self.profileId = profileId
        self.profileVersion = profileVersion
        self.identityFields = identityFields
        self.observerScopeId = observerScopeId
        self.displayName = displayName
        self.manufacturer = manufacturer
        self.model = model
        self.firmwareVersion = firmwareVersion
        self.proof = proof
    }
}

public struct EquipmentTrackingBinding: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let equipmentId: String
    public let endpointId: String
    public let observerId: String?
    public let validFrom: String
    public let validTo: String?
    public let boundBy: String
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
    public let capturedAt: String
    public let reducedAccuracy: Bool?

    public init(
        latitude: Double,
        longitude: Double,
        horizontalAccuracyMeters: Double,
        source: String,
        capturedAt: String,
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

    public let schemaVersion: String
    public let dataMode: String
    public let observationId: String
    public let idempotencyKey: String
    public let propertyId: String
    public let endpointId: String
    public let equipmentId: String
    public let observerId: String
    public let observedAt: String
    public let profileId: String
    public let profileVersion: String
    public let rssi: Int
    public let txPower: Int?
    public let motion: Bool?
    public let batteryPercent: Int?
    public let counter: Int?
    public let observerPosition: TrackingObserverPosition?
    public let scanContext: String
    public let telemetry: [String: JSONValue]

    public init(
        schemaVersion: String = TrackingSchema.version,
        dataMode: String,
        observationId: String = UUID().uuidString.lowercased(),
        idempotencyKey: String? = nil,
        propertyId: String,
        endpointId: String,
        equipmentId: String,
        observerId: String,
        observedAt: String,
        profileId: String,
        profileVersion: String,
        rssi: Int,
        txPower: Int? = nil,
        motion: Bool? = nil,
        batteryPercent: Int? = nil,
        counter: Int? = nil,
        observerPosition: TrackingObserverPosition? = nil,
        scanContext: String,
        telemetry: [String: JSONValue] = [:]
    ) {
        self.schemaVersion = schemaVersion
        self.dataMode = dataMode
        self.observationId = observationId
        self.idempotencyKey = idempotencyKey ?? observationId
        self.propertyId = propertyId
        self.endpointId = endpointId
        self.equipmentId = equipmentId
        self.observerId = observerId
        self.observedAt = observedAt
        self.profileId = profileId
        self.profileVersion = profileVersion
        self.rssi = rssi
        self.txPower = txPower
        self.motion = motion
        self.batteryPercent = batteryPercent
        self.counter = counter
        self.observerPosition = observerPosition
        self.scanContext = scanContext
        self.telemetry = telemetry
    }
}

public struct TrackingObservationBatchInput: Encodable, Equatable, Sendable {
    public let observations: [TrackingObservationInput]

    public init(observations: [TrackingObservationInput]) {
        self.observations = observations
    }
}

public struct TrackingObservationBatchError: Codable, Equatable, Sendable {
    public let kind: String
    public let index: Int
    public let id: String?
    public let code: String
}

public struct TrackingObservationBatchResult: Codable, Equatable, Sendable {
    public let accepted: Int
    public let duplicates: Int
    public let rejected: Int
    public let serverTime: String
    public let errors: [TrackingObservationBatchError]
}

public struct TrackingEstimateProvenance: Codable, Equatable, Sendable {
    public let algorithm: String
    public let observationIds: [String]
    public let rollupIds: [String]
    public let observerIds: [String]
    public let profileVersions: [String]
    public let factors: [String]
}

public struct EquipmentLocationEstimate: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let dataMode: String
    public let equipmentId: String
    public let propertyId: String
    public let endpointId: String
    public let calculatedAt: String
    public let effectiveAt: String
    public let kind: String
    public let coordinate: GeoCoordinate?
    public let uncertaintyRadiusMeters: Double?
    public let zoneId: String?
    public let confidence: Double
    public let truthClass: String
    public let source: String
    public let movementState: String
    public let freshness: String
    public let lastObservedAt: String?
    public let observerCount: Int
    public let provenance: TrackingEstimateProvenance
    public let version: Int

    public var lastObservedDate: Date? {
        lastObservedAt.flatMap(StuguDateParser.date(from:))
    }
}

public struct TrackedEquipmentState: Codable, Identifiable, Equatable, Sendable {
    public var id: String { equipment.id }
    public let equipment: AreaEquipment
    public let endpoint: TrackingEndpoint?
    public let binding: EquipmentTrackingBinding?
    public let position: EquipmentLocationEstimate?

    public init(
        equipment: AreaEquipment,
        endpoint: TrackingEndpoint? = nil,
        binding: EquipmentTrackingBinding? = nil,
        position: EquipmentLocationEstimate? = nil
    ) {
        self.equipment = equipment
        self.endpoint = endpoint
        self.binding = binding
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
    public let observationRetentionDays: Int
    public let rollupRetentionDays: Int
    public let estimateRetentionDays: Int
    public let updatedAt: String
}

public struct TrackingMapSnapshot: Codable, Equatable, Sendable {
    public let propertyId: String
    public let dataMode: String
    public let generatedAt: String
    public let sequence: Int
    public let settings: TrackingPropertySettings
    public let zones: [PropertyArea]
    public let gateways: [TrackingObserver]
    public let equipment: [TrackedEquipmentState]
    public let members: [PropertyMemberLocation]
}

public struct TrackingFindDescriptor: Codable, Equatable, Sendable {
    public let equipmentId: String
    public let endpointId: String
    public let profile: TrackingProfileEnvelope
    public let identityFields: [String: String]
    public let validUntil: String
}

public struct TrackingResolutionEntry: Codable, Equatable, Sendable {
    public let equipmentId: String
    public let endpointId: String
    public let profileId: String
    public let profileVersion: String
    public let identityFields: [String: String]

    public init(
        equipmentId: String,
        endpointId: String,
        profileId: String,
        profileVersion: String,
        identityFields: [String: String]
    ) {
        self.equipmentId = equipmentId
        self.endpointId = endpointId
        self.profileId = profileId
        self.profileVersion = profileVersion
        self.identityFields = identityFields
    }
}

public struct TrackingResolutionManifest: Codable, Equatable, Sendable {
    public let propertyId: String
    public let observerId: String
    public let dataMode: String
    public let generatedAt: String
    public let validUntil: String
    public let entries: [TrackingResolutionEntry]
}
