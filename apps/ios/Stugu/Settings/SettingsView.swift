import SwiftUI
import UIKit

private var companionDeviceName: String {
    #if targetEnvironment(macCatalyst)
    "Mac"
    #else
    "iPhone"
    #endif
}

private var companionPlatformName: String {
    #if targetEnvironment(macCatalyst)
    "macOS"
    #else
    "iOS"
    #endif
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let showsDismissButton: Bool
    @State private var confirmDisconnect = false

    init(showsDismissButton: Bool = false) {
        self.showsDismissButton = showsDismissButton
    }

    var body: some View {
        NavigationStack {
            ZStack {
                StuguScreenBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        connectionSection
                        accountSection
                        if model.canManageSystemUpdates {
                            systemUpdatesSection
                        }
                        notificationsSection
                        if model.trackingAvailable {
                            EquipmentObservationSettings(tracker: model.mobileTracking)
                        }
                        displaySection
                        privacySection
                        aboutSection
                        Button("Sign out") {
                            Task { await model.signOut() }
                        }
                        .buttonStyle(SecondaryButtonStyle())
                    }
                    .padding(16)
                    .frame(maxWidth: 680)
                    .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                if showsDismissButton {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .confirmationDialog(
                "Disconnect this Stugu?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task { await model.disconnect() }
                }
            } message: {
                Text("The saved server address and its session cookies will be removed from this device.")
            }
            .task(id: model.canManageSystemUpdates) {
                guard model.canManageSystemUpdates else { return }
                await model.monitorSystemUpdates()
            }
        }
    }

    private var connectionSection: some View {
        section(title: "Connection") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    StuguMark()
                        .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.serverDisplayName)
                            .font(.headline)
                        if let version = model.serverVersion {
                            Text("Stugu \(version)")
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }
                    Spacer()
                    StatusPill(
                        label: model.liveConnected ? "Live" : "Reconnecting",
                        systemImage: model.liveConnected ? "circle.fill" : "arrow.triangle.2.circlepath",
                        color: model.liveConnected ? StuguTheme.success : StuguTheme.warning
                    )
                }
                if let updated = model.lastUpdated {
                    Text("Last refreshed \(updated.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }
                if !model.isEncryptedConnection {
                    Label("Local HTTP · not encrypted", systemImage: "exclamationmark.shield")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StuguTheme.warning)
                }
                if let url = model.serverAddress?.webURL() {
                    Link(destination: url) {
                        Label("Open Stugu web app", systemImage: "safari")
                    }
                    .font(.subheadline.weight(.semibold))
                }
                Divider().overlay(StuguTheme.line)
                Button("Disconnect server", role: .destructive) {
                    confirmDisconnect = true
                }
                .font(.subheadline.weight(.semibold))
            }
        }
    }

    private var accountSection: some View {
        section(title: "Account") {
            VStack(alignment: .leading, spacing: 10) {
                settingsRow("Email", model.session?.principal.email ?? "—")
                settingsRow("Role", model.session?.tenant.role.capitalized ?? "—")
                settingsRow("Access", model.isReadOnly ? "Read-only" : "Can acknowledge alerts")
                if let home = model.selectedHome {
                    settingsRow(
                        "Selected Home",
                        "\(home.stuguby?.isForeignSharedHome == true ? "Remote" : "Own") · \(model.selectedHomeReadOnly ? "Read-only" : "Editable")"
                    )
                }
                if model.isReadOnly {
                    Label("Guest accounts remain read-only in the companion app.", systemImage: "eye")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }
            }
        }
    }

    private var systemUpdatesSection: some View {
        section(title: "System updates") {
            VStack(alignment: .leading, spacing: 12) {
                if let status = model.systemUpdateStatus {
                    settingsRow("Installed", "Stugu \(status.currentVersion)")
                    settingsRow(
                        "Latest",
                        status.latestVersion.map { "Stugu \($0)" } ?? "Not checked"
                    )

                    if let operation = status.operation {
                        Divider().overlay(StuguTheme.line)
                        VStack(alignment: .leading, spacing: 9) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(systemUpdatePhaseTitle(operation))
                                    .font(.headline)
                                Spacer()
                                StatusPill(
                                    label: operation.isActive ? "In progress" : phaseLabel(operation.phase),
                                    systemImage: phaseSymbol(operation.phase),
                                    color: phaseColor(operation.phase)
                                )
                            }
                            if let detail = operation.detail {
                                Text(detail)
                                    .font(.subheadline)
                                    .foregroundStyle(StuguTheme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            ProgressView(
                                value: Double(operation.completedProgressSteps),
                                total: 5
                            )
                            .tint(phaseColor(operation.phase))
                            Text(updateProgressLabel(operation))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(StuguTheme.muted)

                            if !operation.activity.isEmpty {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text("Recent activity")
                                        .font(.subheadline.weight(.semibold))
                                    ForEach(
                                        Array(operation.activity.suffix(5).enumerated()),
                                        id: \.offset
                                    ) { _, activity in
                                        HStack(alignment: .top, spacing: 10) {
                                            Text(activityDate(activity.at))
                                                .font(.caption.monospacedDigit())
                                                .foregroundStyle(StuguTheme.muted)
                                                .frame(width: 68, alignment: .leading)
                                            Text(activity.detail)
                                                .font(.caption)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            }
                        }
                        .accessibilityLabel("System update progress")
                        .accessibilityValue(updateProgressLabel(operation))
                        .onChange(of: operation.phase) { _, _ in
                            guard UIAccessibility.isVoiceOverRunning else { return }
                            UIAccessibility.post(
                                notification: .announcement,
                                argument: updateProgressLabel(operation)
                            )
                        }
                    } else if status.updateAvailable {
                        Label(
                            "A newer Stugu release is ready to review.",
                            systemImage: "arrow.down.circle.fill"
                        )
                        .foregroundStyle(StuguTheme.action)
                    } else {
                        Label("Stugu is up to date.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(StuguTheme.success)
                    }
                } else if model.systemUpdateError == nil {
                    ProgressView("Checking update status…")
                }

                if let error = model.systemUpdateError {
                    Label(error, systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.warning)
                }

                if let url = model.serverAddress?.origin.appending(path: "system/updates") {
                    Link(destination: url) {
                        Label("Review and manage updates", systemImage: "safari")
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private func systemUpdatePhaseTitle(_ operation: SystemUpdateOperation) -> String {
        switch operation.phase {
        case "queued": "Stugu \(operation.version) is queued"
        case "preparing": "Preparing Stugu \(operation.version)"
        case "backup": "Backing up before \(operation.version)"
        case "pulling": "Downloading Stugu \(operation.version)"
        case "applying": "Starting Stugu \(operation.version)"
        case "verifying": "Checking Stugu \(operation.version)"
        case "complete": "Stugu \(operation.version) is installed"
        case "failed": "Update to \(operation.version) failed"
        case "rolling-back": "Restoring \(operation.previousVersion)"
        default: "System update"
        }
    }

    private func phaseLabel(_ phase: String) -> String {
        switch phase {
        case "complete": "Complete"
        case "failed": "Failed"
        case "rolling-back": "Rolling back"
        default: phase.capitalized
        }
    }

    private func phaseSymbol(_ phase: String) -> String {
        switch phase {
        case "complete": "checkmark.circle.fill"
        case "failed": "exclamationmark.octagon.fill"
        case "rolling-back": "arrow.uturn.backward.circle.fill"
        default: "arrow.triangle.2.circlepath"
        }
    }

    private func phaseColor(_ phase: String) -> Color {
        switch phase {
        case "complete": StuguTheme.success
        case "failed": StuguTheme.critical
        case "rolling-back": StuguTheme.warning
        default: StuguTheme.action
        }
    }

    private func updateProgressLabel(_ operation: SystemUpdateOperation) -> String {
        switch operation.phase {
        case "queued": "Waiting for the update agent"
        case "complete": "All 5 steps complete"
        case "failed": "Stopped during the update"
        case "rolling-back": "Safety rollback in progress"
        default: "Step \(min(operation.completedProgressSteps + 1, 5)) of 5"
        }
    }

    private func activityDate(_ value: String) -> String {
        StuguDateParser.date(from: value)?.formatted(
            date: .omitted,
            time: .standard
        ) ?? "—"
    }

    private var notificationsSection: some View {
        section(title: "Notifications") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle(
                    "Notify this \(companionDeviceName)",
                    isOn: Binding(
                        get: { model.notificationsEnabled },
                        set: { enabled in
                            Task { await model.setNotificationsEnabled(enabled) }
                        }
                    )
                )

                if model.notificationsEnabled {
                    Picker(
                        "Minimum importance",
                        selection: Binding(
                            get: { model.notificationMinimumSeverity },
                            set: { model.notificationMinimumSeverity = $0 }
                        )
                    ) {
                        Text("Information").tag(IOSPushMinimumSeverity.info)
                        Text("Warning").tag(IOSPushMinimumSeverity.warning)
                        Text("Critical").tag(IOSPushMinimumSeverity.critical)
                    }

                    Toggle(
                        "Show Home and sensor names",
                        isOn: Binding(
                            get: { model.notificationIncludeDetails },
                            set: { model.notificationIncludeDetails = $0 }
                        )
                    )

                    if model.notificationAuthorization == .denied {
                        Button("Open \(companionPlatformName) notification settings") {
                            guard let url = URL(
                                string: UIApplication.openNotificationSettingsURLString
                            ) else { return }
                            UIApplication.shared.open(url)
                        }
                    } else if model.notificationAuthorization == .notDetermined {
                        Button("Allow notifications") {
                            Task { await model.requestNotificationPermission() }
                        }
                    } else if !model.notificationProviderConfigured {
                        Label(
                            "Your Stugu server has not configured Apple Push Notification service yet.",
                            systemImage: "server.rack"
                        )
                        .font(.caption)
                        .foregroundStyle(StuguTheme.warning)
                    }
                }

                Text(
                    "This \(companionDeviceName) receives alerts for every Home currently visible to this account. Notifications are sent directly by your Stugu server. Delivery can be delayed or suppressed by \(companionPlatformName); do not rely on Stugu for life-safety monitoring."
                )
                .font(.caption)
                .foregroundStyle(StuguTheme.muted)

                if model.pendingActionCount > 0 {
                    Label(
                        "\(model.pendingActionCount) protected offline change\(model.pendingActionCount == 1 ? "" : "s") waiting to sync",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StuguTheme.warning)
                }
            }
        }
    }

    private var privacySection: some View {
        section(title: "Privacy") {
            VStack(alignment: .leading, spacing: 10) {
                Label("Direct connection", systemImage: "lock.shield")
                    .font(.headline)
                Text("The app talks directly to your selected Stugu server. It does not copy telemetry to an intermediary service.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                Text("Your password is not stored. The server session is kept in the system cookie store until you sign out, disconnect, or the session expires.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                Text("A bounded, encrypted-on-device snapshot and pending field changes remain available offline. They are excluded from device backups and removed when you sign out or disconnect.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                if model.equipmentObservationEnabled {
                    Text("Equipment observation sends BLE detections and, when available, an accuracy-qualified phone location directly to your Stugu. The observer credential is stored in Keychain and unsent detections are protected on this device.")
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                }
            }
        }
    }

    private var displaySection: some View {
        section(title: "Display") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Temperature units")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                Picker("Temperature units", selection: $model.unitSystem) {
                    Text("Metric (°C)").tag(DisplayUnitSystem.metric)
                    Text("Imperial (°F)").tag(DisplayUnitSystem.imperial)
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private var aboutSection: some View {
        section(title: "About") {
            VStack(alignment: .leading, spacing: 10) {
                settingsRow("App", "Stugu companion")
                settingsRow("Version", appVersion)
                Text("This companion helps you monitor a Home. Use the web app for setup, floor plans, analytics, maintenance, and administration.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            }
        }
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            StuguCard {
                content()
            }
        }
    }

    private func settingsRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(StuguTheme.muted)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }
}

private struct EquipmentObservationSettings: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var tracker: MobileTrackingController
    @State private var confirmObserverRemoval = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Equipment observation")
                .font(.headline)
            StuguCard {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(
                        "Let this \(companionDeviceName) observe Stugu tags",
                        isOn: Binding(
                            get: { model.equipmentObservationEnabled },
                            set: { enabled in
                                Task { await model.setEquipmentObservationEnabled(enabled) }
                            }
                        )
                    )
                    .disabled(!model.mobileTrackingAvailable)

                    Text("Participation is optional. Background Bluetooth scanning is opportunistic and does not guarantee immediate or continuous detection.")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)

                    if model.equipmentObservationEnabled {
                        Divider().overlay(StuguTheme.line)
                        settingsRow("Mode", tracker.mode.displayName)
                        settingsRow("Bluetooth", tracker.bluetoothStatus)
                        settingsRow("Location", tracker.locationStatus)
                        settingsRow("Saved detections", "\(tracker.queueStatus.queuedCount)")

                        if tracker.queueStatus.droppedCount > 0 {
                            Label(
                                "\(tracker.queueStatus.droppedCount) old detections were removed after local storage reached its limit.",
                                systemImage: "exclamationmark.triangle"
                            )
                            .font(.caption)
                            .foregroundStyle(StuguTheme.warning)
                        }

                        Button {
                            tracker.beginActivePropertyMode()
                        } label: {
                            Label("Active tracking for 60 minutes", systemImage: "bolt")
                        }
                        .buttonStyle(SecondaryButtonStyle())

                        if tracker.supportsPropertyAutomation {
                            Button {
                                tracker.requestPropertyAutomation()
                            } label: {
                                Label("Allow Property automation", systemImage: "location")
                            }
                            .buttonStyle(SecondaryButtonStyle())
                            Text("Always Location lets iOS notify Stugu when this iPhone enters or leaves the configured Property region. GPS is not kept running continuously.")
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }

                    if tracker.hasObserverRegistration {
                        Divider().overlay(StuguTheme.line)
                        Button("Remove this \(companionDeviceName) observer", role: .destructive) {
                            confirmObserverRemoval = true
                        }
                    }
                }
            }
            .confirmationDialog(
                "Remove this \(companionDeviceName) observer?",
                isPresented: $confirmObserverRemoval,
                titleVisibility: .visible
            ) {
                Button("Remove observer", role: .destructive) {
                    Task { await model.removeMobileTrackingObserver() }
                }
            } message: {
                Text("Stugu will revoke its upload credential and remove it from this \(companionDeviceName).")
            }
        }
    }

    private func settingsRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(StuguTheme.muted)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}
