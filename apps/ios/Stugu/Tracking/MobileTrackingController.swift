import Combine
import CoreBluetooth
import CoreLocation
import Foundation
import UIKit

@MainActor
final class MobileTrackingController: NSObject, ObservableObject {
    enum Mode: String, Equatable {
        case disabled
        case passive
        case property
        case activeProperty
        case findNearby

        var displayName: String {
            switch self {
            case .disabled: "Disabled"
            case .passive: "Passive"
            case .property: "Property"
            case .activeProperty: "Active Property"
            case .findNearby: "Find nearby"
            }
        }
    }

    @Published private(set) var mode: Mode = .disabled
    @Published private(set) var bluetoothStatus = "Not active"
    @Published private(set) var locationStatus = "Not requested"
    @Published private(set) var queueStatus = TrackingObservationQueue.Status(
        queuedCount: 0,
        droppedCount: 0
    )
    @Published private(set) var lastDetectionAt: Date?
    @Published private(set) var proximity: TrackingProximityReading?
    @Published private(set) var findingEquipmentID: String?
    @Published private(set) var errorMessage: String?

    var isEnabled: Bool { identity != nil && mode != .disabled }
    var hasObserverRegistration: Bool { identity != nil }
    var supportsPropertyAutomation: Bool {
        capabilities?.featureEnabled("tracking.mobileObserver.iosBackground.enabled") == true
            && CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self)
    }

    private let credentialStore = TrackingCredentialStore()
    private let locationManager = CLLocationManager()
    private var centralManager: CBCentralManager!
    private var client: StuguAPIClient?
    private var identity: TrackingObserverIdentity?
    private var capabilities: TrackingCapabilities?
    private var settings: TrackingPropertySettings?
    private var profileManifest: TrackingProfileManifest?
    private var resolutionManifest: TrackingResolutionManifest?
    private var findDescriptor: TrackingFindDescriptor?
    private var queue: TrackingObservationQueue?
    private var lastLocation: CLLocation?
    private var signalSmoother = TrackingSignalSmoother()
    private var uploadTask: Task<Void, Never>?
    private var resolutionRefreshTask: Task<Void, Never>?
    private var modeTimeoutTask: Task<Void, Never>?
    private var uploadInProgress = false
    private var sceneIsActive = true
    private var lastHapticAt = Date.distantPast

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        locationManager.distanceFilter = 10
        centralManager = CBCentralManager(
            delegate: self,
            queue: .main,
            options: [CBCentralManagerOptionRestoreIdentifierKey: "net.nysta.stugu.tracking.central"]
        )
        updatePermissionPresentation()
    }

    func enable(
        client: StuguAPIClient,
        serverOrigin: String,
        propertyID: String,
        capabilities: TrackingCapabilities,
        settings: TrackingPropertySettings
    ) async throws {
        guard capabilities.schemaVersion == TrackingSchema.version,
              capabilities.profileSchemaVersion == TrackingSchema.profileVersion,
              capabilities.featureEnabled("tracking.enabled"),
              capabilities.featureEnabled("tracking.mobileObserver.enabled") else {
            throw StuguAPIError(
                status: 404,
                code: "MOBILE_OBSERVER_DISABLED",
                message: "Mobile equipment observation is not enabled on this Stugu."
            )
        }
        let preservingMode = identity?.serverOrigin == serverOrigin
            && identity?.propertyId == propertyID
            && mode != .disabled
        let installationID = try credentialStore.installationID()
        let observerIdentity: TrackingObserverIdentity
        if let stored = credentialStore.identity(
            serverOrigin: serverOrigin,
            propertyID: propertyID
        ) {
            observerIdentity = stored
        } else {
            let version = Bundle.main.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "unknown"
            let registration = try await client.registerTrackingObserver(
                TrackingObserverRegistrationInput(
                    propertyId: propertyID,
                    name: Self.observerName,
                    appInstallationId: installationID,
                    hardwareMetadata: [
                        "platform": .string(Self.observerPlatform),
                        "osVersion": .string(Self.systemVersion),
                        "appVersion": .string(version),
                    ]
                )
            )
            observerIdentity = TrackingObserverIdentity(
                serverOrigin: serverOrigin,
                propertyId: propertyID,
                observerId: registration.observer.id,
                credential: registration.credential,
                installationId: installationID
            )
            try credentialStore.save(observerIdentity)
        }

        async let profilesRequest = client.trackingProfiles()
        async let resolutionRequest = client.trackingResolutionManifest(
            observerID: observerIdentity.observerId,
            observerCredential: observerIdentity.credential
        )
        let (profiles, resolutions) = try await (profilesRequest, resolutionRequest)
        guard profiles.schemaVersion == TrackingSchema.profileVersion,
              resolutions.propertyId == propertyID,
              resolutions.observerId == observerIdentity.observerId,
              StuguDateParser.date(from: resolutions.validUntil).map({ $0 > Date() }) == true else {
            throw StuguAPIError(
                status: 0,
                code: "INVALID_TRACKING_MANIFEST",
                message: "Stugu returned an invalid tracking profile or resolver manifest."
            )
        }

        self.client = client
        identity = observerIdentity
        self.capabilities = capabilities
        self.settings = settings
        profileManifest = profiles
        resolutionManifest = resolutions
        let directory = try trackingApplicationSupportDirectory()
        queue = TrackingObservationQueue(
            storageURL: directory.appendingPathComponent(
                "\(observerIdentity.observerId).evidence.json",
                isDirectory: false
            )
        )
        if let queue { queueStatus = await queue.status }
        if !preservingMode {
            modeTimeoutTask?.cancel()
            findDescriptor = nil
            findingEquipmentID = nil
            proximity = nil
            signalSmoother.reset()
            mode = .passive
        }
        scheduleResolutionRefresh()
        configurePropertyRegionIfAuthorized()
        applyScan()
        scheduleUpload(after: 0)
    }

    func disable() {
        uploadTask?.cancel()
        uploadTask = nil
        resolutionRefreshTask?.cancel()
        resolutionRefreshTask = nil
        modeTimeoutTask?.cancel()
        modeTimeoutTask = nil
        centralManager.stopScan()
        stopMonitoringPropertyRegions()
        mode = .disabled
        findDescriptor = nil
        findingEquipmentID = nil
        proximity = nil
        signalSmoother.reset()
        bluetoothStatus = "Observation off"
    }

    func removeObserverRegistration() async throws {
        guard let client, let identity else { return }
        _ = try await client.disableTrackingObserver(id: identity.observerId)
        try credentialStore.remove(
            serverOrigin: identity.serverOrigin,
            propertyID: identity.propertyId
        )
        suspend()
    }

    func suspend() {
        disable()
        client = nil
        identity = nil
        capabilities = nil
        settings = nil
        profileManifest = nil
        resolutionManifest = nil
        queue = nil
    }

    func applicationBecameActive() {
        sceneIsActive = true
        if mode == .findNearby || mode == .activeProperty { applyScan() }
        scheduleUpload(after: 0)
    }

    func applicationBecameInactive() {
        sceneIsActive = false
        if mode == .findNearby || mode == .activeProperty { endTemporaryMode() }
        applyScan()
    }

    func requestPropertyAutomation() {
        guard isEnabled, supportsPropertyAutomation else { return }
        locationManager.requestAlwaysAuthorization()
        updatePermissionPresentation()
    }

    func beginActivePropertyMode(duration: TimeInterval = 60 * 60) {
        guard isEnabled else { return }
        modeTimeoutTask?.cancel()
        mode = .activeProperty
        locationManager.requestWhenInUseAuthorization()
        requestFreshLocation()
        applyScan()
        modeTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self?.endTemporaryMode()
        }
    }

    func beginFind(_ descriptor: TrackingFindDescriptor, duration: TimeInterval = 10 * 60) {
        guard isEnabled,
              descriptor.profile.profile.schemaVersion == TrackingSchema.profileVersion,
              StuguDateParser.date(from: descriptor.validUntil).map({ $0 > Date() }) == true,
              descriptor.profile.profile.platformSupport.contains(where: {
                  $0.platform == "ios" && $0.scanContexts.contains("foreground-find")
              }) else {
            errorMessage = "This endpoint cannot be found from this iPhone, or the Find session expired."
            return
        }
        modeTimeoutTask?.cancel()
        findDescriptor = descriptor
        findingEquipmentID = descriptor.equipmentId
        signalSmoother.reset()
        proximity = nil
        mode = .findNearby
        locationManager.requestWhenInUseAuthorization()
        requestFreshLocation()
        applyScan()
        modeTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self?.endFind()
        }
    }

    func endFind() {
        findDescriptor = nil
        findingEquipmentID = nil
        proximity = nil
        signalSmoother.reset()
        endTemporaryMode()
    }

    private func endTemporaryMode() {
        modeTimeoutTask?.cancel()
        modeTimeoutTask = nil
        mode = isInsideMonitoredProperty ? .property : .passive
        findDescriptor = nil
        findingEquipmentID = nil
        proximity = nil
        signalSmoother.reset()
        applyScan()
    }

    private var isInsideMonitoredProperty: Bool {
        guard let region = monitoredPropertyRegion, let location = lastLocation else { return false }
        return region.contains(location.coordinate)
    }

    private var monitoredPropertyRegion: CLCircularRegion? {
        locationManager.monitoredRegions.first {
            $0.identifier.hasPrefix("stugu-property-")
        } as? CLCircularRegion
    }

    private func configurePropertyRegionIfAuthorized() {
        stopMonitoringPropertyRegions()
        guard supportsPropertyAutomation,
              CLLocationManager.authorizationStatus() == .authorizedAlways,
              let boundary = settings?.propertyBoundary,
              boundary.count >= 3 else { return }
        let latitude = boundary.map(\.latitude).reduce(0, +) / Double(boundary.count)
        let longitude = boundary.map(\.longitude).reduce(0, +) / Double(boundary.count)
        let center = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        let centerLocation = CLLocation(latitude: latitude, longitude: longitude)
        let boundaryRadius = boundary.map {
            centerLocation.distance(from: CLLocation(latitude: $0.latitude, longitude: $0.longitude))
        }.max() ?? 100
        let maximum = max(100, locationManager.maximumRegionMonitoringDistance)
        let region = CLCircularRegion(
            center: center,
            radius: min(maximum, max(50, boundaryRadius + 30)),
            identifier: "stugu-property-\(settings?.propertyId ?? "unknown")"
        )
        region.notifyOnEntry = true
        region.notifyOnExit = true
        locationManager.startMonitoring(for: region)
        locationManager.requestState(for: region)
    }

    private func stopMonitoringPropertyRegions() {
        for region in locationManager.monitoredRegions
            where region.identifier.hasPrefix("stugu-property-") {
            locationManager.stopMonitoring(for: region)
        }
    }

    private var scanContext: String {
        if mode == .findNearby { return "foreground-find" }
        return sceneIsActive ? "foreground" : "background"
    }

    private var activeProfiles: [TrackingProfile] {
        if let findDescriptor { return [findDescriptor.profile.profile] }
        guard let profileManifest, let resolutionManifest else { return [] }
        let references = Set(
            resolutionManifest.entries.map { "\($0.profileId)\u{001f}\($0.profileVersion)" }
        )
        return profileManifest.profiles.map(\.profile).filter {
            references.contains("\($0.id)\u{001f}\($0.version)")
                && $0.platformSupport.contains(where: { support in
                    support.platform == "ios" && support.scanContexts.contains(scanContext)
                })
        }
    }

    private func applyScan() {
        guard mode != .disabled,
              sceneIsActive || capabilities?.featureEnabled(
                  "tracking.mobileObserver.iosBackground.enabled"
              ) == true,
              centralManager.state == .poweredOn else {
            centralManager.stopScan()
            updateBluetoothPresentation()
            return
        }
        let profiles = activeProfiles
        guard !profiles.isEmpty else {
            centralManager.stopScan()
            bluetoothStatus = "No claimed endpoints match this scan mode"
            return
        }
        let broadForegroundScan = sceneIsActive && profiles.contains {
            $0.serviceUuids.isEmpty
        }
        let identifiers = Set(profiles.flatMap(\.serviceUuids))
        let services: [CBUUID]?
        if broadForegroundScan {
            services = nil
        } else if identifiers.isEmpty {
            centralManager.stopScan()
            bluetoothStatus = "No background-compatible endpoint filters"
            return
        } else {
            services = identifiers.map(CBUUID.init(string:))
        }
        centralManager.stopScan()
        centralManager.scanForPeripherals(
            withServices: services,
            options: [
                CBCentralManagerScanOptionAllowDuplicatesKey:
                    mode == .findNearby && sceneIsActive,
            ]
        )
        updateBluetoothPresentation()
    }

    private func handleAdvertisement(
        _ frame: TrackingLocalAdvertisementFrame,
        advertisedTxPower: Int?
    ) {
        guard let identity, let resolutionManifest, let queue else { return }
        let resolved: ResolvedTrackingAdvertisement?
        if let descriptor = findDescriptor,
           let match = TrackingAdvertisementParser.parse(
               frame,
               profile: descriptor.profile.profile
           ),
           match.identityFields == descriptor.identityFields {
            resolved = ResolvedTrackingAdvertisement(
                resolution: TrackingResolutionEntry(
                    equipmentId: descriptor.equipmentId,
                    endpointId: descriptor.endpointId,
                    profileId: match.profileId,
                    profileVersion: match.profileVersion,
                    identityFields: match.identityFields
                ),
                match: match
            )
        } else {
            resolved = TrackingAdvertisementParser.resolve(
                frame,
                profiles: activeProfiles,
                entries: resolutionManifest.entries
            )
        }
        guard let resolved else { return } // Unknown and ambiguous frames remain local.

        if mode == .findNearby {
            guard resolved.resolution.equipmentId == findingEquipmentID else { return }
            let reading = signalSmoother.add(rssi: frame.rssi)
            proximity = reading
            provideFindHaptic(for: reading.band)
        }
        lastDetectionAt = Date()
        if mode != .passive { requestFreshLocation() }
        let now = Date()
        var telemetry = resolved.match.telemetry
        telemetry["platform"] = .string("IOS")
        telemetry["osVersion"] = .string(UIDevice.current.systemVersion)
        let observation = TrackingObservationInput(
            dataMode: resolutionManifest.dataMode,
            propertyId: identity.propertyId,
            endpointId: resolved.resolution.endpointId,
            equipmentId: resolved.resolution.equipmentId,
            observerId: identity.observerId,
            observedAt: Self.timestamp(now),
            profileId: resolved.match.profileId,
            profileVersion: resolved.match.profileVersion,
            rssi: frame.rssi,
            txPower: advertisedTxPower ?? integerTelemetry("txPower", in: telemetry),
            motion: booleanTelemetry("motion", in: telemetry),
            batteryPercent: integerTelemetry("batteryPercent", in: telemetry),
            counter: integerTelemetry("counter", in: telemetry),
            observerPosition: currentObserverPosition(at: now),
            scanContext: scanContext,
            telemetry: telemetry
        )
        Task { [weak self] in
            guard let self else { return }
            do {
                self.queueStatus = try await queue.enqueue(observation)
                self.scheduleUpload(after: self.uploadDelay)
            } catch {
                self.errorMessage = "A claimed endpoint detection could not be saved on this iPhone."
            }
        }
    }

    private func integerTelemetry(
        _ key: String,
        in telemetry: [String: JSONValue]
    ) -> Int? {
        guard let raw = telemetry[key], case let .number(value) = raw else { return nil }
        return Int(value)
    }

    private func booleanTelemetry(
        _ key: String,
        in telemetry: [String: JSONValue]
    ) -> Bool? {
        guard let raw = telemetry[key], case let .bool(value) = raw else { return nil }
        return value
    }

    private var uploadDelay: TimeInterval {
        switch mode {
        case .findNearby, .activeProperty: 1
        case .property: 10
        case .passive, .disabled: 30
        }
    }

    private func scheduleUpload(after delay: TimeInterval) {
        guard isEnabled else { return }
        if uploadTask != nil, delay > 0 { return }
        uploadTask?.cancel()
        uploadTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            await self?.flushQueue()
        }
    }

    private func flushQueue() async {
        uploadTask = nil
        guard !uploadInProgress,
              let client,
              let identity,
              let queue,
              let capabilities else { return }
        uploadInProgress = true
        defer { uploadInProgress = false }
        let limit = min(100, capabilities.maximumObservationBatchSize)
        let batch: [TrackingObservationInput]
        do {
            batch = try await queue.nextBatch(limit: limit)
        } catch {
            queueStatus = await queue.status
            errorMessage = "Saved detections could not be prepared for upload."
            return
        }
        guard !batch.isEmpty else {
            queueStatus = await queue.status
            return
        }
        do {
            let result = try await client.uploadTrackingObservations(
                batch,
                observerCredential: identity.credential
            )
            queueStatus = try await queue.acknowledge(
                observationIDs: Set(batch.map(\.id))
            )
            errorMessage = result.rejected == 0
                ? nil
                : "\(result.rejected) stale or no-longer-authorized detection(s) were discarded."
            if queueStatus.queuedCount > 0 { scheduleUpload(after: uploadDelay) }
        } catch {
            queueStatus = await queue.status
            if let apiError = error as? StuguAPIError, apiError.status == 401 {
                errorMessage = "This iPhone observer was revoked. Turn equipment observation off and contact a Stugu Owner."
            } else {
                errorMessage = "Detections are saved on this iPhone and will upload when Stugu is reachable."
                scheduleUpload(after: max(30, uploadDelay))
            }
        }
    }

    private func scheduleResolutionRefresh(retryAfter: TimeInterval? = nil) {
        resolutionRefreshTask?.cancel()
        let delay = retryAfter ?? resolutionManifest.flatMap {
            StuguDateParser.date(from: $0.validUntil)
        }.map {
            max(60, $0.timeIntervalSinceNow - 60)
        } ?? 60
        resolutionRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.refreshResolutionManifest()
        }
    }

    private func refreshResolutionManifest() async {
        guard let client, let identity else { return }
        do {
            let manifest = try await client.trackingResolutionManifest(
                observerID: identity.observerId,
                observerCredential: identity.credential
            )
            guard manifest.propertyId == identity.propertyId,
                  manifest.observerId == identity.observerId,
                  StuguDateParser.date(from: manifest.validUntil).map({ $0 > Date() }) == true else {
                throw StuguAPIError(
                    status: 0,
                    code: "INVALID_TRACKING_MANIFEST",
                    message: "Stugu returned an invalid resolver manifest."
                )
            }
            resolutionManifest = manifest
            errorMessage = nil
            applyScan()
            scheduleResolutionRefresh()
        } catch {
            errorMessage = "The claimed-endpoint resolver cache could not refresh."
            scheduleResolutionRefresh(retryAfter: 60)
        }
    }

    private func requestFreshLocation() {
        guard CLLocationManager.authorizationStatus() == .authorizedAlways
                || CLLocationManager.authorizationStatus() == .authorizedWhenInUse else {
            return
        }
        if let lastLocation,
           Date().timeIntervalSince(lastLocation.timestamp) <= 60,
           lastLocation.horizontalAccuracy >= 0 {
            return
        }
        locationManager.requestLocation()
    }

    private func currentObserverPosition(at date: Date) -> TrackingObserverPosition? {
        guard let location = lastLocation,
              location.horizontalAccuracy >= 0,
              date.timeIntervalSince(location.timestamp) <= 120 else {
            return nil
        }
        return TrackingObserverPosition(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracyMeters: location.horizontalAccuracy,
            source: "gps",
            capturedAt: Self.timestamp(location.timestamp),
            reducedAccuracy: locationManager.accuracyAuthorization == .reducedAccuracy
        )
    }

    private func provideFindHaptic(for band: TrackingProximityBand) {
        #if targetEnvironment(macCatalyst)
        return
        #else
        let minimumInterval: TimeInterval
        let style: UIImpactFeedbackGenerator.FeedbackStyle
        switch band {
        case .far: (minimumInterval, style) = (2, .light)
        case .nearby: (minimumInterval, style) = (1, .light)
        case .close: (minimumInterval, style) = (0.55, .medium)
        case .veryClose: (minimumInterval, style) = (0.25, .heavy)
        }
        guard Date().timeIntervalSince(lastHapticAt) >= minimumInterval else { return }
        lastHapticAt = Date()
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        #endif
    }

    private static var observerName: String {
        #if targetEnvironment(macCatalyst)
        "Mac observer"
        #else
        "iPhone observer"
        #endif
    }

    private static var observerPlatform: String {
        #if targetEnvironment(macCatalyst)
        "MACOS"
        #else
        "IOS"
        #endif
    }

    private static var systemVersion: String {
        #if targetEnvironment(macCatalyst)
        ProcessInfo.processInfo.operatingSystemVersionString
        #else
        UIDevice.current.systemVersion
        #endif
    }

    private func trackingApplicationSupportDirectory() throws -> URL {
        guard let root = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        return root.appendingPathComponent("Stugu/Tracking", isDirectory: true)
    }

    private func updatePermissionPresentation() {
        updateBluetoothPresentation()
        switch CLLocationManager.authorizationStatus() {
        case .authorizedAlways: locationStatus = "Property automation allowed"
        case .authorizedWhenInUse: locationStatus = "Location while using"
        case .denied, .restricted: locationStatus = "Location off"
        case .notDetermined: locationStatus = "Location not requested"
        @unknown default: locationStatus = "Location status unknown"
        }
    }

    private func updateBluetoothPresentation() {
        guard centralManager != nil else {
            bluetoothStatus = "Starting"
            return
        }
        switch centralManager.state {
        case .poweredOn:
            bluetoothStatus = mode == .disabled
                ? "Observation off"
                : "Listening for claimed tracking endpoints"
        case .poweredOff: bluetoothStatus = "Bluetooth off"
        case .unauthorized: bluetoothStatus = "Bluetooth permission denied"
        case .unsupported: bluetoothStatus = "Bluetooth LE unavailable"
        case .resetting: bluetoothStatus = "Bluetooth restarting"
        case .unknown: bluetoothStatus = "Bluetooth starting"
        @unknown default: bluetoothStatus = "Bluetooth status unknown"
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

extension MobileTrackingController: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        updateBluetoothPresentation()
        if central.state == .poweredOn { applyScan() }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard RSSI.intValue != 127 else { return }
        let serviceData = (
            advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]
        ) ?? [:]
        let serviceUuids = (
            advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]
        ) ?? []
        let overflowUuids = (
            advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID]
        ) ?? []
        let manufacturerData: [String: Data]
        if let value = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
           value.count >= 2 {
            let company = UInt16(value[0]) | UInt16(value[1]) << 8
            manufacturerData = [
                String(format: "%04x", company): Data(value.dropFirst(2)),
            ]
        } else {
            manufacturerData = [:]
        }
        let frame = TrackingLocalAdvertisementFrame(
            serviceUuids: (serviceUuids + overflowUuids).map(\.uuidString),
            manufacturerData: manufacturerData,
            serviceData: Dictionary(
                uniqueKeysWithValues: serviceData.map { ($0.key.uuidString, $0.value) }
            ),
            localName: advertisementData[CBAdvertisementDataLocalNameKey] as? String,
            peripheralIdentifier: peripheral.identifier.uuidString.lowercased(),
            connectable: (
                advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber
            )?.boolValue,
            rssi: RSSI.intValue,
            observedAt: Self.timestamp(Date())
        )
        handleAdvertisement(
            frame,
            advertisedTxPower: (
                advertisementData[CBAdvertisementDataTxPowerLevelKey] as? NSNumber
            )?.intValue
        )
    }

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        applyScan()
    }
}

extension MobileTrackingController: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        updatePermissionPresentation()
        configurePropertyRegionIfAuthorized()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let location = locations.last, location.horizontalAccuracy >= 0 {
            lastLocation = location
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code != .locationUnknown {
            errorMessage = "The iPhone location was unavailable; claimed detections can still upload without it."
        }
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier.hasPrefix("stugu-property-"), mode == .passive else { return }
        mode = .property
        requestFreshLocation()
        applyScan()
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier.hasPrefix("stugu-property-"), mode == .property else { return }
        mode = .passive
        applyScan()
    }

    func locationManager(
        _ manager: CLLocationManager,
        didDetermineState state: CLRegionState,
        for region: CLRegion
    ) {
        guard region.identifier.hasPrefix("stugu-property-"),
              mode == .passive || mode == .property else { return }
        mode = state == .inside ? .property : .passive
        applyScan()
    }
}
