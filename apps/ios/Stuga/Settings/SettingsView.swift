import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmDisconnect = false

    var body: some View {
        NavigationStack {
            ZStack {
                StugaScreenBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        connectionSection
                        accountSection
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
            .confirmationDialog(
                "Disconnect this Stuga?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task { await model.disconnect() }
                }
            } message: {
                Text("The saved server address and its session cookies will be removed from this device.")
            }
        }
    }

    private var connectionSection: some View {
        section(title: "Connection") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    StugaMark()
                        .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.serverDisplayName)
                            .font(.headline)
                        if let version = model.serverVersion {
                            Text("Stuga \(version)")
                                .font(.caption)
                                .foregroundStyle(StugaTheme.muted)
                        }
                    }
                    Spacer()
                    StatusPill(
                        label: model.liveConnected ? "Live" : "Reconnecting",
                        systemImage: model.liveConnected ? "circle.fill" : "arrow.triangle.2.circlepath",
                        color: model.liveConnected ? StugaTheme.success : StugaTheme.warning
                    )
                }
                if let updated = model.lastUpdated {
                    Text("Last refreshed \(updated.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)
                }
                if !model.isEncryptedConnection {
                    Label("Local HTTP · not encrypted", systemImage: "exclamationmark.shield")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StugaTheme.warning)
                }
                if let url = model.serverAddress?.webURL() {
                    Link(destination: url) {
                        Label("Open Stuga web app", systemImage: "safari")
                    }
                    .font(.subheadline.weight(.semibold))
                }
                Divider().overlay(StugaTheme.line)
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
                if model.isReadOnly {
                    Label("Guest accounts remain read-only in the companion app.", systemImage: "eye")
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)
                }
            }
        }
    }

    private var privacySection: some View {
        section(title: "Privacy") {
            VStack(alignment: .leading, spacing: 10) {
                Label("Direct connection", systemImage: "lock.shield")
                    .font(.headline)
                Text("The app talks directly to your selected Stuga server. It does not copy telemetry to an intermediary service.")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
                Text("Your password is not stored. The server session is kept in the iOS cookie store until you sign out, disconnect, or the session expires.")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
                if model.equipmentObservationEnabled {
                    Text("Equipment observation sends BLE detections and, when available, an accuracy-qualified phone location directly to your Stuga. The observer credential is stored in Keychain and unsent detections are protected on this device.")
                        .font(.subheadline)
                        .foregroundStyle(StugaTheme.muted)
                }
            }
        }
    }

    private var displaySection: some View {
        section(title: "Display") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Temperature units")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
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
                settingsRow("App", "Stuga companion")
                settingsRow("Version", appVersion)
                Text("This companion helps you monitor a Home. Use the web app for setup, floor plans, analytics, maintenance, and administration.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            StugaCard {
                content()
            }
        }
    }

    private func settingsRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(StugaTheme.muted)
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
            StugaCard {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(
                        "Let this iPhone observe Stuga tags",
                        isOn: Binding(
                            get: { model.equipmentObservationEnabled },
                            set: { enabled in
                                Task { await model.setEquipmentObservationEnabled(enabled) }
                            }
                        )
                    )
                    .disabled(!model.mobileTrackingAvailable)

                    Text("Participation is optional. iOS background scanning is opportunistic and does not guarantee immediate or continuous detection.")
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)

                    if model.equipmentObservationEnabled {
                        Divider().overlay(StugaTheme.line)
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
                            .foregroundStyle(StugaTheme.warning)
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
                            Text("Always Location lets iOS notify Stuga when this iPhone enters or leaves the configured Property region. GPS is not kept running continuously.")
                                .font(.caption)
                                .foregroundStyle(StugaTheme.muted)
                        }
                    }

                    if tracker.hasObserverRegistration {
                        Divider().overlay(StugaTheme.line)
                        Button("Remove this iPhone observer", role: .destructive) {
                            confirmObserverRemoval = true
                        }
                    }
                }
            }
            .confirmationDialog(
                "Remove this iPhone observer?",
                isPresented: $confirmObserverRemoval,
                titleVisibility: .visible
            ) {
                Button("Remove observer", role: .destructive) {
                    Task { await model.removeMobileTrackingObserver() }
                }
            } message: {
                Text("Stuga will revoke its upload credential and remove it from this iPhone.")
            }
        }
    }

    private func settingsRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(StugaTheme.muted)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}
