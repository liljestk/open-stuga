import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case serverSetup
        case signIn
        case ownerSetupRequired
        case ready
    }

    private enum DefaultsKey {
        static let server = "stugu.server"
        static let selectedHome = "stugu.selectedHome"
        static let selectedProperty = "stugu.selectedProperty"
        static let pinnedOverviewScope = "stugu.overview.pinnedScope"
        static let pinnedOverviewTarget = "stugu.overview.pinnedTarget"
        static let overviewMetrics = "stugu.overview.metrics"
        static let units = "stugu.units"
        static let equipmentObservation = "stugu.tracking.mobileObserver.enabled"
        static let notificationsEnabled = "stugu.notifications.enabled"
        static let notificationRegistration = "stugu.notifications.registration"
        static let notificationAccountIdentity = "stugu.notifications.accountIdentity"
        static let notificationDeviceToken = "stugu.notifications.deviceToken"
        static let notificationMinimumSeverity = "stugu.notifications.minimumSeverity"
        static let notificationIncludeDetails = "stugu.notifications.includeDetails"
        static let watchServerIdentity = "stugu.watch.serverIdentity"
        static let watchServerBinding = "stugu.watch.serverBinding"
        static let watchAccountIdentity = "stugu.watch.accountIdentity"
        static let watchAccountBinding = "stugu.watch.accountBinding"
    }

    enum QuickCaptureSaveState: Equatable {
        case saved
        case queued
    }

    private struct TrackingWorkspaceData {
        let capabilities: TrackingCapabilities?
        let settings: TrackingPropertySettings?
        let snapshot: TrackingMapSnapshot?
    }

    private struct RequestGeneration: Equatable, Sendable {
        let account: Int
        let scope: Int
    }

    private struct ScopeRequest: Sendable {
        let generation: RequestGeneration
        let propertyID: String?
        let homeID: String?
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var serverAddress: ServerAddress?
    @Published private(set) var serverVersion: String?
    @Published private(set) var edgeAccessRequired = false
    @Published private(set) var session: AppSession?
    @Published private(set) var properties: [StuguProperty] = []
    @Published private(set) var houses: [House] = []
    @Published private(set) var sensors: [Sensor] = []
    @Published private(set) var definitions: [MeasurementDefinition] = []
    @Published private(set) var snapshot: [MeasurementSnapshotEntry] = []
    @Published private(set) var propertyMeasurementSnapshots: [String: [MeasurementSnapshotEntry]] = [:]
    @Published private(set) var tpLinkDevices: [TpLinkDiscoveredDevice] = []
    @Published private(set) var latestOpeningStateObservation: OpeningStateObservation?
    @Published private(set) var alerts: [AlertEvent] = []
    @Published private(set) var rules: [AlertRule] = []
    @Published private(set) var propertyInventory: PropertyInventorySnapshot?
    @Published private(set) var todayContext: TodayContext?
    @Published private(set) var homeMonitoring: HomeMonitoringDetailResponse?
    @Published private(set) var homeMonitoringAvailability: HomeMonitoringAvailability = .unavailable
    @Published private(set) var systemUpdateStatus: SystemUpdateStatus?
    @Published private(set) var systemUpdateError: String?
    @Published private(set) var pendingActions: [PendingCompanionAction] = []
    @Published private(set) var selectedHomeID: String?
    @Published private(set) var selectedPropertyID: String?
    @Published private(set) var pinnedOverviewScope = GlanceOverviewScope(
        rawValue: UserDefaults.standard.string(forKey: DefaultsKey.pinnedOverviewScope) ?? ""
    ) ?? .home
    @Published private(set) var pinnedOverviewTargetID = UserDefaults.standard.string(
        forKey: DefaultsKey.pinnedOverviewTarget
    )
    @Published private(set) var overviewMetrics: Set<GlanceOverviewMetric> = {
        let stored = UserDefaults.standard.string(forKey: DefaultsKey.overviewMetrics) ?? ""
        let selected = Set(stored.split(separator: ",").compactMap {
            GlanceOverviewMetric(rawValue: String($0))
        })
        return selected.isEmpty ? Set(GlanceOverviewMetric.allCases) : selected
    }()
    @Published private(set) var trackingCapabilities: TrackingCapabilities?
    @Published private(set) var trackingSettings: TrackingPropertySettings?
    @Published private(set) var trackingSnapshot: TrackingMapSnapshot?
    @Published private(set) var trackingLiveConnected = false
    @Published private(set) var equipmentObservationEnabled = UserDefaults.standard.bool(
        forKey: DefaultsKey.equipmentObservation
    )
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var liveConnected = false
    @Published private(set) var usingCachedData = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var notificationProviderConfigured = false
    @Published private(set) var notificationRegistration: IOSNotificationRegistration?
    @Published private(set) var notificationsEnabled = UserDefaults.standard.bool(
        forKey: DefaultsKey.notificationsEnabled
    )
    @Published var notificationMinimumSeverity = IOSPushMinimumSeverity(
        rawValue: UserDefaults.standard.string(
            forKey: DefaultsKey.notificationMinimumSeverity
        ) ?? ""
    ) ?? .warning {
        didSet {
            UserDefaults.standard.set(
                notificationMinimumSeverity.rawValue,
                forKey: DefaultsKey.notificationMinimumSeverity
            )
            Task { await syncNotificationRegistration() }
        }
    }
    @Published var notificationIncludeDetails = UserDefaults.standard.bool(
        forKey: DefaultsKey.notificationIncludeDetails
    ) {
        didSet {
            UserDefaults.standard.set(
                notificationIncludeDetails,
                forKey: DefaultsKey.notificationIncludeDetails
            )
            Task { await syncNotificationRegistration() }
        }
    }
    @Published var pendingDeepLink: CompanionDeepLink?
    @Published var requestedEquipmentID: String?
    @Published var errorMessage: String?
    @Published var unitSystem = DisplayUnitSystem(
        rawValue: UserDefaults.standard.string(forKey: DefaultsKey.units) ?? ""
    ) ?? .metric {
        didSet {
            UserDefaults.standard.set(unitSystem.rawValue, forKey: DefaultsKey.units)
        }
    }

    private var client: StuguAPIClient?
    private var eventTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var trackingEventTask: Task<Void, Never>?
    private var trackingEventRefreshTask: Task<Void, Never>?
    private var requestGeneration = 0
    private var scopeGeneration = 0
    private let cacheStore = CompanionCacheStore(
        fileURL: CompanionCacheStore.defaultFileURL()
    )
    private let widgetStore = CompanionWidgetSnapshotStore()
    private let edgeCredentialStore = EdgeCredentialStore()
    private var historyCache: [String: CompanionHistorySeries] = [:]
    private var cachedAccountIdentity: String?
    let mobileTracking = MobileTrackingController()
    let memberLocationSharing = MemberLocationSharingController()

    var selectedHome: House? {
        houses.first { $0.id == selectedHomeID }
    }

    var selectedProperty: StuguProperty? {
        if let selectedPropertyID,
           let property = properties.first(where: { $0.id == selectedPropertyID }) {
            return property
        }
        guard let propertyID = selectedHome?.propertyId else { return nil }
        return properties.first { $0.id == propertyID }
    }

    var pinnedOverviewHome: House? {
        guard pinnedOverviewScope == .home else { return nil }
        return houses.first { $0.id == pinnedOverviewTargetID }
    }

    var pinnedOverviewProperty: StuguProperty? {
        let propertyID = pinnedOverviewScope == .property
            ? pinnedOverviewTargetID
            : pinnedOverviewHome?.propertyId
        return properties.first { $0.id == propertyID }
    }

    var trackingAvailable: Bool {
        trackingCapabilities?.featureEnabled("tracking.enabled") == true
    }

    var selectedPropertyAreas: [PropertyArea] {
        guard propertyInventory?.propertyId == selectedPropertyID else { return [] }
        return propertyInventory?.areas ?? []
    }

    var selectedPropertyEquipment: [AreaEquipment] {
        guard propertyInventory?.propertyId == selectedPropertyID else { return [] }
        return (propertyInventory?.equipment ?? []).sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    var selectedPropertyHouses: [House] {
        guard let propertyID = selectedProperty?.id else { return [] }
        return houses
            .filter { $0.propertyId == propertyID }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func trackedState(for equipmentID: String) -> TrackedEquipmentState? {
        guard let tracked = trackingSnapshot?.equipment.first(where: {
            $0.equipment.id == equipmentID
        }) else {
            return nil
        }
        let equipment = selectedPropertyEquipment.first { $0.id == equipmentID }
            ?? tracked.equipment
        return TrackedEquipmentState(
            equipment: equipment,
            endpoint: tracked.endpoint,
            binding: tracked.binding,
            position: tracked.position
        )
    }

    func areaName(for areaID: String?) -> String? {
        guard let areaID else { return nil }
        return selectedPropertyAreas.first { $0.id == areaID }?.name
    }

    func houseName(for houseID: String?) -> String? {
        guard let houseID else { return nil }
        return selectedPropertyHouses.first { $0.id == houseID }?.name
    }

    func equipmentPlacementName(_ equipment: AreaEquipment) -> String {
        if let name = areaName(for: equipment.areaId) {
            return name
        }
        if let name = houseName(for: equipment.houseId) {
            return name
        }
        if equipment.areaId != nil { return "Assigned area" }
        if equipment.houseId != nil { return "Assigned Home" }
        return equipment.location == nil ? "Unassigned" : "Pinned on Property map"
    }

    func equipmentAttachments(for equipmentID: String) -> [EquipmentAttachment] {
        guard propertyInventory?.propertyId == selectedPropertyID else { return [] }
        return (propertyInventory?.attachments ?? [])
            .filter { $0.equipmentId == equipmentID }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func equipmentLinks(for equipmentID: String) -> [EquipmentLink] {
        guard propertyInventory?.propertyId == selectedPropertyID else { return [] }
        return (propertyInventory?.links ?? [])
            .filter { $0.equipmentId == equipmentID }
            .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    var mobileTrackingAvailable: Bool {
        trackingCapabilities?.featureEnabled("tracking.mobileObserver.enabled") == true
            && !selectedPropertyReadOnly
    }

    var memberLocationSharingAvailable: Bool {
        trackingCapabilities?.featureEnabled("tracking.userLocationSharing.enabled") == true
            && trackingCapabilities?.featureEnabled("tracking.liveMap.enabled") == true
            && !selectedPropertyReadOnly
    }

    var equipmentStates: [TrackedEquipmentState] {
        return selectedPropertyEquipment.map { equipment in
            trackedState(for: equipment.id) ?? TrackedEquipmentState(equipment: equipment)
        }.sorted {
            $0.equipment.name.localizedStandardCompare($1.equipment.name) == .orderedAscending
        }
    }

    var selectedSensors: [Sensor] {
        guard let selectedHomeID else { return [] }
        return sensors
            .filter { $0.houseId == selectedHomeID && $0.enabled }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var selectedHomeFloors: [StuguFloor] {
        selectedHome?.floors.sorted {
            if $0.elevation != $1.elevation { return $0.elevation < $1.elevation }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        } ?? []
    }

    var selectedConditions: [SensorCondition] {
        conditions(forHomeID: selectedHomeID)
    }

    func conditions(forHomeID homeID: String?) -> [SensorCondition] {
        guard let homeID else { return [] }
        let homeSnapshot = propertyMeasurementSnapshots[homeID]
            ?? (homeID == selectedHomeID ? snapshot : [])
        let measurementsBySensor = Dictionary(uniqueKeysWithValues: homeSnapshot.map {
            ($0.sensorId, $0.measurements)
        })
        let contactDevices = homeID == selectedHomeID ? selectedContactDevices : []
        return sensors.filter { sensor in
            sensor.houseId == homeID && sensor.enabled
        }.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }.filter { sensor in
            !contactDevices.contains { device in
                device.deviceId == sensor.tpLinkDeviceId
                    && (sensor.tpLinkConnectionId == nil
                        || sensor.tpLinkConnectionId == device.connectionId)
            }
        }.map {
            SensorCondition(sensor: $0, measurements: measurementsBySensor[$0.id] ?? [:])
        }
    }

    var selectedContactDevices: [TpLinkDiscoveredDevice] {
        guard let selectedHomeID else { return [] }
        return tpLinkDevices.filter {
            $0.isContact && ($0.houseId == nil || $0.houseId == selectedHomeID)
        }.sorted {
            contactDisplayName($0).localizedStandardCompare(contactDisplayName($1))
                == .orderedAscending
        }
    }

    func contactDevice(id: String) -> TpLinkDiscoveredDevice? {
        tpLinkDevices.first { $0.id == id }
    }

    func contactOpeningAssignment(
        for device: TpLinkDiscoveredDevice
    ) -> ContactOpeningAssignment? {
        guard let homeID = device.houseId ?? selectedHomeID,
              let home = houses.first(where: { $0.id == homeID }) else {
            return nil
        }
        for floor in home.floors {
            for element in floor.planElements ?? [] {
                guard ["door", "window", "vent"].contains(element.kind),
                      let binding = element.stateBinding,
                      binding.provider == "tapo",
                      binding.externalId == device.deviceId,
                      binding.connectionId == nil
                        || binding.connectionId == device.connectionId else {
                    continue
                }
                return ContactOpeningAssignment(
                    floorId: floor.id,
                    floorName: floor.name,
                    elementId: element.id,
                    kind: element.kind,
                    label: nonEmpty(element.label)
                        ?? defaultOpeningLabel(kind: element.kind),
                    invert: binding.invert ?? false,
                    staleAfterSeconds: binding.staleAfterSeconds ?? 900
                )
            }
        }
        guard let mapped = device.mappedOpening else { return nil }
        let floor = home.floors.first { $0.id == mapped.floorId }
        let element = floor?.planElements?.first { $0.id == mapped.elementId }
        return ContactOpeningAssignment(
            floorId: mapped.floorId,
            floorName: floor?.name ?? "Unknown floor",
            elementId: mapped.elementId,
            kind: mapped.kind,
            label: nonEmpty(mapped.label)
                ?? nonEmpty(element?.label)
                ?? defaultOpeningLabel(kind: mapped.kind),
            invert: element?.stateBinding?.invert ?? false,
            staleAfterSeconds: element?.stateBinding?.staleAfterSeconds ?? 900
        )
    }

    func contactDisplayName(_ device: TpLinkDiscoveredDevice) -> String {
        nonEmpty(device.alias)
            ?? contactOpeningAssignment(for: device)?.label
            ?? device.model
    }

    func contactState(
        for device: TpLinkDiscoveredDevice,
        now: Date = Date()
    ) -> StuguOpeningState {
        guard let isOpen = device.contactOpen,
              let lastSeen = device.lastSeenDate else {
            return .unknown
        }
        let assignment = contactOpeningAssignment(for: device)
        let staleAfter = TimeInterval(assignment?.staleAfterSeconds ?? 900)
        guard now.timeIntervalSince(lastSeen) <= staleAfter,
              now.timeIntervalSince(lastSeen) >= -300 else {
            return .unknown
        }
        let effectiveOpen = assignment?.invert == true ? !isOpen : isOpen
        return effectiveOpen ? .open : .closed
    }

    func contactHistory(
        device: TpLinkDiscoveredDevice,
        hours: Int,
        to: Date = Date()
    ) async throws -> [OpeningStateObservation] {
        guard !usingCachedData,
              let client,
              let homeID = device.houseId ?? selectedHomeID else {
            throw StuguAPIError(
                status: 0,
                code: "OFFLINE",
                message: "Opening history is unavailable while this iPhone is offline."
            )
        }
        return try await client.openingStateHistory(
            houseID: homeID,
            from: to.addingTimeInterval(-TimeInterval(max(1, hours)) * 3_600),
            to: to
        )
    }

    private func defaultOpeningLabel(kind: String) -> String {
        switch kind {
        case "window": "Window"
        case "vent": "Vent"
        default: "Door"
        }
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    var selectedHomeAlerts: [AlertEvent] {
        let sensorIDs = Set(sensors.filter { $0.houseId == selectedHomeID }.map(\.id))
        return sortedAlerts(alerts.filter { sensorIDs.contains($0.sensorId) })
    }

    var activeAlerts: [AlertEvent] {
        sortedAlerts(alerts.filter(\.isActive))
    }

    var monitorSummary: HomeMonitorSummary {
        switch homeMonitoringAvailability {
        case .available:
            guard let homeMonitoring else { return .serverUnavailable }
            let mapped = HomeMonitorSummary.from(server: homeMonitoring)
            if let insight = homeMonitoring.insights.first {
                return HomeMonitorSummary(
                    state: mapped.state,
                    title: demoMonitoringText(monitoringText(
                        code: insight.titleCode,
                        fallback: insight.fallbackTitle,
                        target: insight.target
                    )),
                    detail: monitoringText(
                        code: insight.summaryCode,
                        fallback: insight.fallbackSummary,
                        target: insight.target
                    )
                )
            }
            let statusCode = "monitoring.status.\(homeMonitoring.house.pulseStatus)"
            return HomeMonitorSummary(
                state: mapped.state,
                title: demoMonitoringText(monitoringText(
                    code: "\(statusCode).title",
                    fallback: mapped.title,
                    target: nil
                )),
                detail: monitoringText(
                    code: "\(statusCode).detail",
                    fallback: mapped.detail,
                    target: nil
                )
            )
        case .serverUpgradeRequired:
            return HomeMonitorSummary(
                state: .limited,
                title: monitoringText(
                    code: "monitoring.availability.server-upgrade-required.title",
                    fallback: HomeMonitorSummary.serverUpgradeRequired.title,
                    target: nil
                ),
                detail: monitoringText(
                    code: "monitoring.availability.server-upgrade-required.detail",
                    fallback: HomeMonitorSummary.serverUpgradeRequired.detail,
                    target: nil
                )
            )
        case .unavailable:
            return HomeMonitorSummary(
                state: .limited,
                title: monitoringText(
                    code: "monitoring.availability.unavailable.title",
                    fallback: HomeMonitorSummary.serverUnavailable.title,
                    target: nil
                ),
                detail: monitoringText(
                    code: "monitoring.availability.unavailable.detail",
                    fallback: HomeMonitorSummary.serverUnavailable.detail,
                    target: nil
                )
            )
        }
    }

    var todayRecommendation: TodayRecommendation? {
        guard !usingCachedData,
              homeMonitoringAvailability == .available,
              let homeMonitoring,
              let insight = homeMonitoring.insights.first else {
            return nil
        }
        return TodayRecommendation(
            kind: .monitoring,
            title: demoMonitoringText(monitoringText(
                code: insight.titleCode,
                fallback: insight.fallbackTitle,
                target: insight.target
            )),
            detail: monitoringText(
                code: insight.summaryCode,
                fallback: insight.fallbackSummary,
                target: insight.target
            ),
            evidence: monitoringText(
                code: insight.actionCode,
                fallback: insight.fallbackAction,
                target: insight.target
            )
        )
    }

    private func monitoringText(
        code: String,
        fallback: String,
        target: HomeMonitoringInsightTarget?
    ) -> String {
        let template = NSLocalizedString(
            code,
            tableName: "Monitoring",
            bundle: .main,
            value: fallback,
            comment: "Server-authoritative Home monitoring copy"
        )
        guard let placeholder = template.range(of: "%@") else { return template }
        let location = target?.room?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sensor = target?.sensorName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let replacement = location?.isEmpty == false ? location! : sensor?.isEmpty == false ? sensor! : "Home"
        return template.replacingCharacters(in: placeholder, with: replacement)
    }

    private func demoMonitoringText(_ text: String) -> String {
        guard homeMonitoring?.dataMode == "demo" else { return text }
        let label = NSLocalizedString(
            "monitoring.data-mode.demo",
            tableName: "Monitoring",
            bundle: .main,
            value: "Demo data",
            comment: "Label for server-authoritative monitoring derived from demo data"
        )
        return "\(label): \(text)"
    }

    var pendingActionCount: Int { pendingActions.count }

    var isReadOnly: Bool {
        session?.readOnly ?? true
    }

    var selectedPropertyReadOnly: Bool {
        isReadOnly || selectedProperty?.stuguby?.isReadOnly == true
    }

    var selectedHomeReadOnly: Bool {
        isReadOnly || selectedHome?.stuguby?.isReadOnly == true
    }

    var inventoryMutationsAvailable: Bool {
        phase == .ready && !usingCachedData && !selectedPropertyReadOnly
    }

    var roomPlanCaptureAvailable: Bool {
        phase == .ready && !usingCachedData && !selectedHomeReadOnly
    }

    func canAcknowledgeAlert(_ alert: AlertEvent) -> Bool {
        guard phase == .ready,
              !isReadOnly,
              let alertHome = house(for: alert.sensorId) else {
            return false
        }
        return alertHome.stuguby?.isReadOnly != true
    }

    var selectedHomeIsForeignShared: Bool {
        selectedHome?.stuguby?.isForeignSharedHome == true
    }

    var canManageSystemUpdates: Bool {
        guard !usingCachedData, let role = session?.tenant.role else { return false }
        return role == "owner" || role == "admin"
    }

    var serverDisplayName: String {
        serverAddress?.displayName ?? "Stugu"
    }

    var isEncryptedConnection: Bool {
        serverAddress?.origin.scheme?.lowercased() == "https"
    }

    var suggestedServerAddress: String {
        serverAddress?.origin.absoluteString
            ?? UserDefaults.standard.string(forKey: DefaultsKey.server)
            ?? ""
    }

    var suggestedEdgeCredential: EdgeCredential? {
        guard let address = try? ServerAddress(suggestedServerAddress) else { return nil }
        return edgeCredentialStore.credential(serverOrigin: address.origin.absoluteString)
    }

    func start() async {
        guard let saved = UserDefaults.standard.string(forKey: DefaultsKey.server) else {
            phase = .serverSetup
            return
        }
        do {
            let address = try ServerAddress(saved)
            do {
                try await configure(address: address, persist: false)
            } catch {
                if await restoreCachedWorkspace(address: address) {
                    errorMessage = "Stugu could not be reached. Showing protected information saved on this iPhone."
                    startEventLoop()
                } else {
                    throw error
                }
            }
        } catch {
            errorMessage = friendlyMessage(for: error)
            edgeAccessRequired = isEdgeAccessFailure(error)
            phase = .serverSetup
        }
    }

    func connect(to input: String, edgeClientID: String, edgeClientSecret: String) async {
        errorMessage = nil
        edgeAccessRequired = false
        do {
            let address = try ServerAddress(input)
            let origin = address.origin.absoluteString
            if let credential = try EdgeCredential.optional(
                clientID: edgeClientID,
                clientSecret: edgeClientSecret
            ) {
                try edgeCredentialStore.save(credential, serverOrigin: origin)
            } else {
                edgeCredentialStore.remove(serverOrigin: origin)
            }
            let previousValue = UserDefaults.standard.string(forKey: DefaultsKey.server)
            serverAddress = address
            UserDefaults.standard.set(address.origin.absoluteString, forKey: DefaultsKey.server)
            if let previousValue,
               let previousAddress = try? ServerAddress(previousValue),
               previousAddress != address {
                equipmentObservationEnabled = false
                UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
                let previousOrigin = previousAddress.origin.absoluteString
                let previousClient = StuguAPIClient(
                    address: previousAddress,
                    edgeCredential: edgeCredentialStore.credential(serverOrigin: previousOrigin)
                )
                if let registrationID = UserDefaults.standard.string(
                    forKey: DefaultsKey.notificationRegistration
                ) {
                    try? await previousClient.deleteIOSNotificationRegistration(
                        id: registrationID
                    )
                }
                UIApplication.shared.unregisterForRemoteNotifications()
                notificationsEnabled = false
                UserDefaults.standard.set(
                    false,
                    forKey: DefaultsKey.notificationsEnabled
                )
                UserDefaults.standard.removeObject(
                    forKey: DefaultsKey.notificationRegistration
                )
                UserDefaults.standard.removeObject(
                    forKey: DefaultsKey.notificationAccountIdentity
                )
                await previousClient.clearCookies()
                try? await cacheStore.remove()
                clearGlanceableState()
            }
            do {
                try await configure(address: address, persist: true)
            } catch {
                if await restoreCachedWorkspace(address: address) {
                    errorMessage = "Stugu could not be reached. Showing protected information saved on this iPhone."
                    startEventLoop()
                } else {
                    throw error
                }
            }
        } catch {
            errorMessage = friendlyMessage(for: error)
            edgeAccessRequired = isEdgeAccessFailure(error)
            phase = .serverSetup
        }
    }

    func signIn(email: String, password: String) async {
        guard let client else { return }
        let generation = requestGeneration
        errorMessage = nil
        do {
            let session = try await client.login(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            guard generation == requestGeneration else { return }
            await adoptCachedState(for: session)
            self.session = session
            try await loadWorkspace()
            guard generation == requestGeneration else { return }
            phase = .ready
            await finishOnlineRefresh()
            startEventLoop()
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func refresh() async {
        guard phase == .ready, !isRefreshing else { return }
        let generation = currentRequestGeneration
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            if usingCachedData, let client {
                let refreshedSession = try await client.currentSession()
                guard isCurrent(generation) else { return }
                guard refreshedSession.authenticated else {
                    throw StuguAPIError(
                        status: 401,
                        code: "UNAUTHORIZED",
                        message: "Sign in to continue."
                    )
                }
                await adoptCachedState(for: refreshedSession)
                session = refreshedSession
            }
            try await loadWorkspace()
            guard isCurrent(generation) else { return }
            await finishOnlineRefresh()
            errorMessage = nil
        } catch {
            guard isCurrent(generation) else { return }
            if isTransient(error), !properties.isEmpty {
                usingCachedData = true
                liveConnected = false
                errorMessage = friendlyMessage(for: error)
            } else {
                handleAuthenticatedError(error)
            }
        }
    }

    func refreshSystemUpdateStatus() async {
        guard canManageSystemUpdates, let client else {
            systemUpdateStatus = nil
            systemUpdateError = nil
            return
        }
        do {
            systemUpdateStatus = try await client.systemUpdateStatus()
            systemUpdateError = nil
        } catch let error as StuguAPIError where error.status == 401 {
            handleAuthenticatedError(error)
        } catch let error as StuguAPIError where error.status == 403 {
            systemUpdateStatus = nil
            systemUpdateError = nil
        } catch {
            systemUpdateError = friendlyMessage(for: error)
        }
    }

    func monitorSystemUpdates() async {
        await refreshSystemUpdateStatus()
        var streamAvailable = true
        while !Task.isCancelled, canManageSystemUpdates {
            guard let client else { return }
            if streamAvailable {
                do {
                    let updates = await client.systemUpdateEventStream()
                    for try await update in updates {
                        guard !Task.isCancelled, canManageSystemUpdates else { return }
                        await applySystemUpdateEvent(update)
                    }
                } catch let error as StuguAPIError where error.status == 404 {
                    streamAvailable = false
                } catch let error as StuguAPIError where error.status == 401 {
                    handleAuthenticatedError(error)
                    return
                } catch let error as StuguAPIError where error.status == 403 {
                    systemUpdateStatus = nil
                    systemUpdateError = nil
                    return
                } catch {
                    if Task.isCancelled { return }
                }
            }

            await refreshSystemUpdateStatus()
            let delay = systemUpdateStatus?.operation?.isActive == true ? 2.0 : 15.0
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
        }
    }

    private func applySystemUpdateEvent(_ event: SystemUpdateEvent) async {
        if systemUpdateStatus == nil {
            await refreshSystemUpdateStatus()
        }
        guard let status = systemUpdateStatus else { return }
        systemUpdateStatus = SystemUpdateStatus(
            currentVersion: event.currentVersion,
            latestVersion: event.latestVersion,
            updateAvailable: event.updateAvailable,
            latestRelease: status.latestRelease,
            releases: status.releases,
            lastCheckedAt: status.lastCheckedAt,
            checkError: status.checkError,
            settings: status.settings,
            nextUpdateWindowAt: status.nextUpdateWindowAt,
            capability: event.capability,
            operation: event.operation
        )
        serverVersion = event.currentVersion
        if !ServerFeatureSupport.homeMonitoring(systemVersion: event.currentVersion) {
            homeMonitoring = nil
            homeMonitoringAvailability = .serverUpgradeRequired
        }
        systemUpdateError = nil
    }

    func selectHome(_ id: String) async {
        guard let home = houses.first(where: { $0.id == id }), let client else { return }
        let propertyChanged = selectedPropertyID != home.propertyId
        let generation = beginScopeChange(propertyChanged: propertyChanged)
        if propertyChanged {
            await memberLocationSharing.stopSharing()
        }
        guard isCurrent(generation) else { return }
        let scope = ScopeRequest(
            generation: generation,
            propertyID: home.propertyId,
            homeID: id
        )
        adoptScopeSelection(propertyID: home.propertyId, homeID: id)
        do {
            try await reloadSelectedScope(client: client, request: scope)
            guard isCurrent(scope) else { return }
            errorMessage = nil
        } catch {
            guard isCurrent(scope) else { return }
            handleAuthenticatedError(error)
        }
    }

    func selectProperty(_ id: String) async {
        guard properties.contains(where: { $0.id == id }), let client else { return }
        let propertyChanged = selectedPropertyID != id
        let generation = beginScopeChange(propertyChanged: propertyChanged)
        if propertyChanged {
            await memberLocationSharing.stopSharing()
        }
        guard isCurrent(generation) else { return }
        let nextHomeID = selectedHome?.propertyId == id
            ? selectedHomeID
            : houses.first(where: { $0.propertyId == id })?.id
        let scope = ScopeRequest(
            generation: generation,
            propertyID: id,
            homeID: nextHomeID
        )
        adoptScopeSelection(propertyID: id, homeID: nextHomeID)
        do {
            try await reloadSelectedScope(client: client, request: scope)
            guard isCurrent(scope) else { return }
            errorMessage = nil
        } catch {
            guard isCurrent(scope) else { return }
            handleAuthenticatedError(error)
        }
    }

    func pinOverview(scope: GlanceOverviewScope, targetID: String) async {
        switch scope {
        case .home:
            guard houses.contains(where: { $0.id == targetID }) else { return }
        case .property:
            guard properties.contains(where: { $0.id == targetID }) else { return }
        }
        pinnedOverviewScope = scope
        pinnedOverviewTargetID = targetID
        UserDefaults.standard.set(scope.rawValue, forKey: DefaultsKey.pinnedOverviewScope)
        UserDefaults.standard.set(targetID, forKey: DefaultsKey.pinnedOverviewTarget)
        await reloadPinnedOverviewSnapshots()
    }

    func setOverviewMetric(_ metric: GlanceOverviewMetric, enabled: Bool) {
        var next = overviewMetrics
        if enabled {
            next.insert(metric)
        } else if next.count > 1 {
            next.remove(metric)
        }
        guard !next.isEmpty else { return }
        overviewMetrics = next
        let stored = GlanceOverviewMetric.allCases
            .filter(next.contains)
            .map(\.rawValue)
            .joined(separator: ",")
        UserDefaults.standard.set(stored, forKey: DefaultsKey.overviewMetrics)
    }

    @discardableResult
    func acknowledge(_ alert: AlertEvent) async -> Bool {
        guard canAcknowledgeAlert(alert) else {
            errorMessage = "This Home is read-only and its alerts cannot be changed."
            return false
        }
        let generation = requestGeneration
        if usingCachedData || client == nil {
            return await queueAlertAcknowledgement(alert)
        }
        do {
            let updated = try await client!.acknowledgeAlert(id: alert.id)
            guard generation == requestGeneration else { return false }
            if let index = alerts.firstIndex(where: { $0.id == updated.id }) {
                alerts[index] = updated
            }
            cancelLocalAlertReminder(alertID: updated.id)
            await persistCompanionState()
            errorMessage = nil
            return true
        } catch {
            if isTransient(error) {
                return await queueAlertAcknowledgement(alert)
            } else {
                handleAuthenticatedError(error)
                return false
            }
        }
    }

    @discardableResult
    func acknowledgeAlert(id: String, expectedHomeID: String? = nil) async -> Bool {
        if let alert = alerts.first(where: { $0.id == id }) {
            if let expectedHomeID,
               house(for: alert.sensorId)?.id != expectedHomeID {
                return false
            }
            return await acknowledge(alert)
        }
        // A Watch action must never cross Home scope merely because its alert
        // is absent from the current cache and cannot be verified locally.
        guard expectedHomeID == nil else { return false }
        guard phase == .ready, !isReadOnly else {
            errorMessage = "This account cannot change alerts."
            return false
        }
        guard let client, !usingCachedData else {
            if await enqueue(PendingCompanionAction(
                kind: .acknowledgeAlert,
                createdAt: iso8601(Date()),
                alertId: id
            )) {
                cancelLocalAlertReminder(alertID: id)
                return true
            }
            return false
        }
        do {
            _ = try await client.acknowledgeAlert(id: id)
            cancelLocalAlertReminder(alertID: id)
            await refresh()
            return true
        } catch {
            if isTransient(error) {
                if await enqueue(PendingCompanionAction(
                    kind: .acknowledgeAlert,
                    createdAt: iso8601(Date()),
                    alertId: id
                )) {
                    cancelLocalAlertReminder(alertID: id)
                    return true
                }
                return false
            } else {
                handleAuthenticatedError(error)
                return false
            }
        }
    }

    func importRoomPlanFloor(
        _ floor: StuguFloor,
        capturedAt: String,
        expectedHouseUpdatedAt: String
    ) async throws {
        guard !selectedHomeReadOnly else {
            throw StuguAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This Home's floor plan is read-only."
            )
        }
        guard phase == .ready,
              !usingCachedData,
              let client,
              let home = selectedHome else {
            throw StuguAPIError(
                status: 503,
                code: "ONLINE_REQUIRED",
                message: "Reconnect to Stugu before importing a room scan."
            )
        }
        guard home.updatedAt == expectedHouseUpdatedAt,
              home.floors.contains(where: { $0.id == floor.id }) else {
            throw StuguAPIError(
                status: 409,
                code: "ROOMPLAN_STALE_HOME",
                message: "The Home changed after scanning. Refresh and review the floor again."
            )
        }
        let generation = requestGeneration
        let updated = try await client.importRoomPlanFloor(
            houseID: home.id,
            floor: floor,
            capturedAt: capturedAt,
            expectedHouseUpdatedAt: expectedHouseUpdatedAt
        )
        guard generation == requestGeneration, selectedHomeID == updated.id else { return }
        if let index = houses.firstIndex(where: { $0.id == updated.id }) {
            houses[index] = updated
        }
        lastUpdated = Date()
        await persistCompanionState()
    }

    func setEquipmentObservationEnabled(_ enabled: Bool) async {
        if !enabled {
            equipmentObservationEnabled = false
            UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
            mobileTracking.disable()
            return
        }
        guard mobileTrackingAvailable,
              let client,
              let serverAddress,
              let property = selectedProperty,
              let capabilities = trackingCapabilities else {
            errorMessage = "Equipment observation is not available for this Property."
            return
        }
        let scope = currentScopeRequest
        do {
            let settings: TrackingPropertySettings
            if let trackingSettings {
                settings = trackingSettings
            } else {
                settings = try await client.trackingPropertySettings(propertyID: property.id)
            }
            guard isCurrent(scope) else { return }
            self.trackingSettings = settings
            try await mobileTracking.enable(
                client: client,
                serverOrigin: serverAddress.origin.absoluteString,
                propertyID: property.id,
                capabilities: capabilities,
                settings: settings
            )
            guard isCurrent(scope) else { return }
            equipmentObservationEnabled = true
            UserDefaults.standard.set(true, forKey: DefaultsKey.equipmentObservation)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            guard isCurrent(scope) else { return }
            equipmentObservationEnabled = false
            UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
            errorMessage = friendlyMessage(for: error)
        }
    }

    func removeMobileTrackingObserver() async {
        let scope = currentScopeRequest
        do {
            try await mobileTracking.removeObserverRegistration()
            guard isCurrent(scope) else { return }
            equipmentObservationEnabled = false
            UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
            errorMessage = nil
        } catch {
            guard isCurrent(scope) else { return }
            errorMessage = friendlyMessage(for: error)
        }
    }

    func findNearby(_ equipment: TrackedEquipmentState) async {
        guard equipmentObservationEnabled,
              let client else {
            errorMessage = "Turn on equipment observation before starting Find nearby."
            return
        }
        let scope = currentScopeRequest
        do {
            let descriptor = try await client.trackingFindDescriptor(equipmentID: equipment.id)
            guard isCurrent(scope) else { return }
            mobileTracking.beginFind(descriptor)
            errorMessage = nil
        } catch {
            guard isCurrent(scope) else { return }
            errorMessage = friendlyMessage(for: error)
        }
    }

    func stopFindingNearby() {
        mobileTracking.endFind()
    }

    private func onlinePropertyMutationClient() throws -> StuguAPIClient {
        guard !selectedPropertyReadOnly else {
            throw StuguAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This Property is read-only and cannot be changed."
            )
        }
        guard phase == .ready, !usingCachedData, let client else {
            throw StuguAPIError(
                status: 503,
                code: "ONLINE_REQUIRED",
                message: "Reconnect to Stugu before changing Property inventory."
            )
        }
        return client
    }

    @discardableResult
    func createEquipment(_ input: AreaEquipmentCreateInput) async throws -> AreaEquipment {
        let client = try onlinePropertyMutationClient()
        guard input.propertyId == selectedProperty?.id,
              equipmentPlacementIsValid(areaID: input.areaId, houseID: input.houseId) else {
            throw StuguAPIError(
                status: 422,
                code: "PLACEMENT_SCOPE_MISMATCH",
                message: "Choose a location in the selected Property."
            )
        }
        let equipment = try await client.createAreaEquipment(input)
        try await loadInventoryWorkspace()
        errorMessage = nil
        return equipment
    }

    @discardableResult
    func updateEquipment(
        id: String,
        input: AreaEquipmentUpdateInput
    ) async throws -> AreaEquipment {
        let client = try onlinePropertyMutationClient()
        guard selectedPropertyEquipment.contains(where: { $0.id == id }),
              !input.updatesPlacement
                || equipmentPlacementIsValid(areaID: input.areaId, houseID: input.houseId) else {
            throw StuguAPIError(
                status: 422,
                code: "PROPERTY_SCOPE_MISMATCH",
                message: "This equipment and location must belong to the selected Property."
            )
        }
        let equipment = try await client.updateAreaEquipment(id: id, input: input)
        try await loadInventoryWorkspace()
        errorMessage = nil
        return equipment
    }

    @discardableResult
    func uploadEquipmentAttachment(
        equipmentID: String,
        kind: EquipmentAttachmentKind,
        name: String,
        mimeType: String,
        data: Data
    ) async throws -> EquipmentAttachment {
        let client = try onlinePropertyMutationClient()
        guard selectedPropertyEquipment.contains(where: { $0.id == equipmentID }) else {
            throw StuguAPIError(
                status: 404,
                code: "NOT_FOUND",
                message: "This inventory item is not available in the selected Property."
            )
        }
        let attachment = try await client.uploadEquipmentAttachment(
            equipmentID: equipmentID,
            kind: kind,
            name: name,
            mimeType: mimeType,
            data: data
        )
        try await loadInventoryWorkspace()
        return attachment
    }

    func equipmentAttachmentData(
        equipmentID: String,
        attachmentID: String
    ) async throws -> Data {
        guard let client,
              selectedPropertyEquipment.contains(where: { $0.id == equipmentID }) else {
            throw StuguAPIError(
                status: 404,
                code: "NOT_FOUND",
                message: "This inventory item is not available."
            )
        }
        return try await client.equipmentAttachmentData(
            equipmentID: equipmentID,
            attachmentID: attachmentID
        )
    }

    func deleteEquipmentAttachment(
        equipmentID: String,
        attachmentID: String
    ) async throws {
        let client = try onlinePropertyMutationClient()
        try await client.deleteEquipmentAttachment(
            equipmentID: equipmentID,
            attachmentID: attachmentID
        )
        try await loadInventoryWorkspace()
    }

    @discardableResult
    func addEquipmentLink(
        equipmentID: String,
        label: String,
        url: String
    ) async throws -> EquipmentLink {
        let client = try onlinePropertyMutationClient()
        guard selectedPropertyEquipment.contains(where: { $0.id == equipmentID }) else {
            throw StuguAPIError(
                status: 404,
                code: "NOT_FOUND",
                message: "This inventory item is not available in the selected Property."
            )
        }
        let link = try await client.createEquipmentLink(
            equipmentID: equipmentID,
            label: label,
            url: url
        )
        try await loadInventoryWorkspace()
        return link
    }

    func deleteEquipmentLink(equipmentID: String, linkID: String) async throws {
        let client = try onlinePropertyMutationClient()
        try await client.deleteEquipmentLink(equipmentID: equipmentID, linkID: linkID)
        try await loadInventoryWorkspace()
    }

    func equipmentActivity(
        equipmentID: String,
        propertyID: String
    ) async throws -> (
        notes: [PropertyNote],
        issues: [MaintenanceTask],
        loans: [EquipmentLoan]
    ) {
        guard let client else { return ([], [], []) }
        async let notes = client.propertyNotes(equipmentID: equipmentID)
        async let issues = client.maintenanceTasks(equipmentID: equipmentID)
        async let loans = client.equipmentLoans(
            propertyID: propertyID,
            equipmentID: equipmentID
        )
        return try await (notes, issues, loans)
    }

    @discardableResult
    func addEquipmentNote(equipment: AreaEquipment, text: String) async throws -> PropertyNote {
        let client = try onlinePropertyMutationClient()
        return try await client.addEquipmentNote(
            propertyID: equipment.propertyId,
            equipmentID: equipment.id,
            text: text
        )
    }

    @discardableResult
    func reportEquipmentIssue(
        equipment: AreaEquipment,
        title: String,
        description: String?,
        priority: String
    ) async throws -> MaintenanceTask {
        let client = try onlinePropertyMutationClient()
        return try await client.reportEquipmentIssue(
            equipment: equipment,
            title: title,
            description: description,
            priority: priority
        )
    }

    @discardableResult
    func borrowEquipment(
        equipment: AreaEquipment,
        expectedReturnAt: String?,
        note: String?
    ) async throws -> EquipmentLoan {
        let client = try onlinePropertyMutationClient()
        return try await client.borrowEquipment(
            equipmentID: equipment.id,
            expectedReturnAt: expectedReturnAt,
            note: note
        )
    }

    @discardableResult
    func returnEquipment(loan: EquipmentLoan, note: String?) async throws -> EquipmentLoan {
        let client = try onlinePropertyMutationClient()
        return try await client.returnEquipment(loanID: loan.id, note: note)
    }

    func resolveEquipmentCode(_ code: EquipmentQRCode) async -> TrackedEquipmentState? {
        guard properties.contains(where: { $0.id == code.propertyId }) else {
            errorMessage = "This equipment belongs to a Property you cannot access."
            return nil
        }
        if selectedPropertyID != code.propertyId {
            await selectProperty(code.propertyId)
        }
        guard let equipment = selectedPropertyEquipment.first(where: {
            $0.id == code.equipmentId
        }) else {
            errorMessage = "This equipment tag is not registered in the selected Property."
            return nil
        }
        errorMessage = nil
        return trackedState(for: equipment.id) ?? TrackedEquipmentState(equipment: equipment)
    }

    func startMemberLocationSharing() async {
        guard memberLocationSharingAvailable,
              let client,
              let propertyID = selectedPropertyID else {
            errorMessage = "Live member location sharing is not available for this Property."
            return
        }
        do {
            try await memberLocationSharing.startSharing(
                client: client,
                propertyID: propertyID,
                duration: 60 * 60
            )
            errorMessage = nil
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func stopMemberLocationSharing() async {
        await memberLocationSharing.stopSharing()
        await refreshTracking()
    }

    func refreshTracking() async {
        guard phase == .ready || phase == .starting else { return }
        do {
            try await loadTrackingWorkspace()
        } catch {
            handleAuthenticatedError(error)
        }
    }

    func history(sensorID: String, metric: String, hours: Int = 24) async throws -> [MeasurementSample] {
        let key = historyKey(sensorID: sensorID, metric: metric, hours: hours)
        guard let client, !usingCachedData else {
            return historyCache[key]?.samples ?? []
        }
        do {
            let samples = try await client.measurementHistory(
                sensorID: sensorID,
                metric: metric,
                from: Date().addingTimeInterval(-Double(hours) * 3_600)
            )
            let houseID = sensor(for: sensorID)?.houseId ?? selectedHomeID ?? ""
            historyCache[key] = CompanionHistorySeries(
                houseId: houseID,
                sensorId: sensorID,
                metric: metric,
                hours: hours,
                samples: samples
            )
            await persistCompanionState()
            return samples
        } catch {
            if isTransient(error), let cached = historyCache[key] {
                usingCachedData = true
                return cached.samples
            }
            throw error
        }
    }

    func submitObservation(
        kind: String,
        severity: String,
        note: String,
        sensorID: String?
    ) async throws -> QuickCaptureSaveState {
        guard !selectedHomeReadOnly else {
            throw StuguAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This Home is read-only and cannot accept observations."
            )
        }
        guard let home = selectedHome,
              let floorID = sensorID.flatMap({ sensor(for: $0)?.floorId })
                ?? selectedSensors.first?.floorId else {
            throw StuguAPIError(
                status: 422,
                code: "FLOOR_REQUIRED",
                message: "Add a floor and sensor in the web app before recording a Home observation."
            )
        }
        let input = QuickObservationInput(
            houseId: home.id,
            floorId: floorID,
            sensorId: sensorID,
            kind: kind,
            severity: severity,
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            occurredAt: iso8601(Date()),
            source: "owner",
            confidence: "confirmed"
        )
        guard let client, !usingCachedData else {
            guard await enqueue(PendingCompanionAction(
                kind: .createObservation,
                createdAt: iso8601(Date()),
                observation: input
            )) else {
                throw StuguAPIError(
                    status: 507,
                    code: "OFFLINE_QUEUE_FULL",
                    message: "Reconnect before adding more offline work."
                )
            }
            return .queued
        }
        do {
            _ = try await client.createObservation(input)
            return .saved
        } catch {
            guard isTransient(error) else { throw error }
            guard await enqueue(PendingCompanionAction(
                kind: .createObservation,
                createdAt: iso8601(Date()),
                observation: input
            )) else {
                throw StuguAPIError(
                    status: 507,
                    code: "OFFLINE_QUEUE_FULL",
                    message: "Reconnect before adding more offline work."
                )
            }
            return .queued
        }
    }

    func submitMaintenance(
        title: String,
        description: String?,
        priority: String,
        equipment: AreaEquipment? = nil
    ) async throws -> QuickCaptureSaveState {
        let targetHouseID = equipment == nil ? selectedHome?.id : equipment?.houseId
        guard !selectedPropertyReadOnly else {
            throw StuguAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This Property is read-only and cannot accept maintenance work."
            )
        }
        guard let property = selectedProperty else {
            throw StuguAPIError(
                status: 422,
                code: "PROPERTY_REQUIRED",
                message: "Choose a Property before adding maintenance work."
            )
        }
        let input = QuickMaintenanceInput(
            propertyId: property.id,
            houseId: targetHouseID,
            floorId: nil,
            areaId: equipment?.areaId,
            equipmentId: equipment?.id,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description?.trimmingCharacters(in: .whitespacesAndNewlines),
            priority: priority
        )
        guard let client, !usingCachedData else {
            guard await enqueue(PendingCompanionAction(
                kind: .createMaintenance,
                createdAt: iso8601(Date()),
                maintenance: input
            )) else {
                throw StuguAPIError(
                    status: 507,
                    code: "OFFLINE_QUEUE_FULL",
                    message: "Reconnect before adding more offline work."
                )
            }
            return .queued
        }
        do {
            _ = try await client.createMaintenance(input)
            return .saved
        } catch {
            guard isTransient(error) else { throw error }
            guard await enqueue(PendingCompanionAction(
                kind: .createMaintenance,
                createdAt: iso8601(Date()),
                maintenance: input
            )) else {
                throw StuguAPIError(
                    status: 507,
                    code: "OFFLINE_QUEUE_FULL",
                    message: "Reconnect before adding more offline work."
                )
            }
            return .queued
        }
    }

    private func equipmentPlacementIsValid(
        areaID: String?,
        houseID: String?
    ) -> Bool {
        guard areaID == nil || houseID == nil else { return false }
        if let areaID {
            return selectedPropertyAreas.contains { $0.id == areaID }
        }
        if let houseID {
            return selectedPropertyHouses.contains {
                $0.id == houseID && $0.stuguby?.isReadOnly != true
            }
        }
        return selectedProperty != nil
    }

    func requestNotificationPermission() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(
                options: [.alert, .badge, .sound]
            )
            await refreshNotificationAuthorization()
            guard granted else { return }
            notificationsEnabled = true
            UserDefaults.standard.set(true, forKey: DefaultsKey.notificationsEnabled)
            UIApplication.shared.registerForRemoteNotifications()
            await syncNotificationRegistration()
        } catch {
            errorMessage = "Notification permission could not be requested."
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) async {
        notificationsEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: DefaultsKey.notificationsEnabled)
        if enabled {
            await requestNotificationPermission()
        } else {
            UIApplication.shared.unregisterForRemoteNotifications()
            await removeNotificationRegistration()
        }
    }

    func receiveNotificationDeviceToken(_ token: String) async {
        UserDefaults.standard.set(token, forKey: DefaultsKey.notificationDeviceToken)
        await syncNotificationRegistration()
    }

    func refreshNotificationAuthorization() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationAuthorization = settings.authorizationStatus
    }

    func handleDeepLink(_ url: URL) {
        guard let link = CompanionDeepLink.parse(url) else { return }
        pendingDeepLink = link
    }

    func consumeDeepLink() {
        pendingDeepLink = nil
    }

    func definition(for metric: String) -> MeasurementDefinition? {
        definitions.first { $0.id == metric }
    }

    func sensor(for id: String) -> Sensor? {
        sensors.first { $0.id == id }
    }

    func rule(for id: String) -> AlertRule? {
        rules.first { $0.id == id }
    }

    func property(for house: House) -> StuguProperty? {
        properties.first { $0.id == house.propertyId }
    }

    func house(for sensorID: String) -> House? {
        guard let houseID = sensors.first(where: { $0.id == sensorID })?.houseId else { return nil }
        return houses.first { $0.id == houseID }
    }

    func signOut() async {
        requestGeneration += 1
        let generation = requestGeneration
        if let client,
           let registrationID = UserDefaults.standard.string(
            forKey: DefaultsKey.notificationRegistration
           ) {
            try? await client.deleteIOSNotificationRegistration(id: registrationID)
        }
        UIApplication.shared.unregisterForRemoteNotifications()
        notificationsEnabled = false
        UserDefaults.standard.set(false, forKey: DefaultsKey.notificationsEnabled)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.notificationRegistration)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.notificationAccountIdentity)
        await memberLocationSharing.stopSharing()
        stopEventLoop()
        clearWorkspace()
        equipmentObservationEnabled = false
        UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
        errorMessage = nil
        phase = .starting
        if let client {
            try? await client.logout()
            await client.clearCookies()
        }
        try? await cacheStore.remove()
        resetWatchActionBindings()
        clearGlanceableState()
        guard generation == requestGeneration else { return }
        phase = .signIn
    }

    func disconnect() async {
        requestGeneration += 1
        let generation = requestGeneration
        await memberLocationSharing.stopSharing()
        stopEventLoop()
        let retiringClient = client
        self.client = nil
        serverAddress = nil
        serverVersion = nil
        session = nil
        clearWorkspace()
        errorMessage = nil
        UserDefaults.standard.removeObject(forKey: DefaultsKey.server)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedHome)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedProperty)
        equipmentObservationEnabled = false
        UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
        phase = .starting
        if let retiringClient {
            if let registrationID = UserDefaults.standard.string(
                forKey: DefaultsKey.notificationRegistration
            ) {
                try? await retiringClient.deleteIOSNotificationRegistration(id: registrationID)
            }
            await retiringClient.clearCookies()
        }
        UIApplication.shared.unregisterForRemoteNotifications()
        notificationsEnabled = false
        UserDefaults.standard.set(false, forKey: DefaultsKey.notificationsEnabled)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.notificationRegistration)
        UserDefaults.standard.removeObject(forKey: DefaultsKey.notificationAccountIdentity)
        try? await cacheStore.remove()
        resetWatchActionBindings()
        clearGlanceableState()
        guard generation == requestGeneration else { return }
        phase = .serverSetup
    }

    func retryConnection() async {
        guard let serverAddress else {
            phase = .serverSetup
            return
        }
        do {
            try await configure(address: serverAddress, persist: false)
        } catch {
            if await restoreCachedWorkspace(address: serverAddress) {
                errorMessage = "Stugu could not be reached. Showing protected information saved on this iPhone."
                phase = .ready
            } else {
                errorMessage = friendlyMessage(for: error)
                phase = .ownerSetupRequired
            }
        }
    }

    func sceneBecameActive() async {
        guard phase == .ready else { return }
        mobileTracking.applicationBecameActive()
        memberLocationSharing.applicationBecameActive()
        await refreshNotificationAuthorization()
        await refresh()
        startEventLoop()
    }

    func sceneBecameInactive() {
        guard phase == .ready else { return }
        mobileTracking.applicationBecameInactive()
        memberLocationSharing.applicationBecameInactive()
        stopEventLoop()
    }

    private func configure(address: ServerAddress, persist: Bool) async throws {
        requestGeneration += 1
        let generation = requestGeneration
        phase = .starting
        errorMessage = nil
        stopEventLoop()
        clearWorkspace()
        if let cached = try? await cacheStore.load(
            serverOrigin: address.origin.absoluteString
        ) {
            cachedAccountIdentity = accountIdentity(for: cached.session)
            pendingActions = cached.pendingActions
            historyCache = Dictionary(
                uniqueKeysWithValues: cached.history.map { ($0.id, $0) }
            )
            todayContext = cached.todayContext
        }
        let client = StuguAPIClient(
            address: address,
            edgeCredential: edgeCredentialStore.credential(
                serverOrigin: address.origin.absoluteString
            )
        )
        let health = try await client.health()
        guard generation == requestGeneration else { return }
        self.client = client
        serverAddress = address
        serverVersion = health.systemVersion
        homeMonitoringAvailability = ServerFeatureSupport.homeMonitoring(
            systemVersion: health.systemVersion
        ) ? .unavailable : .serverUpgradeRequired
        if persist {
            UserDefaults.standard.set(address.origin.absoluteString, forKey: DefaultsKey.server)
        }

        do {
            let session = try await client.currentSession()
            guard generation == requestGeneration else { return }
            self.session = session
            if session.setupRequired == true {
                phase = .ownerSetupRequired
                return
            }
            guard session.authenticated else {
                phase = .signIn
                return
            }
            await adoptCachedState(for: session)
            try await loadWorkspace()
            guard generation == requestGeneration else { return }
            phase = .ready
            await finishOnlineRefresh()
            startEventLoop()
        } catch let error as StuguAPIError where error.status == 401 {
            guard generation == requestGeneration else { return }
            session = nil
            clearGlanceableState()
            phase = .signIn
        }
    }

    private func loadWorkspace() async throws {
        guard let client else { return }
        let generation = currentRequestGeneration
        async let propertiesRequest = client.properties()
        async let housesRequest = client.houses()
        async let sensorsRequest = client.sensors()
        async let definitionsRequest = client.measurementDefinitions()
        async let alertsRequest = client.alerts()
        async let rulesRequest = client.alertRules()

        let (properties, houses, sensors, definitions, alerts, rules) = try await (
            propertiesRequest,
            housesRequest,
            sensorsRequest,
            definitionsRequest,
            alertsRequest,
            rulesRequest
        )
        guard isCurrent(generation) else { return }
        self.properties = properties.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        self.houses = houses.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        self.sensors = sensors
        self.definitions = definitions.filter(\.enabled)
        self.alerts = sortedAlerts(alerts)
        self.rules = rules

        let savedHome = UserDefaults.standard.string(forKey: DefaultsKey.selectedHome)
        if let selectedHomeID, houses.contains(where: { $0.id == selectedHomeID }) {
            // Keep the current selection.
        } else if pinnedOverviewScope == .home,
                  let pinnedOverviewTargetID,
                  houses.contains(where: { $0.id == pinnedOverviewTargetID }) {
            selectedHomeID = pinnedOverviewTargetID
        } else if pinnedOverviewScope == .property,
                  let pinnedOverviewTargetID,
                  properties.contains(where: { $0.id == pinnedOverviewTargetID }) {
            selectedHomeID = houses.first { $0.propertyId == pinnedOverviewTargetID }?.id
        } else if let savedHome, houses.contains(where: { $0.id == savedHome }) {
            selectedHomeID = savedHome
        } else {
            selectedHomeID = houses.first?.id
        }

        let savedProperty = UserDefaults.standard.string(forKey: DefaultsKey.selectedProperty)
        if let selectedPropertyID,
           properties.contains(where: { $0.id == selectedPropertyID }) {
            // Keep the current Property selection.
        } else if pinnedOverviewScope == .property,
                  let pinnedOverviewTargetID,
                  properties.contains(where: { $0.id == pinnedOverviewTargetID }) {
            selectedPropertyID = pinnedOverviewTargetID
        } else if pinnedOverviewScope == .home,
                  let pinnedOverviewTargetID,
                  let pinnedHome = houses.first(where: { $0.id == pinnedOverviewTargetID }) {
            selectedPropertyID = pinnedHome.propertyId
        } else if let savedProperty,
                  properties.contains(where: { $0.id == savedProperty }) {
            selectedPropertyID = savedProperty
        } else if let home = selectedHome {
            selectedPropertyID = home.propertyId
        } else {
            selectedPropertyID = properties.first?.id
        }

        if let selectedPropertyID, selectedHome?.propertyId != selectedPropertyID {
            selectedHomeID = houses.first(where: { $0.propertyId == selectedPropertyID })?.id
        }

        let pinnedTargetIsValid = pinnedOverviewTargetID.map { targetID in
            pinnedOverviewScope == .home
                ? houses.contains(where: { $0.id == targetID })
                : properties.contains(where: { $0.id == targetID })
        } ?? false
        if !pinnedTargetIsValid {
            if let selectedHomeID {
                pinnedOverviewScope = .home
                pinnedOverviewTargetID = selectedHomeID
            } else {
                pinnedOverviewScope = .property
                pinnedOverviewTargetID = selectedPropertyID
            }
            UserDefaults.standard.set(
                pinnedOverviewScope.rawValue,
                forKey: DefaultsKey.pinnedOverviewScope
            )
            UserDefaults.standard.set(
                pinnedOverviewTargetID,
                forKey: DefaultsKey.pinnedOverviewTarget
            )
        }

        let scopePropertyID = selectedPropertyID
        let scopeHomeID = selectedHomeID
        let scope = ScopeRequest(
            generation: generation,
            propertyID: scopePropertyID,
            homeID: scopeHomeID
        )
        if let scopeHomeID {
            let (nextSnapshot, nextTpLinkDevices) = try await fetchHomeSelection(
                client: client,
                homeID: scopeHomeID
            )
            guard isCurrent(scope) else { return }
            snapshot = nextSnapshot
            tpLinkDevices = nextTpLinkDevices
            try await loadHomeMonitoring()
            guard isCurrent(scope) else { return }
            UserDefaults.standard.set(scopeHomeID, forKey: DefaultsKey.selectedHome)
        } else {
            snapshot = []
            tpLinkDevices = []
            latestOpeningStateObservation = nil
            homeMonitoring = nil
            homeMonitoringAvailability = .unavailable
            UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedHome)
        }
        if let scopePropertyID {
            UserDefaults.standard.set(scopePropertyID, forKey: DefaultsKey.selectedProperty)
        }
        if let overviewPropertyID = pinnedOverviewProperty?.id {
            let seeded = scopeHomeID.flatMap { homeID in
                houses.first(where: { $0.id == homeID })?.propertyId == overviewPropertyID
                    ? [homeID: snapshot]
                    : nil
            } ?? [:]
            let overviewSnapshots = await fetchPropertyMeasurementSnapshots(
                client: client,
                propertyID: overviewPropertyID,
                seeded: seeded
            )
            guard isCurrent(scope) else { return }
            if pinnedOverviewProperty?.id == overviewPropertyID {
                propertyMeasurementSnapshots = overviewSnapshots
            }
        } else {
            propertyMeasurementSnapshots = [:]
        }
        try await loadInventoryWorkspace()
        guard isCurrent(scope) else { return }
        do {
            try await loadTrackingWorkspace()
        } catch let error as StuguAPIError where error.status == 401 {
            throw error
        } catch {
            guard isCurrent(scope) else { return }
            trackingCapabilities = nil
            trackingSettings = nil
            trackingSnapshot = nil
            trackingLiveConnected = false
        }
        guard isCurrent(scope) else { return }
        lastUpdated = Date()
        usingCachedData = false
    }

    private func adoptScopeSelection(propertyID: String, homeID: String?) {
        selectedPropertyID = propertyID
        selectedHomeID = homeID
        UserDefaults.standard.set(propertyID, forKey: DefaultsKey.selectedProperty)
        if let homeID {
            UserDefaults.standard.set(homeID, forKey: DefaultsKey.selectedHome)
        } else {
            UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedHome)
        }
        snapshot = []
        tpLinkDevices = []
        latestOpeningStateObservation = nil
        homeMonitoring = nil
        if homeID == nil || ServerFeatureSupport.homeMonitoring(systemVersion: serverVersion) {
            homeMonitoringAvailability = .unavailable
        } else {
            homeMonitoringAvailability = .serverUpgradeRequired
        }
    }

    private func reloadSelectedScope(
        client: StuguAPIClient,
        request: ScopeRequest
    ) async throws {
        let homeData: (
            snapshot: [MeasurementSnapshotEntry],
            devices: [TpLinkDiscoveredDevice]
        )
        if let homeID = request.homeID {
            homeData = try await fetchHomeSelection(client: client, homeID: homeID)
        } else {
            homeData = ([], [])
        }
        guard isCurrent(request) else { return }
        snapshot = homeData.snapshot
        tpLinkDevices = homeData.devices
        if let overviewPropertyID = pinnedOverviewProperty?.id {
            var seeded = propertyMeasurementSnapshots
            if let homeID = request.homeID,
               houses.first(where: { $0.id == homeID })?.propertyId == overviewPropertyID {
                seeded[homeID] = homeData.snapshot
            }
            let overviewSnapshots = await fetchPropertyMeasurementSnapshots(
                client: client,
                propertyID: overviewPropertyID,
                seeded: seeded
            )
            guard isCurrent(request) else { return }
            if pinnedOverviewProperty?.id == overviewPropertyID {
                propertyMeasurementSnapshots = overviewSnapshots
            }
        } else {
            propertyMeasurementSnapshots = [:]
        }
        guard isCurrent(request) else { return }
        try await loadHomeMonitoring()
        guard isCurrent(request) else { return }
        try await loadInventoryWorkspace()
        guard isCurrent(request) else { return }
        try await loadTrackingWorkspace()
        guard isCurrent(request) else { return }
        startTrackingEventLoop()
        lastUpdated = Date()
        usingCachedData = false
        await persistCompanionState()
        guard isCurrent(request) else { return }
    }

    private func fetchHomeSelection(
        client: StuguAPIClient,
        homeID: String
    ) async throws -> (
        snapshot: [MeasurementSnapshotEntry],
        devices: [TpLinkDiscoveredDevice]
    ) {
        let snapshot = try await client.measurementSnapshot(houseID: homeID)
        let devices = await loadTpLinkDevices(client: client, homeID: homeID)
        return (snapshot, devices)
    }

    private func fetchPropertyMeasurementSnapshots(
        client: StuguAPIClient,
        propertyID: String,
        seeded: [String: [MeasurementSnapshotEntry]]
    ) async -> [String: [MeasurementSnapshotEntry]] {
        let homeIDs = houses.filter { $0.propertyId == propertyID }.map(\.id)
        var collected = seeded.filter { homeIDs.contains($0.key) }
        await withTaskGroup(
            of: (String, [MeasurementSnapshotEntry])?.self
        ) { group in
            for homeID in homeIDs where collected[homeID] == nil {
                group.addTask {
                    do {
                        return (
                            homeID,
                            try await client.measurementSnapshot(houseID: homeID)
                        )
                    } catch {
                        return nil
                    }
                }
            }
            for await result in group {
                if let (homeID, snapshot) = result {
                    collected[homeID] = snapshot
                }
            }
        }
        return collected
    }

    private func reloadPinnedOverviewSnapshots() async {
        guard let client, let propertyID = pinnedOverviewProperty?.id else {
            propertyMeasurementSnapshots = [:]
            return
        }
        let generation = currentRequestGeneration
        var seeded = propertyMeasurementSnapshots
        if let selectedHomeID,
           selectedHome?.propertyId == propertyID {
            seeded[selectedHomeID] = snapshot
        }
        let next = await fetchPropertyMeasurementSnapshots(
            client: client,
            propertyID: propertyID,
            seeded: seeded
        )
        guard isCurrent(generation), pinnedOverviewProperty?.id == propertyID else { return }
        propertyMeasurementSnapshots = next
    }

    private func loadTpLinkDevices(
        client: StuguAPIClient,
        homeID: String
    ) async -> [TpLinkDiscoveredDevice] {
        guard !isReadOnly else { return [] }
        let fallback = tpLinkDevices.filter {
            $0.houseId == homeID || ($0.houseId == nil && selectedHomeID == homeID)
        }
        do {
            return try await client.tpLinkDevices(houseID: homeID)
        } catch {
            // Device inventory is an administrative, additive companion resource.
            // Keep the rest of the Home usable when it is unavailable.
            return fallback
        }
    }

    private func loadInventoryWorkspace() async throws {
        guard let client, let propertyID = selectedProperty?.id else {
            propertyInventory = nil
            return
        }
        let scope = currentScopeRequest
        let inventory: PropertyInventorySnapshot
        do {
            inventory = try await client.propertyInventory(propertyID: propertyID)
        } catch {
            guard isCurrent(scope) else { return }
            throw error
        }
        guard isCurrent(scope) else { return }
        propertyInventory = inventory
    }

    private func fetchTrackingWorkspace(
        client: StuguAPIClient,
        propertyID: String
    ) async throws -> TrackingWorkspaceData {
        let capabilities = try await client.trackingCapabilities()
        guard capabilities.featureEnabled("tracking.enabled") else {
            return TrackingWorkspaceData(
                capabilities: capabilities,
                settings: nil,
                snapshot: nil
            )
        }
        let settings: TrackingPropertySettings
        do {
            settings = try await client.trackingPropertySettings(propertyID: propertyID)
        } catch let error as StuguAPIError where error.status == 404 {
            return TrackingWorkspaceData(
                capabilities: capabilities,
                settings: nil,
                snapshot: nil
            )
        }
        let snapshot: TrackingMapSnapshot?
        if capabilities.featureEnabled("tracking.liveMap.enabled") {
            snapshot = try await client.trackingMapSnapshot(propertyID: propertyID)
        } else {
            snapshot = nil
        }
        return TrackingWorkspaceData(
            capabilities: capabilities,
            settings: settings,
            snapshot: snapshot
        )
    }

    private func loadTrackingWorkspace() async throws {
        guard let client, let propertyID = selectedProperty?.id else {
            trackingCapabilities = nil
            trackingSettings = nil
            trackingSnapshot = nil
            mobileTracking.disable()
            return
        }
        let scope = currentScopeRequest
        let data: TrackingWorkspaceData
        do {
            data = try await fetchTrackingWorkspace(
                client: client,
                propertyID: propertyID
            )
        } catch {
            guard isCurrent(scope) else { return }
            throw error
        }
        guard isCurrent(scope) else { return }
        trackingCapabilities = data.capabilities
        trackingSettings = data.settings
        trackingSnapshot = data.snapshot

        if !memberLocationSharingAvailable {
            await memberLocationSharing.stopSharing()
            guard isCurrent(scope) else { return }
        }
        if equipmentObservationEnabled,
           mobileTrackingAvailable,
           let serverAddress,
           let capabilities = data.capabilities,
           let settings = data.settings {
            do {
                try await mobileTracking.enable(
                    client: client,
                    serverOrigin: serverAddress.origin.absoluteString,
                    propertyID: propertyID,
                    capabilities: capabilities,
                    settings: settings
                )
                guard isCurrent(scope) else { return }
            } catch is CancellationError {
                return
            } catch let error as StuguAPIError where error.status == 401 {
                guard isCurrent(scope) else { return }
                throw error
            } catch {
                guard isCurrent(scope) else { return }
                mobileTracking.disable()
                errorMessage = friendlyMessage(for: error)
            }
        } else {
            mobileTracking.disable()
        }
    }

    private func loadHomeMonitoring() async throws {
        guard let client, let homeID = selectedHomeID else {
            homeMonitoring = nil
            homeMonitoringAvailability = .unavailable
            return
        }
        let scope = currentScopeRequest
        guard ServerFeatureSupport.homeMonitoring(systemVersion: serverVersion) else {
            homeMonitoring = nil
            homeMonitoringAvailability = .serverUpgradeRequired
            return
        }
        let nextMonitoring: HomeMonitoringDetailResponse?
        let nextAvailability: HomeMonitoringAvailability
        do {
            nextMonitoring = try await client.homeMonitoring(houseID: homeID)
            nextAvailability = .available
        } catch let error as StuguAPIError where error.status == 401 {
            guard isCurrent(scope) else { return }
            throw error
        } catch let error as StuguAPIError where error.status == 404 {
            nextMonitoring = nil
            nextAvailability = .serverUpgradeRequired
        } catch {
            nextMonitoring = nil
            nextAvailability = .unavailable
        }
        guard isCurrent(scope) else { return }
        homeMonitoring = nextMonitoring
        homeMonitoringAvailability = nextAvailability
    }

    private func finishOnlineRefresh() async {
        usingCachedData = false
        await flushPendingActions()
        await refreshNotificationAuthorization()
        if notificationsEnabled, notificationAllowed {
            UIApplication.shared.registerForRemoteNotifications()
            await syncNotificationRegistration()
        } else if !notificationsEnabled {
            await removeNotificationRegistration()
        }
        await reconcileLocalAlertReminders()
        await persistCompanionState()
    }

    private func restoreCachedWorkspace(address: ServerAddress) async -> Bool {
        guard let cache = try? await cacheStore.load(
            serverOrigin: address.origin.absoluteString
        ), cache.session.authenticated else {
            return false
        }
        stopEventLoop()
        clearWorkspace()
        client = StuguAPIClient(
            address: address,
            edgeCredential: edgeCredentialStore.credential(
                serverOrigin: address.origin.absoluteString
            )
        )
        serverAddress = address
        session = cache.session
        properties = cache.properties
        houses = cache.houses
        sensors = cache.sensors
        definitions = cache.definitions
        snapshot = cache.measurementSnapshot
        propertyMeasurementSnapshots = cache.selectedHomeId.map {
            [$0: cache.measurementSnapshot]
        } ?? [:]
        tpLinkDevices = cache.tpLinkDevices ?? []
        latestOpeningStateObservation = cache.latestOpeningStateObservation
        alerts = sortedAlerts(cache.alerts)
        rules = cache.rules
        propertyInventory = cache.propertyInventory
        selectedHomeID = cache.selectedHomeId
        selectedPropertyID = cache.selectedPropertyId
        historyCache = Dictionary(
            uniqueKeysWithValues: cache.history.map { ($0.id, $0) }
        )
        cachedAccountIdentity = accountIdentity(for: cache.session)
        todayContext = cache.todayContext
        homeMonitoring = nil
        homeMonitoringAvailability = .unavailable
        pendingActions = cache.pendingActions
        lastUpdated = StuguDateParser.date(from: cache.savedAt)
        usingCachedData = true
        liveConnected = false
        phase = .ready
        mobileTracking.suspend()
        memberLocationSharing.suspend()
        persistWidgetSnapshot()
        return true
    }

    @discardableResult
    private func persistCompanionState() async -> Bool {
        guard let serverAddress,
              let session,
              session.authenticated else {
            return false
        }
        let cachedSession = AppSession(
            authenticated: session.authenticated,
            principal: session.principal,
            tenant: session.tenant,
            readOnly: session.readOnly,
            csrfToken: nil,
            setupRequired: session.setupRequired
        )
        let savedAt = iso8601(lastUpdated ?? Date())
        let cache = CompanionCache(
            serverOrigin: serverAddress.origin.absoluteString,
            savedAt: savedAt,
            session: cachedSession,
            properties: properties,
            houses: houses,
            sensors: sensors,
            definitions: definitions,
            measurementSnapshot: snapshot,
            alerts: alerts,
            rules: rules,
            propertyInventory: propertyInventory,
            selectedHomeId: selectedHomeID,
            selectedPropertyId: selectedPropertyID,
            history: Array(historyCache.values),
            todayContext: todayContext,
            pendingActions: pendingActions,
            tpLinkDevices: tpLinkDevices,
            latestOpeningStateObservation: latestOpeningStateObservation
        )
        do {
            try await cacheStore.save(cache)
        } catch {
            errorMessage = "Stugu could not protect its offline information on this iPhone."
            return false
        }
        cachedAccountIdentity = accountIdentity(for: session)
        persistWidgetSnapshot()
        return true
    }

    private func adoptCachedState(for session: AppSession) async {
        let identity = accountIdentity(for: session)
        if let notificationIdentity = UserDefaults.standard.string(
            forKey: DefaultsKey.notificationAccountIdentity
        ), notificationIdentity != identity {
            UIApplication.shared.unregisterForRemoteNotifications()
            notificationsEnabled = false
            UserDefaults.standard.set(
                false,
                forKey: DefaultsKey.notificationsEnabled
            )
            notificationRegistration = nil
            notificationProviderConfigured = false
            UserDefaults.standard.removeObject(
                forKey: DefaultsKey.notificationRegistration
            )
            UserDefaults.standard.removeObject(
                forKey: DefaultsKey.notificationAccountIdentity
            )
        }
        guard let cachedAccountIdentity else {
            self.cachedAccountIdentity = identity
            return
        }
        guard cachedAccountIdentity != identity else { return }
        pendingActions = []
        historyCache = [:]
        todayContext = nil
        homeMonitoring = nil
        homeMonitoringAvailability = .unavailable
        UIApplication.shared.unregisterForRemoteNotifications()
        notificationsEnabled = false
        UserDefaults.standard.set(false, forKey: DefaultsKey.notificationsEnabled)
        notificationRegistration = nil
        notificationProviderConfigured = false
        UserDefaults.standard.removeObject(
            forKey: DefaultsKey.notificationRegistration
        )
        try? await cacheStore.remove()
        clearGlanceableState()
        self.cachedAccountIdentity = identity
    }

    private func accountIdentity(for session: AppSession) -> String {
        [
            session.principal.type,
            session.principal.email?.lowercased() ?? "",
            session.tenant.id,
        ].joined(separator: "\u{1f}")
    }

    func currentWatchActionContext() -> WatchActionContext? {
        guard let serverAddress,
              let session,
              session.authenticated,
              let homeID = selectedHomeID else {
            return nil
        }
        let defaults = UserDefaults.standard
        let serverBinding = stableWatchBinding(
            identity: serverAddress.origin.absoluteString,
            identityKey: DefaultsKey.watchServerIdentity,
            bindingKey: DefaultsKey.watchServerBinding,
            defaults: defaults
        )
        let accountBinding = stableWatchBinding(
            identity: accountIdentity(for: session),
            identityKey: DefaultsKey.watchAccountIdentity,
            bindingKey: DefaultsKey.watchAccountBinding,
            defaults: defaults
        )
        return WatchActionContext(
            serverBinding: serverBinding,
            accountBinding: accountBinding,
            homeId: homeID
        )
    }

    private func stableWatchBinding(
        identity: String,
        identityKey: String,
        bindingKey: String,
        defaults: UserDefaults
    ) -> String {
        if defaults.string(forKey: identityKey) == identity,
           let binding = defaults.string(forKey: bindingKey),
           !binding.isEmpty {
            return binding
        }
        let binding = UUID().uuidString.lowercased()
        defaults.set(identity, forKey: identityKey)
        defaults.set(binding, forKey: bindingKey)
        return binding
    }

    private func resetWatchActionBindings() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: DefaultsKey.watchServerIdentity)
        defaults.removeObject(forKey: DefaultsKey.watchServerBinding)
        defaults.removeObject(forKey: DefaultsKey.watchAccountIdentity)
        defaults.removeObject(forKey: DefaultsKey.watchAccountBinding)
    }

    private func persistWidgetSnapshot() {
        guard let home = selectedHome else {
            clearGlanceableState()
            return
        }
        let summary = monitorSummary
        let state: String
        switch summary.state {
        case .balanced: state = "balanced"
        case .limited: state = "limited"
        case .attention: state = "attention"
        case .critical: state = "critical"
        }
        let updatedAt = iso8601(lastUpdated ?? Date())
        widgetStore.save(CompanionWidgetSnapshot(
            homeId: home.id,
            homeName: home.name,
            homeOrigin: home.stuguby?.isForeignSharedHome == true ? "remote" : "own",
            state: state,
            title: summary.title,
            detail: usingCachedData ? "Saved status · \(summary.detail)" : summary.detail,
            activeAlertCount: selectedHomeAlerts.filter(\.isActive).count,
            updatedAt: updatedAt
        ))
        let watchAlerts = selectedHomeAlerts
            .filter { $0.isActive && $0.acknowledgedAt == nil }
            .prefix(8)
            .map { alert in
                let sensor = sensors.first { $0.id == alert.sensorId }
                let location: String
                if let room = sensor?.room, !room.isEmpty {
                    location = room
                } else {
                    location = sensor?.name ?? "Home"
                }
                let metric = definitions.first { $0.id == alert.metric }?
                    .label() ?? alert.metric.replacingOccurrences(of: "-", with: " ")
                return WatchAlertSummary(
                    id: alert.id,
                    severity: alert.severity,
                    title: "\(location): \(metric)",
                    startedAt: alert.startedAt
                )
            }
        PhoneWatchConnectivityBridge.shared.publish(WatchHomeSnapshot(
            homeId: home.id,
            homeName: home.name,
            homeOrigin: home.stuguby?.isForeignSharedHome == true ? "remote" : "own",
            state: state,
            title: summary.title,
            detail: usingCachedData ? "Saved status. \(summary.detail)" : summary.detail,
            updatedAt: updatedAt,
            cached: usingCachedData,
            readOnly: selectedHomeReadOnly,
            alerts: Array(watchAlerts),
            actionContext: currentWatchActionContext()
        ))
    }

    private func clearGlanceableState() {
        widgetStore.remove()
        PhoneWatchConnectivityBridge.shared.publish(
            .unavailable(at: iso8601(Date()))
        )
    }

    @discardableResult
    private func queueAlertAcknowledgement(_ alert: AlertEvent) async -> Bool {
        guard await enqueue(PendingCompanionAction(
            kind: .acknowledgeAlert,
            createdAt: iso8601(Date()),
            alertId: alert.id
        )) else { return false }
        if let index = alerts.firstIndex(where: { $0.id == alert.id }) {
            alerts[index] = AlertEvent(
                id: alert.id,
                ruleId: alert.ruleId,
                sensorId: alert.sensorId,
                metric: alert.metric,
                value: alert.value,
                threshold: alert.threshold,
                severity: alert.severity,
                startedAt: alert.startedAt,
                acknowledgedAt: iso8601(Date()),
                resolvedAt: alert.resolvedAt
            )
        }
        errorMessage = "Marked as seen on this iPhone. Stugu will receive it after reconnection."
        cancelLocalAlertReminder(alertID: alert.id)
        await persistCompanionState()
        return true
    }

    @discardableResult
    private func enqueue(_ action: PendingCompanionAction) async -> Bool {
        if action.kind == .acknowledgeAlert,
           pendingActions.contains(where: {
               $0.kind == .acknowledgeAlert && $0.alertId == action.alertId
           }) {
            return true
        }
        guard pendingActions.count < 100 else {
            errorMessage = "The protected offline queue is full. Reconnect before adding more work."
            return false
        }
        pendingActions.append(action)
        guard await persistCompanionState() else {
            pendingActions.removeAll { $0.id == action.id }
            return false
        }
        return true
    }

    private func flushPendingActions() async {
        guard let client, !usingCachedData, !isReadOnly, !pendingActions.isEmpty else {
            return
        }
        for action in pendingActions {
            do {
                switch action.kind {
                case .acknowledgeAlert:
                    guard let alertID = action.alertId else { continue }
                    let updated = try await client.acknowledgeAlert(id: alertID)
                    if let index = alerts.firstIndex(where: { $0.id == updated.id }) {
                        alerts[index] = updated
                    }
                case .createObservation:
                    guard let observation = action.observation else { continue }
                    _ = try await client.createObservation(observation)
                case .createMaintenance:
                    guard let maintenance = action.maintenance else { continue }
                    _ = try await client.createMaintenance(maintenance)
                }
                pendingActions.removeAll { $0.id == action.id }
            } catch let error as StuguAPIError where error.status == 401 {
                handleAuthenticatedError(error)
                return
            } catch {
                guard let index = pendingActions.firstIndex(where: { $0.id == action.id }) else {
                    continue
                }
                pendingActions[index] = action.recordingFailure(friendlyMessage(for: error))
                if isTransient(error) { break }
            }
        }
    }

    private func syncNotificationRegistration() async {
        guard notificationsEnabled,
              notificationAllowed,
              phase == .ready,
              session?.authenticated == true,
              let client,
              !usingCachedData,
              let deviceToken = UserDefaults.standard.string(
                  forKey: DefaultsKey.notificationDeviceToken
              ), !deviceToken.isEmpty else {
            return
        }
        let registrationID: String
        if let saved = UserDefaults.standard.string(
            forKey: DefaultsKey.notificationRegistration
        ) {
            registrationID = saved
        } else {
            registrationID = UUID().uuidString.lowercased()
            UserDefaults.standard.set(
                registrationID,
                forKey: DefaultsKey.notificationRegistration
            )
        }
        #if DEBUG
        let environment = IOSPushEnvironment.sandbox
        #else
        let environment = IOSPushEnvironment.production
        #endif
        do {
            let result = try await client.saveIOSNotificationRegistration(
                id: registrationID,
                input: IOSNotificationRegistrationInput(
                    deviceToken: deviceToken,
                    environment: environment,
                    homeIds: houses.map(\.id),
                    minimumSeverity: notificationMinimumSeverity,
                    includeDetails: notificationIncludeDetails
                )
            )
            notificationProviderConfigured = result.configured
            notificationRegistration = result.registration
            if let session {
                UserDefaults.standard.set(
                    accountIdentity(for: session),
                    forKey: DefaultsKey.notificationAccountIdentity
                )
            }
        } catch let error as StuguAPIError where error.status == 404 {
            notificationProviderConfigured = false
            notificationRegistration = nil
        } catch {
            if !isTransient(error) {
                errorMessage = friendlyMessage(for: error)
            }
        }
    }

    private func removeNotificationRegistration() async {
        guard let client,
              !usingCachedData,
              let id = UserDefaults.standard.string(
                  forKey: DefaultsKey.notificationRegistration
              ) else {
            return
        }
        do {
            try await client.deleteIOSNotificationRegistration(id: id)
            notificationRegistration = nil
            notificationProviderConfigured = false
        } catch {
            if !isTransient(error) {
                errorMessage = friendlyMessage(for: error)
            }
        }
    }

    private var notificationAllowed: Bool {
        switch notificationAuthorization {
        case .authorized, .provisional, .ephemeral:
            return true
        default:
            return false
        }
    }

    private func historyKey(sensorID: String, metric: String, hours: Int) -> String {
        [selectedHomeID ?? "", sensorID, metric, String(hours)].joined(separator: "\u{1f}")
    }

    private func cancelLocalAlertReminder(alertID: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: [
                NotificationAppDelegate.reminderIdentifier(for: alertID),
            ]
        )
    }

    private func reconcileLocalAlertReminders() async {
        let alertsByID = Dictionary(
            uniqueKeysWithValues: alerts.map { ($0.id, $0) }
        )
        let pendingRequests = await UNUserNotificationCenter.current()
            .pendingNotificationRequests()
        let obsolete = pendingRequests.compactMap { request -> String? in
                guard request.identifier.hasPrefix("stugu-reminder-"),
                      let alertID = request.content.userInfo[
                        NotificationAppDelegate.alertIDKey
                      ] as? String,
                      let alert = alertsByID[alertID],
                      !alert.isActive || alert.acknowledgedAt != nil else {
                    return nil
                }
                return request.identifier
            }
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: obsolete
        )
    }

    private func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func isTransient(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let apiError = error as? StuguAPIError else { return false }
        return apiError.status == 0
            || apiError.status == 408
            || apiError.status == 425
            || apiError.status == 429
            || apiError.status >= 500
    }

    private func startEventLoop() {
        stopEventLoop()
        guard client != nil else { return }
        eventTask = Task { [weak self] in
            guard let self else { return }
            var retrySeconds: UInt64 = 1
            while !Task.isCancelled, self.phase == .ready {
                guard let client = self.client else { return }
                do {
                    let events = await client.eventStream()
                    self.liveConnected = true
                    retrySeconds = 1
                    for try await event in events {
                        if Task.isCancelled { return }
                        if event.type == "authorization", event.data.contains("expired") {
                            self.stopEventLoop()
                            self.requestGeneration += 1
                            self.clearWorkspace()
                            self.phase = .signIn
                            return
                        }
                        if event.type == "opening" {
                            self.applyOpeningStateEvent(event.data)
                            self.scheduleEventRefresh()
                            continue
                        }
                        if ["reading", "measurement", "alert", "mutation", "weather"].contains(event.type) {
                            self.scheduleEventRefresh()
                        }
                    }
                } catch let error as StuguAPIError where error.status == 401 {
                    self.stopEventLoop()
                    self.requestGeneration += 1
                    self.clearWorkspace()
                    self.phase = .signIn
                    self.errorMessage = "Your session expired. Sign in again."
                    return
                } catch {
                    if Task.isCancelled { return }
                }
                self.liveConnected = false
                try? await Task.sleep(for: .seconds(retrySeconds))
                retrySeconds = min(retrySeconds * 2, 30)
            }
        }
        startTrackingEventLoop()
    }

    private func applyOpeningStateEvent(_ payload: String) {
        guard let data = payload.data(using: .utf8),
              let observation = try? JSONDecoder().decode(
                  OpeningStateObservation.self,
                  from: data
              ),
              observation.houseId == selectedHomeID else {
            return
        }
        latestOpeningStateObservation = observation
        guard observation.source == "tapo",
              let externalID = observation.externalId else {
            return
        }
        let candidates = tpLinkDevices.indices.filter {
            tpLinkDevices[$0].deviceId == externalID
                && (observation.connectionId == nil
                    || tpLinkDevices[$0].connectionId == observation.connectionId)
        }
        guard candidates.count == 1, let index = candidates.first else { return }
        let isOpen: Bool?
        switch observation.state {
        case .open: isOpen = true
        case .closed: isOpen = false
        case .unknown: isOpen = nil
        }
        tpLinkDevices[index] = tpLinkDevices[index].updatingContact(
            open: isOpen,
            observedAt: observation.observedAt
        )
        lastUpdated = observation.observedDate ?? Date()
    }

    private func startTrackingEventLoop() {
        trackingEventTask?.cancel()
        guard trackingCapabilities?.featureEnabled("tracking.liveMap.enabled") == true,
              let propertyID = selectedProperty?.id,
              let client else {
            trackingLiveConnected = false
            return
        }
        trackingEventTask = Task { [weak self] in
            guard let self else { return }
            var retrySeconds: UInt64 = 1
            while !Task.isCancelled, self.phase == .ready {
                do {
                    let events = await client.trackingEventStream(
                        propertyID: propertyID,
                        lastEventID: self.trackingSnapshot?.sequence
                    )
                    self.trackingLiveConnected = true
                    retrySeconds = 1
                    for try await event in events {
                        if Task.isCancelled { return }
                        if event.type == "authorization" {
                            self.trackingLiveConnected = false
                            return
                        }
                        if event.type == "snapshot-required"
                            || event.type.hasPrefix("equipment.")
                            || event.type.hasPrefix("endpoint.")
                            || event.type.hasPrefix("gateway.")
                            || event.type.hasPrefix("member.") {
                            self.scheduleTrackingRefresh()
                        }
                    }
                } catch let error as StuguAPIError where error.status == 401 {
                    self.handleAuthenticatedError(error)
                    return
                } catch {
                    if Task.isCancelled { return }
                }
                self.trackingLiveConnected = false
                try? await Task.sleep(for: .seconds(retrySeconds))
                retrySeconds = min(retrySeconds * 2, 30)
            }
        }
    }

    private func scheduleEventRefresh() {
        eventRefreshTask?.cancel()
        eventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    private func scheduleTrackingRefresh() {
        trackingEventRefreshTask?.cancel()
        let scope = currentScopeRequest
        let propertyID = selectedProperty?.id
        trackingEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled,
                  let self,
                  let client = self.client,
                  let propertyID else { return }
            do {
                let snapshot = try await client.trackingMapSnapshot(
                    propertyID: propertyID
                )
                guard self.isCurrent(scope) else { return }
                self.trackingSnapshot = snapshot
            } catch {
                guard self.isCurrent(scope) else { return }
                self.handleAuthenticatedError(error)
            }
        }
    }

    private func stopEventLoop() {
        eventTask?.cancel()
        eventTask = nil
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        trackingEventTask?.cancel()
        trackingEventTask = nil
        trackingEventRefreshTask?.cancel()
        trackingEventRefreshTask = nil
        liveConnected = false
        trackingLiveConnected = false
    }

    @discardableResult
    private func beginScopeChange(propertyChanged: Bool) -> RequestGeneration {
        scopeGeneration &+= 1
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
        trackingEventTask?.cancel()
        trackingEventTask = nil
        trackingEventRefreshTask?.cancel()
        trackingEventRefreshTask = nil
        trackingLiveConnected = false
        if propertyChanged {
            propertyInventory = nil
            trackingSettings = nil
            trackingSnapshot = nil
            mobileTracking.disable()
        }
        return RequestGeneration(account: requestGeneration, scope: scopeGeneration)
    }

    private var currentRequestGeneration: RequestGeneration {
        RequestGeneration(account: requestGeneration, scope: scopeGeneration)
    }

    private var currentScopeRequest: ScopeRequest {
        ScopeRequest(
            generation: currentRequestGeneration,
            propertyID: selectedPropertyID,
            homeID: selectedHomeID
        )
    }

    private func isCurrent(_ generation: RequestGeneration) -> Bool {
        generation == currentRequestGeneration
    }

    private func isCurrent(_ request: ScopeRequest) -> Bool {
        isCurrent(request.generation)
            && selectedPropertyID == request.propertyID
            && selectedHomeID == request.homeID
    }

    private func clearWorkspace() {
        beginScopeChange(propertyChanged: true)
        session = nil
        properties = []
        houses = []
        sensors = []
        definitions = []
        snapshot = []
        propertyMeasurementSnapshots = [:]
        tpLinkDevices = []
        latestOpeningStateObservation = nil
        alerts = []
        rules = []
        propertyInventory = nil
        todayContext = nil
        homeMonitoring = nil
        homeMonitoringAvailability = .unavailable
        systemUpdateStatus = nil
        systemUpdateError = nil
        pendingActions = []
        historyCache = [:]
        cachedAccountIdentity = nil
        trackingCapabilities = nil
        trackingSettings = nil
        trackingSnapshot = nil
        trackingLiveConnected = false
        mobileTracking.suspend()
        memberLocationSharing.suspend()
        selectedHomeID = nil
        selectedPropertyID = nil
        lastUpdated = nil
        usingCachedData = false
        notificationRegistration = nil
        notificationProviderConfigured = false
    }

    private func sortedAlerts(_ values: [AlertEvent]) -> [AlertEvent] {
        let rank = ["critical": 0, "warning": 1, "info": 2]
        return values.sorted {
            let left = rank[$0.severity] ?? 3
            let right = rank[$1.severity] ?? 3
            if left != right { return left < right }
            return ($0.startedDate ?? .distantPast) > ($1.startedDate ?? .distantPast)
        }
    }

    private func handleAuthenticatedError(_ error: Error) {
        if let apiError = error as? StuguAPIError, apiError.status == 401 {
            stopEventLoop()
            requestGeneration += 1
            let retainedPendingActions = pendingActions
            let retainedHistory = historyCache
            let retainedTodayContext = todayContext
            let retainedAccountIdentity = cachedAccountIdentity
            clearWorkspace()
            pendingActions = retainedPendingActions
            historyCache = retainedHistory
            todayContext = retainedTodayContext
            cachedAccountIdentity = retainedAccountIdentity
            phase = .signIn
            clearGlanceableState()
        }
        errorMessage = friendlyMessage(for: error)
    }

    private func isEdgeAccessFailure(_ error: Error) -> Bool {
        if error is EdgeCredential.ValidationError { return true }
        guard let error = error as? StuguAPIError, let code = error.code else { return false }
        return code == "EDGE_ACCESS_REQUIRED" || code == "EDGE_ACCESS_REJECTED"
    }

    private func friendlyMessage(for error: Error) -> String {
        if let error = error as? ServerAddress.ValidationError {
            return error.localizedDescription
        }
        if let error = error as? EdgeCredential.ValidationError {
            return error.localizedDescription
        }
        if let error = error as? StuguAPIError {
            switch error.code {
            case "INVALID_CREDENTIALS":
                return "Email or password is incorrect."
            case "CSRF_TOKEN_INVALID":
                return "Your session changed. Sign in again."
            default:
                return error.message
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet:
                return "This iPhone is not connected to the network."
            case .cannotFindHost, .cannotConnectToHost, .timedOut:
                return "Stugu could not be reached. Check the address and network."
            case .serverCertificateUntrusted, .secureConnectionFailed:
                return "The server’s secure connection could not be verified."
            default:
                return urlError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
