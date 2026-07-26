import Foundation

public enum IOSPushEnvironment: String, Codable, Equatable, Sendable {
    case sandbox
    case production
}

public enum IOSPushMinimumSeverity: String, Codable, CaseIterable, Equatable, Sendable {
    case info
    case warning
    case critical
}

public struct IOSNotificationRegistrationInput: Codable, Equatable, Sendable {
    public let deviceToken: String
    public let environment: IOSPushEnvironment
    public let homeIds: [String]
    public let minimumSeverity: IOSPushMinimumSeverity
    public let includeDetails: Bool

    public init(
        deviceToken: String,
        environment: IOSPushEnvironment,
        homeIds: [String],
        minimumSeverity: IOSPushMinimumSeverity = .warning,
        includeDetails: Bool = false
    ) {
        self.deviceToken = deviceToken
        self.environment = environment
        self.homeIds = homeIds
        self.minimumSeverity = minimumSeverity
        self.includeDetails = includeDetails
    }
}

public struct IOSNotificationRegistration: Codable, Equatable, Sendable {
    public let id: String
    public let environment: IOSPushEnvironment
    public let homeIds: [String]
    public let minimumSeverity: IOSPushMinimumSeverity
    public let includeDetails: Bool
    public let enabled: Bool
    public let updatedAt: String
}

public struct IOSNotificationStatus: Codable, Equatable, Sendable {
    public let configured: Bool
    public let registration: IOSNotificationRegistration?
}
