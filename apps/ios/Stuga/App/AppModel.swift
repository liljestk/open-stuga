import Combine
import Foundation

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
        static let server = "stuga.server"
        static let selectedHome = "stuga.selectedHome"
        static let selectedProperty = "stuga.selectedProperty"
        static let units = "stuga.units"
        static let equipmentObservation = "stuga.tracking.mobileObserver.enabled"
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var serverAddress: ServerAddress?
    @Published private(set) var serverVersion: String?
    @Published private(set) var session: AppSession?
    @Published private(set) var properties: [StugaProperty] = []
    @Published private(set) var houses: [House] = []
    @Published private(set) var sensors: [Sensor] = []
    @Published private(set) var definitions: [MeasurementDefinition] = []
    @Published private(set) var snapshot: [MeasurementSnapshotEntry] = []
    @Published private(set) var alerts: [AlertEvent] = []
    @Published private(set) var rules: [AlertRule] = []
    @Published private(set) var propertyInventory: PropertyInventorySnapshot?
    @Published private(set) var selectedHomeID: String?
    @Published private(set) var selectedPropertyID: String?
    @Published private(set) var trackingCapabilities: TrackingCapabilities?
    @Published private(set) var trackingSettings: TrackingPropertySettings?
    @Published private(set) var trackingSnapshot: TrackingMapSnapshot?
    @Published private(set) var trackingLiveConnected = false
    @Published private(set) var equipmentObservationEnabled = UserDefaults.standard.bool(
        forKey: DefaultsKey.equipmentObservation
    )
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var liveConnected = false
    @Published private(set) var isRefreshing = false
    @Published var errorMessage: String?
    @Published var unitSystem = DisplayUnitSystem(
        rawValue: UserDefaults.standard.string(forKey: DefaultsKey.units) ?? ""
    ) ?? .metric {
        didSet {
            UserDefaults.standard.set(unitSystem.rawValue, forKey: DefaultsKey.units)
        }
    }

    private var client: StugaAPIClient?
    private var eventTask: Task<Void, Never>?
    private var eventRefreshTask: Task<Void, Never>?
    private var trackingEventTask: Task<Void, Never>?
    private var trackingEventRefreshTask: Task<Void, Never>?
    private var requestGeneration = 0
    let mobileTracking = MobileTrackingController()
    let memberLocationSharing = MemberLocationSharingController()

    var selectedHome: House? {
        houses.first { $0.id == selectedHomeID }
    }

    var selectedProperty: StugaProperty? {
        if let selectedPropertyID,
           let property = properties.first(where: { $0.id == selectedPropertyID }) {
            return property
        }
        guard let propertyID = selectedHome?.propertyId else { return nil }
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

    func trackedState(for equipmentID: String) -> TrackedEquipmentState? {
        guard let tracked = trackingSnapshot?.assets.first(where: {
            $0.equipment.id == equipmentID
        }) else {
            return nil
        }
        let equipment = selectedPropertyEquipment.first { $0.id == equipmentID }
            ?? tracked.equipment
        return TrackedEquipmentState(
            equipment: equipment,
            tag: tracked.tag,
            assignment: tracked.assignment,
            position: tracked.position
        )
    }

    func areaName(for areaID: String) -> String? {
        selectedPropertyAreas.first { $0.id == areaID }?.name
    }

    var mobileTrackingAvailable: Bool {
        trackingCapabilities?.featureEnabled("tracking.mobileObserver.enabled") == true
            && !isReadOnly
    }

    var memberLocationSharingAvailable: Bool {
        trackingCapabilities?.featureEnabled("tracking.userLocationSharing.enabled") == true
            && trackingCapabilities?.featureEnabled("tracking.liveMap.enabled") == true
            && !isReadOnly
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

    var selectedConditions: [SensorCondition] {
        let measurementsBySensor = Dictionary(uniqueKeysWithValues: snapshot.map {
            ($0.sensorId, $0.measurements)
        })
        return selectedSensors.map {
            SensorCondition(sensor: $0, measurements: measurementsBySensor[$0.id] ?? [:])
        }
    }

    var selectedHomeAlerts: [AlertEvent] {
        let sensorIDs = Set(sensors.filter { $0.houseId == selectedHomeID }.map(\.id))
        return sortedAlerts(alerts.filter { sensorIDs.contains($0.sensorId) })
    }

    var activeAlerts: [AlertEvent] {
        sortedAlerts(alerts.filter(\.isActive))
    }

    var monitorSummary: HomeMonitorSummary {
        HomeMonitorSummary.evaluate(conditions: selectedConditions, alerts: selectedHomeAlerts)
    }

    var isReadOnly: Bool {
        session?.readOnly ?? true
    }

    var serverDisplayName: String {
        serverAddress?.displayName ?? "Stuga"
    }

    var isEncryptedConnection: Bool {
        serverAddress?.origin.scheme?.lowercased() == "https"
    }

    var suggestedServerAddress: String {
        serverAddress?.origin.absoluteString
            ?? UserDefaults.standard.string(forKey: DefaultsKey.server)
            ?? ""
    }

    func start() async {
        guard let saved = UserDefaults.standard.string(forKey: DefaultsKey.server) else {
            phase = .serverSetup
            return
        }
        do {
            let address = try ServerAddress(saved)
            try await configure(address: address, persist: false)
        } catch {
            errorMessage = friendlyMessage(for: error)
            phase = .serverSetup
        }
    }

    func connect(to input: String) async {
        errorMessage = nil
        do {
            let address = try ServerAddress(input)
            let previousValue = UserDefaults.standard.string(forKey: DefaultsKey.server)
            serverAddress = address
            UserDefaults.standard.set(address.origin.absoluteString, forKey: DefaultsKey.server)
            if let previousValue,
               let previousAddress = try? ServerAddress(previousValue),
               previousAddress != address {
                equipmentObservationEnabled = false
                UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
                let previousClient = StugaAPIClient(address: previousAddress)
                await previousClient.clearCookies()
            }
            try await configure(address: address, persist: true)
        } catch {
            errorMessage = friendlyMessage(for: error)
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
            self.session = session
            try await loadWorkspace()
            guard generation == requestGeneration else { return }
            phase = .ready
            startEventLoop()
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func refresh() async {
        guard phase == .ready, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            try await loadWorkspace()
            errorMessage = nil
        } catch {
            handleAuthenticatedError(error)
        }
    }

    func selectHome(_ id: String) async {
        guard let home = houses.first(where: { $0.id == id }), let client else { return }
        let generation = requestGeneration
        if selectedPropertyID != home.propertyId {
            await memberLocationSharing.stopSharing()
        }
        selectedHomeID = id
        selectedPropertyID = home.propertyId
        UserDefaults.standard.set(id, forKey: DefaultsKey.selectedHome)
        UserDefaults.standard.set(home.propertyId, forKey: DefaultsKey.selectedProperty)
        snapshot = []
        do {
            let next = try await client.measurementSnapshot(houseID: id)
            guard generation == requestGeneration, selectedHomeID == id else { return }
            snapshot = next
            try await loadInventoryWorkspace()
            guard generation == requestGeneration, selectedHomeID == id else { return }
            try await loadTrackingWorkspace()
            guard generation == requestGeneration, selectedHomeID == id else { return }
            startTrackingEventLoop()
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            handleAuthenticatedError(error)
        }
    }

    func selectProperty(_ id: String) async {
        guard properties.contains(where: { $0.id == id }), let client else { return }
        let generation = requestGeneration
        if selectedPropertyID != id {
            await memberLocationSharing.stopSharing()
        }
        selectedPropertyID = id
        UserDefaults.standard.set(id, forKey: DefaultsKey.selectedProperty)

        if selectedHome?.propertyId != id {
            selectedHomeID = houses.first(where: { $0.propertyId == id })?.id
            if let selectedHomeID {
                UserDefaults.standard.set(selectedHomeID, forKey: DefaultsKey.selectedHome)
                snapshot = (try? await client.measurementSnapshot(houseID: selectedHomeID)) ?? []
            } else {
                UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedHome)
                snapshot = []
            }
        }

        guard generation == requestGeneration, selectedPropertyID == id else { return }
        do {
            try await loadInventoryWorkspace()
            guard generation == requestGeneration, selectedPropertyID == id else { return }
            try await loadTrackingWorkspace()
            guard generation == requestGeneration, selectedPropertyID == id else { return }
            startTrackingEventLoop()
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            handleAuthenticatedError(error)
        }
    }

    func acknowledge(_ alert: AlertEvent) async {
        guard !isReadOnly, let client else { return }
        let generation = requestGeneration
        do {
            let updated = try await client.acknowledgeAlert(id: alert.id)
            guard generation == requestGeneration else { return }
            if let index = alerts.firstIndex(where: { $0.id == updated.id }) {
                alerts[index] = updated
            }
            errorMessage = nil
        } catch {
            handleAuthenticatedError(error)
        }
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
        do {
            let settings: TrackingPropertySettings
            if let trackingSettings {
                settings = trackingSettings
            } else {
                settings = try await client.trackingPropertySettings(propertyID: property.id)
            }
            self.trackingSettings = settings
            try await mobileTracking.enable(
                client: client,
                serverOrigin: serverAddress.origin.absoluteString,
                propertyID: property.id,
                capabilities: capabilities,
                settings: settings
            )
            equipmentObservationEnabled = true
            UserDefaults.standard.set(true, forKey: DefaultsKey.equipmentObservation)
            errorMessage = nil
        } catch {
            equipmentObservationEnabled = false
            UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
            errorMessage = friendlyMessage(for: error)
        }
    }

    func removeMobileTrackingObserver() async {
        do {
            try await mobileTracking.removeObserverRegistration()
            equipmentObservationEnabled = false
            UserDefaults.standard.set(false, forKey: DefaultsKey.equipmentObservation)
            errorMessage = nil
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func findNearby(_ equipment: TrackedEquipmentState) async {
        guard equipmentObservationEnabled,
              let client else {
            errorMessage = "Turn on equipment observation before starting Find nearby."
            return
        }
        do {
            let token = try await client.trackingScanToken(equipmentID: equipment.id)
            mobileTracking.beginFind(token)
            errorMessage = nil
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func stopFindingNearby() {
        mobileTracking.endFind()
    }

    @discardableResult
    func createEquipment(_ input: AreaEquipmentCreateInput) async throws -> AreaEquipment {
        guard !isReadOnly, let client else {
            throw StugaAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This account cannot change Property inventory."
            )
        }
        guard selectedPropertyAreas.contains(where: { $0.id == input.areaId }) else {
            throw StugaAPIError(
                status: 422,
                code: "AREA_SCOPE_MISMATCH",
                message: "Choose an area in the selected Property."
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
        guard !isReadOnly, let client else {
            throw StugaAPIError(
                status: 403,
                code: "READ_ONLY",
                message: "This account cannot change Property inventory."
            )
        }
        guard selectedPropertyEquipment.contains(where: { $0.id == id }),
              selectedPropertyAreas.contains(where: { $0.id == input.areaId }) else {
            throw StugaAPIError(
                status: 422,
                code: "PROPERTY_SCOPE_MISMATCH",
                message: "This equipment and area must belong to the selected Property."
            )
        }
        let equipment = try await client.updateAreaEquipment(id: id, input: input)
        try await loadInventoryWorkspace()
        errorMessage = nil
        return equipment
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
        guard let client else {
            throw StugaAPIError(status: 0, code: nil, message: "Stuga is not connected.")
        }
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
        guard let client else {
            throw StugaAPIError(status: 0, code: nil, message: "Stuga is not connected.")
        }
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
        guard let client else {
            throw StugaAPIError(status: 0, code: nil, message: "Stuga is not connected.")
        }
        return try await client.borrowEquipment(
            equipmentID: equipment.id,
            expectedReturnAt: expectedReturnAt,
            note: note
        )
    }

    @discardableResult
    func returnEquipment(loan: EquipmentLoan, note: String?) async throws -> EquipmentLoan {
        guard let client else {
            throw StugaAPIError(status: 0, code: nil, message: "Stuga is not connected.")
        }
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
        guard let client else { return [] }
        return try await client.measurementHistory(
            sensorID: sensorID,
            metric: metric,
            from: Date().addingTimeInterval(-Double(hours) * 3_600)
        )
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

    func property(for house: House) -> StugaProperty? {
        properties.first { $0.id == house.propertyId }
    }

    func house(for sensorID: String) -> House? {
        guard let houseID = sensors.first(where: { $0.id == sensorID })?.houseId else { return nil }
        return houses.first { $0.id == houseID }
    }

    func signOut() async {
        requestGeneration += 1
        let generation = requestGeneration
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
            await retiringClient.clearCookies()
        }
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
            errorMessage = friendlyMessage(for: error)
            phase = .ownerSetupRequired
        }
    }

    func sceneBecameActive() async {
        guard phase == .ready else { return }
        mobileTracking.applicationBecameActive()
        memberLocationSharing.applicationBecameActive()
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
        let client = StugaAPIClient(address: address)
        let health = try await client.health()
        guard generation == requestGeneration else { return }
        self.client = client
        serverAddress = address
        serverVersion = health.systemVersion
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
            try await loadWorkspace()
            guard generation == requestGeneration else { return }
            phase = .ready
            startEventLoop()
        } catch let error as StugaAPIError where error.status == 401 {
            guard generation == requestGeneration else { return }
            session = nil
            phase = .signIn
        }
    }

    private func loadWorkspace() async throws {
        guard let client else { return }
        let generation = requestGeneration
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
        guard generation == requestGeneration else { return }
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
        } else if let savedHome, houses.contains(where: { $0.id == savedHome }) {
            selectedHomeID = savedHome
        } else {
            selectedHomeID = houses.first?.id
        }

        let savedProperty = UserDefaults.standard.string(forKey: DefaultsKey.selectedProperty)
        if let selectedPropertyID,
           properties.contains(where: { $0.id == selectedPropertyID }) {
            // Keep the current Property selection.
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

        if let selectedHomeID {
            let nextSnapshot = try await client.measurementSnapshot(houseID: selectedHomeID)
            guard generation == requestGeneration else { return }
            snapshot = nextSnapshot
            UserDefaults.standard.set(selectedHomeID, forKey: DefaultsKey.selectedHome)
        } else {
            snapshot = []
            UserDefaults.standard.removeObject(forKey: DefaultsKey.selectedHome)
        }
        if let selectedPropertyID {
            UserDefaults.standard.set(selectedPropertyID, forKey: DefaultsKey.selectedProperty)
        }
        try await loadInventoryWorkspace()
        guard generation == requestGeneration else { return }
        do {
            try await loadTrackingWorkspace()
        } catch let error as StugaAPIError where error.status == 401 {
            throw error
        } catch {
            trackingCapabilities = nil
            trackingSettings = nil
            trackingSnapshot = nil
            trackingLiveConnected = false
        }
        lastUpdated = Date()
    }

    private func loadInventoryWorkspace() async throws {
        guard let client, let propertyID = selectedProperty?.id else {
            propertyInventory = nil
            return
        }
        let inventory = try await client.propertyInventory(propertyID: propertyID)
        guard selectedProperty?.id == propertyID else { return }
        propertyInventory = inventory
    }

    private func loadTrackingWorkspace() async throws {
        guard let client else { return }
        let capabilities = try await client.trackingCapabilities()
        trackingCapabilities = capabilities
        if !memberLocationSharingAvailable {
            await memberLocationSharing.stopSharing()
        }
        guard capabilities.featureEnabled("tracking.enabled"),
              let property = selectedProperty else {
            trackingSettings = nil
            trackingSnapshot = nil
            mobileTracking.disable()
            return
        }
        do {
            trackingSettings = try await client.trackingPropertySettings(propertyID: property.id)
        } catch let error as StugaAPIError where error.status == 404 {
            trackingSettings = nil
            trackingSnapshot = nil
            mobileTracking.disable()
            return
        }
        if capabilities.featureEnabled("tracking.liveMap.enabled") {
            trackingSnapshot = try await client.trackingMapSnapshot(propertyID: property.id)
        } else {
            trackingSnapshot = nil
        }
        if equipmentObservationEnabled,
           mobileTrackingAvailable,
           let serverAddress,
           let trackingSettings {
            do {
                try await mobileTracking.enable(
                    client: client,
                    serverOrigin: serverAddress.origin.absoluteString,
                    propertyID: property.id,
                    capabilities: capabilities,
                    settings: trackingSettings
                )
            } catch let error as StugaAPIError where error.status == 401 {
                throw error
            } catch {
                mobileTracking.disable()
                errorMessage = friendlyMessage(for: error)
            }
        } else {
            mobileTracking.disable()
        }
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
                        if ["reading", "measurement", "alert", "mutation", "weather"].contains(event.type) {
                            self.scheduleEventRefresh()
                        }
                    }
                } catch let error as StugaAPIError where error.status == 401 {
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
                            || event.type.hasPrefix("asset.")
                            || event.type.hasPrefix("tag.")
                            || event.type.hasPrefix("gateway.")
                            || event.type.hasPrefix("member.") {
                            self.scheduleTrackingRefresh()
                        }
                    }
                } catch let error as StugaAPIError where error.status == 401 {
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
        trackingEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled,
                  let self,
                  let client = self.client,
                  let propertyID = self.selectedProperty?.id else { return }
            do {
                self.trackingSnapshot = try await client.trackingMapSnapshot(
                    propertyID: propertyID
                )
            } catch {
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

    private func clearWorkspace() {
        session = nil
        properties = []
        houses = []
        sensors = []
        definitions = []
        snapshot = []
        alerts = []
        rules = []
        propertyInventory = nil
        trackingCapabilities = nil
        trackingSettings = nil
        trackingSnapshot = nil
        trackingLiveConnected = false
        mobileTracking.suspend()
        memberLocationSharing.suspend()
        selectedHomeID = nil
        selectedPropertyID = nil
        lastUpdated = nil
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
        if let apiError = error as? StugaAPIError, apiError.status == 401 {
            stopEventLoop()
            requestGeneration += 1
            clearWorkspace()
            phase = .signIn
        }
        errorMessage = friendlyMessage(for: error)
    }

    private func friendlyMessage(for error: Error) -> String {
        if let error = error as? ServerAddress.ValidationError {
            return error.localizedDescription
        }
        if let error = error as? StugaAPIError {
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
                return "Stuga could not be reached. Check the address and network."
            case .serverCertificateUntrusted, .secureConnectionFailed:
                return "The server’s secure connection could not be verified."
            default:
                return urlError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
