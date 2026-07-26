import Foundation

public struct PropertyNote: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let houseId: String?
    public let areaId: String?
    public let equipmentId: String?
    public let kind: String
    public let text: String
    public let createdAt: String
    public let updatedAt: String
}

public struct MaintenanceTask: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let houseId: String?
    public let floorId: String?
    public let areaId: String?
    public let equipmentId: String?
    public let title: String
    public let description: String?
    public let basis: String
    public let basisDetail: String?
    public let priority: String
    public let plannedFor: String?
    public let dueBy: String?
    public let observationIds: [String]
    public let status: String
    public let completionNote: String?
    public let completedAt: String?
    public let verificationNote: String?
    public let verifiedAt: String?
    public let revision: Int
    public let createdAt: String
    public let updatedAt: String
}

public struct EquipmentLoan: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let equipmentId: String
    public let borrowerLabel: String
    public let borrowedAt: String
    public let expectedReturnAt: String?
    public let note: String?
    public let returnedAt: String?
    public let returnedByLabel: String?
    public let returnNote: String?

    public var isActive: Bool { returnedAt == nil }
}

public struct PropertyMemberLocation: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let propertyId: String
    public let memberLabel: String
    public let coordinate: GeoCoordinate
    public let horizontalAccuracyMeters: Double
    public let reducedAccuracy: Bool
    public let capturedAt: String
    public let updatedAt: String
    public let sharingUntil: String
}

public struct PropertyMemberLocationInput: Encodable, Equatable, Sendable {
    public let coordinate: GeoCoordinate
    public let horizontalAccuracyMeters: Double
    public let reducedAccuracy: Bool
    public let capturedAt: String
    public let sharingUntil: String

    public init(
        coordinate: GeoCoordinate,
        horizontalAccuracyMeters: Double,
        reducedAccuracy: Bool,
        capturedAt: String,
        sharingUntil: String
    ) {
        self.coordinate = coordinate
        self.horizontalAccuracyMeters = horizontalAccuracyMeters
        self.reducedAccuracy = reducedAccuracy
        self.capturedAt = capturedAt
        self.sharingUntil = sharingUntil
    }
}

/** Stable, non-secret pointer printed on an equipment sticker. */
public struct EquipmentQRCode: Equatable, Sendable {
    public let propertyId: String
    public let equipmentId: String

    public init(propertyId: String, equipmentId: String) {
        self.propertyId = propertyId
        self.equipmentId = equipmentId
    }

    public var payload: String {
        var components = URLComponents()
        components.scheme = "stuga"
        components.host = "equipment"
        components.queryItems = [
            URLQueryItem(name: "property", value: propertyId),
            URLQueryItem(name: "id", value: equipmentId),
            URLQueryItem(name: "v", value: "1"),
        ]
        return components.string ?? ""
    }

    public static func parse(_ value: String) -> EquipmentQRCode? {
        guard value.count <= 1_024,
              let components = URLComponents(string: value),
              components.scheme?.lowercased() == "stuga",
              components.host?.lowercased() == "equipment",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.path.isEmpty,
              components.fragment == nil else {
            return nil
        }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard let value = item.value, values[item.name] == nil else { return nil }
            values[item.name] = value
        }
        guard values["v"] == "1",
              Set(values.keys) == Set(["property", "id", "v"]),
              let propertyId = values["property"],
              let equipmentId = values["id"],
              propertyId == propertyId.trimmingCharacters(in: .whitespacesAndNewlines),
              equipmentId == equipmentId.trimmingCharacters(in: .whitespacesAndNewlines),
              !propertyId.isEmpty,
              !equipmentId.isEmpty,
              propertyId.count <= 200,
              equipmentId.count <= 200 else {
            return nil
        }
        return EquipmentQRCode(propertyId: propertyId, equipmentId: equipmentId)
    }
}
