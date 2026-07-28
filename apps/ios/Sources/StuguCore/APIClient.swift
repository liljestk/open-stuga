import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct StuguAPIError: LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let message: String

    public var errorDescription: String? { message }
}

/// Stops a redirect from carrying the Access service token to another host.
/// Cloudflare answers an unauthenticated request with a redirect to its own
/// login domain, and following it would both hand over the secret and hide the
/// challenge behind an HTML page the caller cannot read.
final class SameHostRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        let origin = task.originalRequest?.url?.host?.lowercased()
        let destination = request.url?.host?.lowercased()
        completionHandler(origin == destination ? request : nil)
    }
}

public actor StuguAPIClient {
    private struct ErrorEnvelope: Decodable {
        struct Payload: Decodable {
            let code: String?
            let message: String?
        }
        let error: Payload?
    }

    private struct PropertiesEnvelope: Decodable { let properties: [StuguProperty] }
    private struct HousesEnvelope: Decodable { let houses: [House] }
    private struct SensorsEnvelope: Decodable { let sensors: [Sensor] }
    private struct DefinitionsEnvelope: Decodable { let definitions: [MeasurementDefinition] }
    private struct SnapshotEnvelope: Decodable { let snapshot: [MeasurementSnapshotEntry] }
    private struct AlertsEnvelope: Decodable { let alerts: [AlertEvent] }
    private struct RulesEnvelope: Decodable { let rules: [AlertRule] }
    private struct HistoryEnvelope: Decodable { let samples: [MeasurementSample] }
    private struct TpLinkDevicesEnvelope: Decodable { let devices: [TpLinkDiscoveredDevice] }
    private struct OpeningStateHistoryEnvelope: Decodable {
        let history: [OpeningStateObservation]?
    }
    private struct InventoryEnvelope: Decodable { let inventory: PropertyInventorySnapshot }
    private struct EquipmentEnvelope: Decodable { let equipment: AreaEquipment }
    private struct AttachmentsEnvelope: Decodable { let attachments: [EquipmentAttachment] }
    private struct AttachmentEnvelope: Decodable { let attachment: EquipmentAttachment }
    private struct LinksEnvelope: Decodable { let links: [EquipmentLink] }
    private struct LinkEnvelope: Decodable { let link: EquipmentLink }
    private struct TrackingSettingsEnvelope: Decodable { let settings: TrackingPropertySettings }
    private struct TrackingObserverEnvelope: Decodable { let observer: TrackingObserver }
    private struct TrackingEndpointEnvelope: Decodable { let endpoint: TrackingEndpoint }
    private struct NotesEnvelope: Decodable { let notes: [PropertyNote] }
    private struct NoteEnvelope: Decodable { let note: PropertyNote }
    private struct MaintenanceTasksEnvelope: Decodable { let maintenanceTasks: [MaintenanceTask] }
    private struct LoansEnvelope: Decodable { let loans: [EquipmentLoan] }
    private struct LoanEnvelope: Decodable { let loan: EquipmentLoan }
    private struct MemberLocationsEnvelope: Decodable { let locations: [PropertyMemberLocation] }
    private struct MemberLocationEnvelope: Decodable { let location: PropertyMemberLocation }
    private struct WeatherEnvelope: Decodable { let weather: HouseWeatherSummary }
    private struct EnergyOptimizationEnvelope: Decodable { let report: EnergyOptimizationSummary }
    private struct RoomPlanImportEnvelope: Decodable {
        let house: House
        let floor: StuguFloor
    }
    private struct IOSNotificationRegistrationEnvelope: Decodable {
        let configured: Bool
        let registration: IOSNotificationRegistration
    }
    private struct IdentifierResponse: Decodable { let id: String }
    private struct TrackingObserverStatusBody: Encodable { let status: String }
    private struct LoginBody: Encodable { let email: String; let password: String }
    private struct PropertyNoteBody: Encodable {
        let propertyId: String
        let equipmentId: String
        let kind: String
        let text: String
    }
    private struct MaintenanceIssueBody: Encodable {
        let propertyId: String
        let houseId: String?
        let areaId: String?
        let equipmentId: String
        let title: String
        let description: String?
        let basis: String
        let basisDetail: String
        let priority: String
    }
    private struct EquipmentBorrowBody: Encodable {
        let expectedReturnAt: String?
        let note: String?
    }
    private struct EquipmentReturnBody: Encodable { let note: String? }
    private struct EquipmentAttachmentUploadBody: Encodable {
        let kind: EquipmentAttachmentKind
        let name: String
        let mimeType: String
        let data: String
    }
    private struct EquipmentLinkBody: Encodable {
        let label: String
        let url: String
    }
    private struct RoomPlanImportBody: Encodable {
        let source = "apple-roomplan"
        let capturedAt: String
        let expectedHouseUpdatedAt: String
        let floor: StuguFloor
    }

    public let address: ServerAddress
    private let session: URLSession
    private let edgeCredential: EdgeCredential?
    private let redirectGuard = SameHostRedirectGuard()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var csrfToken: String?

    public init(
        address: ServerAddress,
        edgeCredential: EdgeCredential? = nil,
        session: URLSession? = nil
    ) {
        self.address = address
        self.edgeCredential = edgeCredential
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.httpCookieStorage = .shared
            configuration.httpShouldSetCookies = true
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 30
            configuration.timeoutIntervalForResource = 45
            #if !canImport(FoundationNetworking)
            configuration.waitsForConnectivity = true
            #endif
            self.session = URLSession(configuration: configuration)
        }
    }

    public func health() async throws -> HealthResponse {
        try await request(version: 1, path: "/health")
    }

    public func currentSession() async throws -> AppSession {
        let value: AppSession = try await request(version: 1, path: "/session")
        csrfToken = value.csrfToken
        return value
    }

    public func login(email: String, password: String) async throws -> AppSession {
        let value: AppSession = try await request(
            version: 1,
            path: "/auth/login",
            method: "POST",
            body: LoginBody(email: email, password: password)
        )
        csrfToken = value.csrfToken
        return value
    }

    public func logout() async throws {
        do {
            let _: EmptyResponse = try await request(
                version: 1,
                path: "/auth/logout",
                method: "POST",
                timeoutInterval: 5
            )
        } catch let error as StuguAPIError where error.status == 401 {
            // An expired server session is already logged out.
        }
        csrfToken = nil
    }

    public func properties() async throws -> [StuguProperty] {
        let value: PropertiesEnvelope = try await request(version: 1, path: "/properties")
        return value.properties
    }

    public func houses() async throws -> [House] {
        let value: HousesEnvelope = try await request(version: 1, path: "/houses")
        return value.houses
    }

    public func importRoomPlanFloor(
        houseID: String,
        floor: StuguFloor,
        capturedAt: String,
        expectedHouseUpdatedAt: String
    ) async throws -> House {
        let value: RoomPlanImportEnvelope = try await request(
            version: 1,
            path: "/houses/\(escaped(houseID))/floors/\(escaped(floor.id))/roomplan-import",
            method: "POST",
            body: RoomPlanImportBody(
                capturedAt: capturedAt,
                expectedHouseUpdatedAt: expectedHouseUpdatedAt,
                floor: floor
            )
        )
        return value.house
    }

    public func propertyInventory(propertyID: String) async throws -> PropertyInventorySnapshot {
        let value: InventoryEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/inventory"
        )
        return value.inventory
    }

    public func createAreaEquipment(
        _ input: AreaEquipmentCreateInput
    ) async throws -> AreaEquipment {
        let value: EquipmentEnvelope = try await request(
            version: 1,
            path: "/area-equipment",
            method: "POST",
            body: input
        )
        return value.equipment
    }

    public func updateAreaEquipment(
        id: String,
        input: AreaEquipmentUpdateInput
    ) async throws -> AreaEquipment {
        let value: EquipmentEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(id))",
            method: "PATCH",
            body: input
        )
        return value.equipment
    }

    public func equipmentAttachments(equipmentID: String) async throws -> [EquipmentAttachment] {
        let value: AttachmentsEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/attachments"
        )
        return value.attachments
    }

    public func uploadEquipmentAttachment(
        equipmentID: String,
        kind: EquipmentAttachmentKind,
        name: String,
        mimeType: String,
        data: Data
    ) async throws -> EquipmentAttachment {
        let value: AttachmentEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/attachments",
            method: "POST",
            body: EquipmentAttachmentUploadBody(
                kind: kind,
                name: name,
                mimeType: mimeType,
                data: data.base64EncodedString()
            )
        )
        return value.attachment
    }

    public func equipmentAttachmentData(
        equipmentID: String,
        attachmentID: String
    ) async throws -> Data {
        try await requestData(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/attachments/\(escaped(attachmentID))"
        )
    }

    public func deleteEquipmentAttachment(
        equipmentID: String,
        attachmentID: String
    ) async throws {
        let _: EmptyResponse = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/attachments/\(escaped(attachmentID))",
            method: "DELETE"
        )
    }

    public func equipmentLinks(equipmentID: String) async throws -> [EquipmentLink] {
        let value: LinksEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/links"
        )
        return value.links
    }

    public func createEquipmentLink(
        equipmentID: String,
        label: String,
        url: String
    ) async throws -> EquipmentLink {
        let value: LinkEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/links",
            method: "POST",
            body: EquipmentLinkBody(label: label, url: url)
        )
        return value.link
    }

    public func deleteEquipmentLink(equipmentID: String, linkID: String) async throws {
        let _: EmptyResponse = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/links/\(escaped(linkID))",
            method: "DELETE"
        )
    }

    public func sensors(houseID: String? = nil) async throws -> [Sensor] {
        let path: String
        if let houseID {
            let query = queryString([URLQueryItem(name: "houseId", value: houseID)])
            path = "/sensors?\(query)"
        } else {
            path = "/sensors"
        }
        let value: SensorsEnvelope = try await request(version: 1, path: path)
        return value.sensors
    }

    public func measurementDefinitions() async throws -> [MeasurementDefinition] {
        let value: DefinitionsEnvelope = try await request(version: 2, path: "/measurement-definitions")
        return value.definitions
    }

    public func measurementSnapshot(houseID: String) async throws -> [MeasurementSnapshotEntry] {
        let query = queryString([URLQueryItem(name: "houseId", value: houseID)])
        let value: SnapshotEnvelope = try await request(version: 2, path: "/measurements/snapshot?\(query)")
        return value.snapshot
    }

    public func tpLinkDevices(houseID: String) async throws -> [TpLinkDiscoveredDevice] {
        let query = queryString([URLQueryItem(name: "houseId", value: houseID)])
        let value: TpLinkDevicesEnvelope = try await request(
            version: 1,
            path: "/integrations/tp-link/devices?\(query)"
        )
        return value.devices
    }

    public func openingStateHistory(
        houseID: String,
        from: Date,
        to: Date = Date(),
        limit: Int = 10_000
    ) async throws -> [OpeningStateObservation] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let query = queryString([
            URLQueryItem(name: "from", value: formatter.string(from: from)),
            URLQueryItem(name: "to", value: formatter.string(from: to)),
            URLQueryItem(name: "limit", value: String(max(1, min(limit, 10_000)))),
        ])
        let value: OpeningStateHistoryEnvelope = try await request(
            version: 1,
            path: "/houses/\(escaped(houseID))/opening-states?\(query)"
        )
        return value.history ?? []
    }

    public func alerts(activeOnly: Bool = false) async throws -> [AlertEvent] {
        let query = queryString([
            URLQueryItem(name: "active", value: activeOnly ? "true" : "false"),
            URLQueryItem(name: "limit", value: "500"),
        ])
        let value: AlertsEnvelope = try await request(version: 1, path: "/alerts?\(query)")
        return value.alerts
    }

    public func alertRules() async throws -> [AlertRule] {
        let value: RulesEnvelope = try await request(version: 1, path: "/alert-rules")
        return value.rules
    }

    public func acknowledgeAlert(id: String) async throws -> AlertEvent {
        try await request(version: 1, path: "/alerts/\(escaped(id))/acknowledge", method: "POST")
    }

    public func createObservation(_ input: QuickObservationInput) async throws -> String {
        let value: IdentifierResponse = try await request(
            version: 1,
            path: "/observations",
            method: "POST",
            body: input
        )
        return value.id
    }

    public func createMaintenance(_ input: QuickMaintenanceInput) async throws -> MaintenanceTask {
        try await request(
            version: 1,
            path: "/maintenance-tasks",
            method: "POST",
            body: input
        )
    }

    public func houseWeather(houseID: String) async throws -> HouseWeatherSummary {
        let value: WeatherEnvelope = try await request(
            version: 1,
            path: "/houses/\(escaped(houseID))/weather?hours=24"
        )
        return value.weather
    }

    public func energyOptimization(
        propertyID: String,
        windowHours: Int = 2
    ) async throws -> EnergyOptimizationSummary {
        let hours = max(1, min(windowHours, 12))
        let value: EnergyOptimizationEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/energy-optimization?windowHours=\(hours)"
        )
        return value.report
    }

    public func systemUpdateStatus() async throws -> SystemUpdateStatus {
        try await request(version: 1, path: "/system/updates")
    }

    public func iosNotificationStatus(registrationID: String) async throws -> IOSNotificationStatus {
        try await request(
            version: 1,
            path: "/ios-notification-registrations/\(escaped(registrationID))"
        )
    }

    public func saveIOSNotificationRegistration(
        id: String,
        input: IOSNotificationRegistrationInput
    ) async throws -> (configured: Bool, registration: IOSNotificationRegistration) {
        let value: IOSNotificationRegistrationEnvelope = try await request(
            version: 1,
            path: "/ios-notification-registrations/\(escaped(id))",
            method: "PUT",
            body: input
        )
        return (value.configured, value.registration)
    }

    public func deleteIOSNotificationRegistration(id: String) async throws {
        let _: EmptyResponse = try await request(
            version: 1,
            path: "/ios-notification-registrations/\(escaped(id))",
            method: "DELETE"
        )
    }

    public func trackingCapabilities() async throws -> TrackingCapabilities {
        try await request(version: 1, path: "/tracking/capabilities")
    }

    public func trackingProfiles() async throws -> TrackingProfileManifest {
        try await request(version: 1, path: "/tracking/profiles")
    }

    public func enrollTrackingEndpoint(
        _ input: TrackingEndpointEnrollmentInput
    ) async throws -> TrackingEndpoint {
        let value: TrackingEndpointEnvelope = try await request(
            version: 1,
            path: "/tracking/endpoints",
            method: "POST",
            body: input
        )
        return value.endpoint
    }

    public func trackingMapSnapshot(propertyID: String) async throws -> TrackingMapSnapshot {
        try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/tracking-map-snapshot"
        )
    }

    public func propertyNotes(equipmentID: String) async throws -> [PropertyNote] {
        let query = queryString([
            URLQueryItem(name: "equipmentId", value: equipmentID),
            URLQueryItem(name: "limit", value: "200"),
        ])
        let value: NotesEnvelope = try await request(
            version: 1,
            path: "/property-notes?\(query)"
        )
        return value.notes
    }

    public func addEquipmentNote(
        propertyID: String,
        equipmentID: String,
        text: String
    ) async throws -> PropertyNote {
        let value: NoteEnvelope = try await request(
            version: 1,
            path: "/property-notes",
            method: "POST",
            body: PropertyNoteBody(
                propertyId: propertyID,
                equipmentId: equipmentID,
                kind: "note",
                text: text
            )
        )
        return value.note
    }

    public func maintenanceTasks(equipmentID: String) async throws -> [MaintenanceTask] {
        let query = queryString([
            URLQueryItem(name: "equipmentId", value: equipmentID),
            URLQueryItem(name: "limit", value: "200"),
        ])
        let value: MaintenanceTasksEnvelope = try await request(
            version: 1,
            path: "/maintenance-tasks?\(query)"
        )
        return value.maintenanceTasks
    }

    public func reportEquipmentIssue(
        equipment: AreaEquipment,
        title: String,
        description: String?,
        priority: String
    ) async throws -> MaintenanceTask {
        try await request(
            version: 1,
            path: "/maintenance-tasks",
            method: "POST",
            body: MaintenanceIssueBody(
                propertyId: equipment.propertyId,
                houseId: equipment.houseId,
                areaId: equipment.areaId,
                equipmentId: equipment.id,
                title: title,
                description: description,
                basis: "condition-based",
                basisDetail: "Reported from the native Stugu equipment workflow.",
                priority: priority
            )
        )
    }

    public func equipmentLoans(
        propertyID: String,
        equipmentID: String
    ) async throws -> [EquipmentLoan] {
        let query = queryString([
            URLQueryItem(name: "equipmentId", value: equipmentID),
            URLQueryItem(name: "limit", value: "200"),
        ])
        let value: LoansEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/equipment-loans?\(query)"
        )
        return value.loans
    }

    public func borrowEquipment(
        equipmentID: String,
        expectedReturnAt: String?,
        note: String?
    ) async throws -> EquipmentLoan {
        let value: LoanEnvelope = try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/borrow",
            method: "POST",
            body: EquipmentBorrowBody(expectedReturnAt: expectedReturnAt, note: note)
        )
        return value.loan
    }

    public func returnEquipment(loanID: String, note: String?) async throws -> EquipmentLoan {
        let value: LoanEnvelope = try await request(
            version: 1,
            path: "/equipment-loans/\(escaped(loanID))/return",
            method: "POST",
            body: EquipmentReturnBody(note: note)
        )
        return value.loan
    }

    public func propertyMemberLocations(
        propertyID: String
    ) async throws -> [PropertyMemberLocation] {
        let value: MemberLocationsEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/member-locations"
        )
        return value.locations
    }

    public func sharePropertyMemberLocation(
        propertyID: String,
        input: PropertyMemberLocationInput
    ) async throws -> PropertyMemberLocation {
        let value: MemberLocationEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/member-location",
            method: "PUT",
            body: input
        )
        return value.location
    }

    public func stopPropertyMemberLocation(propertyID: String) async throws {
        let _: EmptyResponse = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/member-location",
            method: "DELETE"
        )
    }

    public func trackingPropertySettings(propertyID: String) async throws -> TrackingPropertySettings {
        let value: TrackingSettingsEnvelope = try await request(
            version: 1,
            path: "/properties/\(escaped(propertyID))/tracking-settings"
        )
        return value.settings
    }

    public func trackingFindDescriptor(equipmentID: String) async throws
        -> TrackingFindDescriptor {
        try await request(
            version: 1,
            path: "/area-equipment/\(escaped(equipmentID))/tracking-find-descriptor"
        )
    }

    public func registerTrackingObserver(
        _ input: TrackingObserverRegistrationInput
    ) async throws -> TrackingObserverRegistration {
        try await request(
            version: 1,
            path: "/tracking/observers/register",
            method: "POST",
            body: input
        )
    }

    public func disableTrackingObserver(id: String) async throws -> TrackingObserver {
        let value: TrackingObserverEnvelope = try await request(
            version: 1,
            path: "/tracking/observers/\(escaped(id))",
            method: "PATCH",
            body: TrackingObserverStatusBody(status: "disabled")
        )
        return value.observer
    }

    public func trackingResolutionManifest(
        observerID: String,
        observerCredential: String
    ) async throws -> TrackingResolutionManifest {
        try await request(
            version: 1,
            path: "/tracking/observers/\(escaped(observerID))/resolution-manifest",
            headers: ["Authorization": "Bearer \(observerCredential)"]
        )
    }

    public func uploadTrackingObservations(
        _ observations: [TrackingObservationInput],
        observerCredential: String
    ) async throws -> TrackingObservationBatchResult {
        try await request(
            version: 1,
            path: "/tracking/evidence:batch",
            method: "POST",
            body: TrackingObservationBatchInput(observations: observations),
            headers: ["Authorization": "Bearer \(observerCredential)"]
        )
    }

    public func measurementHistory(
        sensorID: String,
        metric: String,
        from: Date,
        to: Date = Date(),
        limit: Int = 300
    ) async throws -> [MeasurementSample] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let query = queryString([
            URLQueryItem(name: "sensorId", value: sensorID),
            URLQueryItem(name: "metric", value: metric),
            URLQueryItem(name: "from", value: formatter.string(from: from)),
            URLQueryItem(name: "to", value: formatter.string(from: to)),
            URLQueryItem(name: "limit", value: String(max(2, min(limit, 2_000)))),
            URLQueryItem(name: "bucketSeconds", value: "900"),
        ])
        let value: HistoryEnvelope = try await request(version: 2, path: "/measurements/history?\(query)")
        return value.samples
    }

    public func eventStream() -> AsyncThrowingStream<ServerEvent, Error> {
        #if canImport(FoundationNetworking)
        return AsyncThrowingStream { continuation in
            continuation.finish(throwing: StuguAPIError(
                status: 0,
                code: "EVENT_STREAM_UNAVAILABLE",
                message: "Live events require an Apple platform."
            ))
        }
        #else
        let url = address.apiURL(version: 1, path: "/events")
        let session = session
        let edgeCredential = edgeCredential
        let redirectGuard = redirectGuard
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    Self.apply(edgeCredential, to: &request)
                    let (bytes, response) = try await session.bytes(
                        for: request,
                        delegate: redirectGuard
                    )
                    let http = response as? HTTPURLResponse
                    if let http,
                       let challenge = Self.edgeChallenge(
                           http,
                           hasCredential: edgeCredential != nil
                       ) {
                        throw challenge
                    }
                    guard http?.statusCode == 200 else {
                        throw StuguAPIError(
                            status: http?.statusCode ?? 0,
                            code: nil,
                            message: "The live connection could not be established."
                        )
                    }
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if let event = parser.consume(line: line) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        #endif
    }

    public func systemUpdateEventStream() -> AsyncThrowingStream<SystemUpdateEvent, Error> {
        #if canImport(FoundationNetworking)
        return AsyncThrowingStream { continuation in
            continuation.finish(throwing: StuguAPIError(
                status: 0,
                code: "EVENT_STREAM_UNAVAILABLE",
                message: "Live system updates require an Apple platform."
            ))
        }
        #else
        let url = address.apiURL(version: 1, path: "/system/updates/events")
        let session = session
        let edgeCredential = edgeCredential
        let redirectGuard = redirectGuard
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    Self.apply(edgeCredential, to: &request)
                    let (bytes, response) = try await session.bytes(
                        for: request,
                        delegate: redirectGuard
                    )
                    let http = response as? HTTPURLResponse
                    if let http,
                       let challenge = Self.edgeChallenge(
                           http,
                           hasCredential: edgeCredential != nil
                       ) {
                        throw challenge
                    }
                    guard http?.statusCode == 200 else {
                        throw StuguAPIError(
                            status: http?.statusCode ?? 0,
                            code: nil,
                            message: "Live system update status is unavailable."
                        )
                    }
                    let decoder = JSONDecoder()
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard let event = parser.consume(line: line),
                              event.type == "system-update" else {
                            continue
                        }
                        let update = try decoder.decode(
                            SystemUpdateEvent.self,
                            from: Data(event.data.utf8)
                        )
                        continuation.yield(update)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        #endif
    }

    public func trackingEventStream(
        propertyID: String,
        lastEventID: Int? = nil
    ) -> AsyncThrowingStream<ServerEvent, Error> {
        #if canImport(FoundationNetworking)
        return AsyncThrowingStream { continuation in
            continuation.finish(throwing: StuguAPIError(
                status: 0,
                code: "EVENT_STREAM_UNAVAILABLE",
                message: "Live tracking events require an Apple platform."
            ))
        }
        #else
        let url = address.apiURL(
            version: 1,
            path: "/properties/\(escaped(propertyID))/tracking-stream"
        )
        let session = session
        let edgeCredential = edgeCredential
        let redirectGuard = redirectGuard
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let lastEventID {
                        request.setValue(String(lastEventID), forHTTPHeaderField: "Last-Event-ID")
                    }
                    Self.apply(edgeCredential, to: &request)
                    let (bytes, response) = try await session.bytes(
                        for: request,
                        delegate: redirectGuard
                    )
                    let http = response as? HTTPURLResponse
                    if let http,
                       let challenge = Self.edgeChallenge(
                           http,
                           hasCredential: edgeCredential != nil
                       ) {
                        throw challenge
                    }
                    guard http?.statusCode == 200 else {
                        throw StuguAPIError(
                            status: http?.statusCode ?? 0,
                            code: nil,
                            message: "The live equipment connection could not be established."
                        )
                    }
                    var parser = SSEParser()
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if let event = parser.consume(line: line) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        #endif
    }

    public func clearCookies() {
        let storage = session.configuration.httpCookieStorage ?? HTTPCookieStorage.shared
        let apiURL = address.apiURL(version: 1, path: "/session")
        guard let cookies = storage.cookies(for: apiURL) else { return }
        for cookie in cookies {
            storage.deleteCookie(cookie)
        }
        csrfToken = nil
    }

    private struct EmptyResponse: Decodable {}

    /// Cleartext local origins never carry the token; a service token is a
    /// secret and Access only ever fronts the HTTPS hostname.
    static func apply(_ credential: EdgeCredential?, to request: inout URLRequest) {
        guard let credential, request.url?.scheme?.lowercased() == "https" else { return }
        request.setValue(credential.clientID, forHTTPHeaderField: EdgeCredential.clientIDHeader)
        request.setValue(
            credential.clientSecret,
            forHTTPHeaderField: EdgeCredential.clientSecretHeader
        )
    }

    /// Recognises Cloudflare Access answering in Stugu's place. Without this the
    /// caller decodes Cloudflare's HTML login page and reports it as malformed
    /// Stugu data, which tells the person nothing about what to fix.
    static func edgeChallenge(
        _ response: HTTPURLResponse,
        hasCredential: Bool
    ) -> StuguAPIError? {
        let authenticate = response.value(forHTTPHeaderField: "WWW-Authenticate") ?? ""
        let host = response.url?.host?.lowercased() ?? ""
        let challenged = authenticate.lowercased().hasPrefix("cloudflare-access")
            || host == "cloudflareaccess.com"
            || host.hasSuffix(".cloudflareaccess.com")
        guard challenged else { return nil }
        return StuguAPIError(
            status: response.statusCode,
            code: hasCredential ? "EDGE_ACCESS_REJECTED" : "EDGE_ACCESS_REQUIRED",
            message: hasCredential
                ? "Cloudflare Access rejected this app’s service token. Check the token and the Access policy that should allow it."
                : "This address is protected by Cloudflare Access. Add an Access service token so this app can connect."
        )
    }

    private func request<Response: Decodable>(
        version: Int,
        path: String,
        method: String = "GET",
        timeoutInterval: TimeInterval? = nil,
        headers: [String: String] = [:]
    ) async throws -> Response {
        try await request(
            version: version,
            path: path,
            method: method,
            encodedBody: nil,
            timeoutInterval: timeoutInterval,
            headers: headers
        )
    }

    private func request<Response: Decodable, Body: Encodable>(
        version: Int,
        path: String,
        method: String,
        body: Body,
        timeoutInterval: TimeInterval? = nil,
        headers: [String: String] = [:]
    ) async throws -> Response {
        try await request(
            version: version,
            path: path,
            method: method,
            encodedBody: try encoder.encode(body),
            timeoutInterval: timeoutInterval,
            headers: headers
        )
    }

    private func request<Response: Decodable>(
        version: Int,
        path: String,
        method: String,
        encodedBody: Data?,
        timeoutInterval: TimeInterval?,
        headers: [String: String]
    ) async throws -> Response {
        var request = URLRequest(url: address.apiURL(version: version, path: path))
        request.httpMethod = method
        if let timeoutInterval {
            request.timeoutInterval = timeoutInterval
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let encodedBody {
            request.httpBody = encodedBody
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if method != "GET", method != "HEAD", method != "OPTIONS", let csrfToken {
            request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
        }
        Self.apply(edgeCredential, to: &request)
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }

        let (data, response) = try await session.data(for: request, delegate: redirectGuard)
        guard let http = response as? HTTPURLResponse else {
            throw StuguAPIError(status: 0, code: nil, message: "Stugu returned an invalid response.")
        }
        if let challenge = Self.edgeChallenge(http, hasCredential: edgeCredential != nil) {
            throw challenge
        }
        if http.statusCode == 204 {
            do {
                return try decoder.decode(Response.self, from: Data("{}".utf8))
            } catch {
                throw StuguAPIError(status: 204, code: nil, message: "Stugu returned no content.")
            }
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { csrfToken = nil }
            let envelope = try? decoder.decode(ErrorEnvelope.self, from: data)
            throw StuguAPIError(
                status: http.statusCode,
                code: envelope?.error?.code,
                message: envelope?.error?.message ?? "Request failed with HTTP \(http.statusCode)."
            )
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw StuguAPIError(
                status: http.statusCode,
                code: "INVALID_RESPONSE",
                message: "Stugu returned data this app could not understand."
            )
        }
    }

    private func requestData(version: Int, path: String) async throws -> Data {
        var request = URLRequest(url: address.apiURL(version: version, path: path))
        request.httpMethod = "GET"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        Self.apply(edgeCredential, to: &request)
        let (data, response) = try await session.data(for: request, delegate: redirectGuard)
        guard let http = response as? HTTPURLResponse else {
            throw StuguAPIError(status: 0, code: nil, message: "Stugu returned an invalid response.")
        }
        if let challenge = Self.edgeChallenge(http, hasCredential: edgeCredential != nil) {
            throw challenge
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { csrfToken = nil }
            let envelope = try? decoder.decode(ErrorEnvelope.self, from: data)
            throw StuguAPIError(
                status: http.statusCode,
                code: envelope?.error?.code,
                message: envelope?.error?.message ?? "Request failed with HTTP \(http.statusCode)."
            )
        }
        return data
    }

    private func queryString(_ items: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.queryItems = items
        return components.percentEncodedQuery ?? ""
    }

    private func escaped(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
