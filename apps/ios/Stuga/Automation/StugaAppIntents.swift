import AppIntents
import Foundation

struct CheckStugaIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Stuga"
    static let description = IntentDescription(
        "Reads the latest Home summary saved securely by the Stuga app."
    )
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = CompanionWidgetSnapshotStore().load() else {
            return .result(
                dialog: "Open Stuga once to save a Home summary on this iPhone."
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

struct CaptureStugaObservationIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Stuga Observation"
    static let description = IntentDescription(
        "Opens Stuga's quick field-capture form."
    )

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(
            opensIntent: OpenURLIntent(URL(string: "stuga://capture")!)
        )
    }
}

struct OpenStugaAlertsIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Stuga Alerts"

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(
            opensIntent: OpenURLIntent(URL(string: "stuga://alerts")!)
        )
    }
}

struct ScanStugaRoomIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan a Stuga Room"
    static let description = IntentDescription(
        "Opens Stuga's reviewable RoomPlan capture."
    )

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(
            opensIntent: OpenURLIntent(URL(string: "stuga://room-scan")!)
        )
    }
}

struct StugaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CheckStugaIntent(),
            phrases: [
                "How is \(.applicationName)",
                "Check my Home in \(.applicationName)",
            ],
            shortTitle: "Check Home",
            systemImageName: "house"
        )
        AppShortcut(
            intent: CaptureStugaObservationIntent(),
            phrases: [
                "Add an observation in \(.applicationName)",
                "Record something in \(.applicationName)",
            ],
            shortTitle: "Add Observation",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenStugaAlertsIntent(),
            phrases: [
                "Show alerts in \(.applicationName)",
            ],
            shortTitle: "Show Alerts",
            systemImageName: "bell"
        )
        AppShortcut(
            intent: ScanStugaRoomIntent(),
            phrases: [
                "Scan a room in \(.applicationName)",
            ],
            shortTitle: "Scan Room",
            systemImageName: "viewfinder"
        )
    }
}
