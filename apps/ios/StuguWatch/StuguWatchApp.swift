import Foundation
import SwiftUI
@preconcurrency import WatchConnectivity

@main
struct StuguWatchApp: App {
    @StateObject private var model = StuguWatchModel()

    var body: some Scene {
        WindowGroup {
            StuguWatchHomeView()
                .environmentObject(model)
        }
    }
}

private struct StuguWatchHomeView: View {
    @EnvironmentObject private var model: StuguWatchModel

    var body: some View {
        NavigationStack {
            Group {
                if let snapshot = model.snapshot, snapshot.available {
                    snapshotView(snapshot)
                } else {
                    ContentUnavailableView {
                        Label("Open Stugu", systemImage: "iphone")
                    } description: {
                        Text("Open Stugu on the paired iPhone to send a Home summary.")
                    } actions: {
                        Button("Refresh") {
                            model.requestRefresh()
                        }
                    }
                }
            }
            .navigationTitle("Stugu")
        }
    }

    private func snapshotView(_ snapshot: WatchHomeSnapshot) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Label(snapshot.homeName, systemImage: stateSymbol(snapshot.state))
                    .font(.headline)
                    .foregroundStyle(stateColor(snapshot.state))
                if snapshot.homeOrigin == "remote" {
                    Label("Remote Stuguby Home", systemImage: "person.2.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.blue)
                }
                Text(snapshot.title)
                    .font(.body.weight(.semibold))
                Text(snapshot.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if model.snapshotIsStale {
                    Label("Status may be out of date", systemImage: "clock.badge.exclamationmark")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                } else if snapshot.cached {
                    Label("Saved on iPhone", systemImage: "clock.arrow.circlepath")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if snapshot.alerts.isEmpty {
                    Label("No unseen alerts", systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.green)
                        .padding(.top, 4)
                } else {
                    Divider()
                    Text("Needs attention")
                        .font(.footnote.weight(.semibold))
                    ForEach(snapshot.alerts) { alert in
                        VStack(alignment: .leading, spacing: 7) {
                            Label(
                                alert.title,
                                systemImage: severitySymbol(alert.severity)
                            )
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(severityColor(alert.severity))

                            if !snapshot.readOnly, snapshot.actionContext != nil {
                                Button {
                                    model.markSeen(alert)
                                } label: {
                                    if model.pendingAlertIDs.contains(alert.id) {
                                        Label("Sending…", systemImage: "clock")
                                    } else {
                                        Label("Mark seen", systemImage: "checkmark")
                                    }
                                }
                                .buttonStyle(.bordered)
                                .disabled(model.pendingAlertIDs.contains(alert.id))
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                if let updated = model.updatedDate {
                    Text("Updated \(updated, style: .relative)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Button {
                    model.requestRefresh()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
            .privacySensitive()
            .padding(.horizontal, 2)
        }
        .refreshable {
            model.requestRefresh()
        }
    }

    private func stateSymbol(_ state: String) -> String {
        switch state {
        case "critical": "exclamationmark.octagon.fill"
        case "attention": "exclamationmark.triangle.fill"
        case "limited": "circle.dashed"
        case "balanced": "checkmark.circle.fill"
        default: "circle.dashed"
        }
    }

    private func stateColor(_ state: String) -> Color {
        switch state {
        case "critical": .red
        case "attention": .orange
        case "limited": .secondary
        case "balanced": .green
        default: .secondary
        }
    }

    private func severitySymbol(_ severity: String) -> String {
        severity == "critical"
            ? "exclamationmark.octagon.fill"
            : "exclamationmark.triangle.fill"
    }

    private func severityColor(_ severity: String) -> Color {
        severity == "critical" ? .red : .orange
    }
}

@MainActor
private final class StuguWatchModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var snapshot: WatchHomeSnapshot?
    @Published private(set) var pendingAlertIDs: Set<String> = []

    private let snapshotStore = WatchSnapshotStore()
    private let actionStore = WatchActionOutbox()
    private var session: WCSession?

    var updatedDate: Date? {
        guard let value = snapshot?.updatedAt else { return nil }
        return ISO8601DateFormatter().date(from: value)
    }

    var snapshotIsStale: Bool {
        guard let updatedDate else { return true }
        let age = Date().timeIntervalSince(updatedDate)
        return age < -300 || age > 30 * 60
    }

    override init() {
        snapshot = snapshotStore.load()
        pendingAlertIDs = Set(actionStore.load().map(\.alertId))
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
    }

    func requestRefresh() {
        guard let session, session.activationState == .activated else {
            session?.activate()
            return
        }
        guard session.isReachable else { return }
        session.sendMessage(
            [
                WatchCompanionPayload.requestKey:
                    WatchCompanionPayload.snapshotRequest,
            ],
            replyHandler: { [weak self] payload in
                Task { @MainActor in self?.receive(payload) }
            },
            errorHandler: nil
        )
    }

    func markSeen(_ alert: WatchAlertSummary) {
        guard snapshot?.readOnly == false,
              let context = snapshot?.actionContext,
              !pendingAlertIDs.contains(alert.id) else {
            return
        }
        let action = WatchCompanionAction(
            alertId: alert.id,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            context: context
        )
        guard actionStore.enqueue(action) else { return }
        pendingAlertIDs.insert(alert.id)
        flushActions()
    }

    private func receive(_ payload: [String: Any]) {
        if let receiptID = payload[
            WatchCompanionPayload.actionReceiptIDKey
        ] as? String,
           receiptID.count <= 200 {
            _ = actionStore.remove(id: receiptID)
        }
        guard let data = payload[WatchCompanionPayload.snapshotDataKey] as? Data,
              let snapshot = try? JSONDecoder().decode(
                WatchHomeSnapshot.self,
                from: data
              ),
              snapshot.schemaVersion == WatchHomeSnapshot.currentSchemaVersion else {
            return
        }
        self.snapshot = snapshot
        snapshotStore.save(snapshot)
        let visible = Set(snapshot.alerts.map(\.id))
        pendingAlertIDs.formIntersection(visible)
    }

    private func flushActions() {
        guard let session,
              session.activationState == .activated,
              session.isCompanionAppInstalled else {
            return
        }
        for action in actionStore.load() {
            guard let data = try? JSONEncoder().encode(action) else { continue }
            session.transferUserInfo([
                WatchCompanionPayload.actionDataKey: data,
            ])
        }
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated, error == nil else { return }
        Task { @MainActor [weak self] in
            self?.receive(session.receivedApplicationContext)
            self?.flushActions()
            self?.requestRefresh()
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        Task { @MainActor [weak self] in
            self?.receive(applicationContext)
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveUserInfo userInfo: [String: Any]
    ) {
        Task { @MainActor [weak self] in
            self?.receive(userInfo)
        }
    }
}

private struct WatchSnapshotStore {
    private let fileURL = WatchStorageURL.file("watch-snapshot-v1.json")

    func load() -> WatchHomeSnapshot? {
        guard let data = try? Data(contentsOf: fileURL),
              let snapshot = try? JSONDecoder().decode(
                WatchHomeSnapshot.self,
                from: data
              ),
              snapshot.schemaVersion == WatchHomeSnapshot.currentSchemaVersion else {
            return nil
        }
        return snapshot
    }

    func save(_ snapshot: WatchHomeSnapshot) {
        _ = WatchStorageURL.write(snapshot, to: fileURL)
    }
}

private struct WatchActionOutbox {
    private let fileURL = WatchStorageURL.file("watch-actions-v1.json")

    func load(now: Date = Date()) -> [WatchCompanionAction] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        let actions = (try? JSONDecoder().decode(
            [WatchCompanionAction].self,
            from: data
        )) ?? []
        let retained = actions.filter { $0.isWithinDeliveryWindow(at: now) }
        if retained.count != actions.count {
            _ = WatchStorageURL.write(retained, to: fileURL)
        }
        return retained
    }

    func enqueue(_ action: WatchCompanionAction) -> Bool {
        var values = load()
        guard !values.contains(where: { $0.id == action.id }) else { return true }
        values.append(action)
        return WatchStorageURL.write(Array(values.suffix(50)), to: fileURL)
    }

    func remove(id: String) -> Bool {
        WatchStorageURL.write(
            load().filter { $0.id != id },
            to: fileURL
        )
    }
}

private enum WatchStorageURL {
    static func file(_ name: String) -> URL {
        let manager = FileManager.default
        let base = manager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? manager.temporaryDirectory
        return base
            .appendingPathComponent("Stugu", isDirectory: true)
            .appendingPathComponent(name)
    }

    static func write<Value: Encodable>(_ value: Value, to url: URL) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            return false
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedURL = url
        try? protectedURL.setResourceValues(values)
        return true
    }
}
