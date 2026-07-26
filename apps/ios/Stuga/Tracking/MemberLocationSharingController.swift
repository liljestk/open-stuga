import Combine
import CoreLocation
import Foundation
import UIKit

@MainActor
final class MemberLocationSharingController: NSObject, ObservableObject {
    @Published private(set) var isSharing = false
    @Published private(set) var status = "Not sharing"
    @Published private(set) var lastSharedAt: Date?
    @Published private(set) var errorMessage: String?

    private let locationManager = CLLocationManager()
    private var client: StugaAPIClient?
    private var propertyID: String?
    private var sharingUntil: Date?
    private var lastUploadAt = Date.distantPast
    private var uploadTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var generation = 0

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.activityType = .other
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.allowsBackgroundLocationUpdates = false
    }

    func startSharing(
        client: StugaAPIClient,
        propertyID: String,
        duration: TimeInterval
    ) async throws {
        guard UIApplication.shared.applicationState == .active else {
            throw StugaAPIError(
                status: 0,
                code: "FOREGROUND_REQUIRED",
                message: "Open Stuga to share your live Property location."
            )
        }
        guard CLLocationManager.locationServicesEnabled() else {
            throw StugaAPIError(
                status: 0,
                code: "LOCATION_DISABLED",
                message: "Location Services are turned off on this iPhone."
            )
        }
        let authorization = locationManager.authorizationStatus
        guard authorization != .denied, authorization != .restricted else {
            throw StugaAPIError(
                status: 0,
                code: "LOCATION_PERMISSION_DENIED",
                message: "Allow location access in Settings to share your Property location."
            )
        }

        generation += 1
        self.client = client
        self.propertyID = propertyID
        sharingUntil = Date().addingTimeInterval(min(max(60, duration), 4 * 60 * 60))
        isSharing = true
        status = authorization == .notDetermined
            ? "Waiting for permission"
            : "Sharing while Stuga is open"
        errorMessage = nil
        lastUploadAt = .distantPast
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            guard let self, let sharingUntil = self.sharingUntil else { return }
            try? await Task.sleep(for: .seconds(max(0, sharingUntil.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            await self.stopSharing()
        }

        if authorization == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
        } else {
            locationManager.startUpdatingLocation()
        }
    }

    func stopSharing() async {
        generation += 1
        let retiringClient = client
        let retiringPropertyID = propertyID
        stopLocally()
        let pending = uploadTask
        uploadTask?.cancel()
        uploadTask = nil
        await pending?.value
        if let retiringClient, let retiringPropertyID {
            try? await retiringClient.stopPropertyMemberLocation(propertyID: retiringPropertyID)
        }
    }

    func applicationBecameActive() {
        // Sharing never resumes implicitly. The person must tap Share again.
    }

    func applicationBecameInactive() {
        // Permission sheets and other system overlays make the app inactive
        // without putting it in the background. Keep the explicit session
        // alive through those foreground interruptions.
        guard UIApplication.shared.applicationState == .background else { return }
        guard isSharing || propertyID != nil else { return }
        Task { [weak self] in await self?.stopSharing() }
    }

    func suspend() {
        generation += 1
        uploadTask?.cancel()
        uploadTask = nil
        stopLocally()
    }

    private func stopLocally() {
        locationManager.stopUpdatingLocation()
        timeoutTask?.cancel()
        timeoutTask = nil
        isSharing = false
        status = "Not sharing"
        client = nil
        propertyID = nil
        sharingUntil = nil
        lastUploadAt = .distantPast
    }

    private func share(_ location: CLLocation) {
        guard isSharing,
              uploadTask == nil,
              let client,
              let propertyID,
              let sharingUntil,
              sharingUntil > Date(),
              location.horizontalAccuracy >= 0,
              Date().timeIntervalSince(location.timestamp) <= 120,
              Date().timeIntervalSince(lastUploadAt) >= 10 else {
            return
        }
        let currentGeneration = generation
        lastUploadAt = Date()
        let timestamp = ISO8601DateFormatter.stugaFractional
        let input = PropertyMemberLocationInput(
            coordinate: GeoCoordinate(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude
            ),
            horizontalAccuracyMeters: location.horizontalAccuracy,
            reducedAccuracy: locationManager.accuracyAuthorization == .reducedAccuracy,
            capturedAt: timestamp.string(from: location.timestamp),
            sharingUntil: timestamp.string(from: sharingUntil)
        )
        uploadTask = Task { [weak self] in
            do {
                _ = try await client.sharePropertyMemberLocation(
                    propertyID: propertyID,
                    input: input
                )
                guard let self, self.generation == currentGeneration else { return }
                self.lastSharedAt = Date()
                self.status = "Sharing while Stuga is open"
                self.errorMessage = nil
                self.uploadTask = nil
            } catch is CancellationError {
                self?.uploadTask = nil
            } catch {
                guard let self, self.generation == currentGeneration else { return }
                self.status = "Sharing retry pending"
                self.errorMessage = "Your current location could not be updated."
                self.uploadTask = nil
            }
        }
    }
}

extension MemberLocationSharingController: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isSharing else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            status = "Sharing while Stuga is open"
            manager.startUpdatingLocation()
        case .denied, .restricted:
            errorMessage = "Location permission was not granted."
            Task { [weak self] in await self?.stopSharing() }
        case .notDetermined:
            status = "Waiting for permission"
        @unknown default:
            errorMessage = "Location permission is unavailable."
            Task { [weak self] in await self?.stopSharing() }
        }
    }

    func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let location = locations.last else { return }
        share(location)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard (error as? CLError)?.code != .locationUnknown else { return }
        errorMessage = "Your current location is temporarily unavailable."
    }
}

private extension ISO8601DateFormatter {
    static let stugaFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
