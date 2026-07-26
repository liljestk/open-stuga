import AppIntents
import Foundation

enum StuguAppIntentRouteStore {
    static let didRequestRoute = Notification.Name(
        "net.stugu.app-intent-route-requested"
    )

    private static let pendingRouteKey = "app-intent.pending-route"

    static func request(_ route: String) {
        UserDefaults.standard.set(route, forKey: pendingRouteKey)
        NotificationCenter.default.post(name: didRequestRoute, object: nil)
    }

    static func consume() -> URL? {
        guard let route = UserDefaults.standard.string(forKey: pendingRouteKey) else {
            return nil
        }
        UserDefaults.standard.removeObject(forKey: pendingRouteKey)
        return URL(string: route)
    }
}

struct CheckStuguIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Stugu"
    static let description = IntentDescription(
        "Reads the latest Home summary saved securely by the Stugu app."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = CompanionWidgetSnapshotStore().load() else {
            return .result(
                dialog: "Open Stugu once to save a Home summary on this device."
            )
        }
        let alerts = snapshot.activeAlertCount == 0
            ? "No active alerts."
            : "\(snapshot.activeAlertCount) active alert\(snapshot.activeAlertCount == 1 ? "" : "s")."
        return .result(
            dialog: "\(snapshot.homeName): \(snapshot.title). \(alerts)"
        )
    }
}

struct CaptureStuguObservationIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Stugu Observation"
    static let description = IntentDescription(
        "Opens Stugu's quick field-capture form."
    )
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        StuguAppIntentRouteStore.request("stugu://capture")
        return .result()
    }
}

struct OpenStuguAlertsIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Stugu Alerts"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        StuguAppIntentRouteStore.request("stugu://alerts")
        return .result()
    }
}

struct ScanStuguRoomIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan a Stugu Room"
    static let description = IntentDescription(
        "Opens Stugu's reviewable RoomPlan capture."
    )
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        StuguAppIntentRouteStore.request("stugu://room-scan")
        return .result()
    }
}

struct StuguShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CheckStuguIntent(),
            phrases: [
                "How is \(.applicationName)",
                "Check my Home in \(.applicationName)",
            ],
            shortTitle: "Check Home",
            systemImageName: "house"
        )
        AppShortcut(
            intent: CaptureStuguObservationIntent(),
            phrases: [
                "Add an observation in \(.applicationName)",
                "Record something in \(.applicationName)",
            ],
            shortTitle: "Add Observation",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenStuguAlertsIntent(),
            phrases: [
                "Show alerts in \(.applicationName)",
            ],
            shortTitle: "Show Alerts",
            systemImageName: "bell"
        )
        AppShortcut(
            intent: ScanStuguRoomIntent(),
            phrases: [
                "Scan a room in \(.applicationName)",
            ],
            shortTitle: "Scan Room",
            systemImageName: "viewfinder"
        )
    }
}
