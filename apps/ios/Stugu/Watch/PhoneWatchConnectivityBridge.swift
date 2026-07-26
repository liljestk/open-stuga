import Foundation

#if targetEnvironment(macCatalyst)
@MainActor
final class PhoneWatchConnectivityBridge {
    static let shared = PhoneWatchConnectivityBridge()

    private init() {}

    func activate() {}

    func configure(model: AppModel) {}

    func modelDidStart() async {}

    func publish(_ snapshot: WatchHomeSnapshot) {}
}
#else
@preconcurrency import WatchConnectivity

final class PhoneWatchConnectivityBridge: NSObject, WCSessionDelegate {
    static let shared = PhoneWatchConnectivityBridge()

    private weak var model: AppModel?
    private let inbox = PhoneWatchActionInbox()
    private let snapshotLock = NSLock()
    private var latestSnapshotData: Data?
    private var session: WCSession?

    private override init() {
        super.init()
    }

    @MainActor
    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
    }

    @MainActor
    func configure(model: AppModel) {
        self.model = model
        Task { await processInboxWhenReady() }
    }

    @MainActor
    func modelDidStart() async {
        await processInboxWhenReady()
    }

    @MainActor
    func publish(_ snapshot: WatchHomeSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        snapshotLock.withLock {
            latestSnapshotData = data
        }
        deliverLatestSnapshot()
    }

    @MainActor
    private func deliverLatestSnapshot() {
        guard let session,
              session.activationState == .activated,
              session.isPaired,
              session.isWatchAppInstalled,
              let data = snapshotLock.withLock({ latestSnapshotData }) else {
            return
        }
        try? session.updateApplicationContext([
            WatchCompanionPayload.snapshotDataKey: data,
        ])
    }

    private func receive(_ payload: [String: Any]) {
        guard let data = payload[WatchCompanionPayload.actionDataKey] as? Data,
              let action = try? JSONDecoder().decode(
                WatchCompanionAction.self,
                from: data
              ),
              valid(action) else {
            return
        }
        Task { [weak self] in
            guard let self else { return }
            await inbox.enqueue(action)
            await processInboxWhenReady()
        }
    }

    private func valid(_ action: WatchCompanionAction) -> Bool {
        guard action.kind == .acknowledgeAlert,
              !action.id.isEmpty,
              action.id.count <= 200,
              action.id.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.contains($0)
                      || "-._:".unicodeScalars.contains($0)
              }),
              action.alertId.count <= 200,
              !action.alertId.isEmpty,
              action.alertId.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.contains($0)
                      || "-._:".unicodeScalars.contains($0)
              }),
              let createdAt = ISO8601DateFormatter().date(from: action.createdAt) else {
            return false
        }
        let age = Date().timeIntervalSince(createdAt)
        return age >= -300 && age <= 7 * 24 * 60 * 60
    }

    @MainActor
    private func processInboxWhenReady() async {
        guard let model, model.phase == .ready else { return }
        for action in await inbox.actions() {
            switch action.kind {
            case .acknowledgeAlert:
                await model.acknowledgeAlert(id: action.alertId)
            }
            await inbox.remove(id: action.id)
        }
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated, error == nil else { return }
        Task { @MainActor [weak self] in
            self?.deliverLatestSnapshot()
            await self?.processInboxWhenReady()
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        receive(applicationContext)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        receive(userInfo)
    }

    func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard message[WatchCompanionPayload.requestKey] as? String
                == WatchCompanionPayload.snapshotRequest,
              let data = snapshotLock.withLock({ latestSnapshotData }) else {
            replyHandler([:])
            return
        }
        replyHandler([WatchCompanionPayload.snapshotDataKey: data])
    }
}

private actor PhoneWatchActionInbox {
    private let fileURL: URL
    private var cached: [WatchCompanionAction]?

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.temporaryDirectory
        fileURL = base
            .appendingPathComponent("Stugu", isDirectory: true)
            .appendingPathComponent("watch-action-inbox-v1.json")
    }

    func enqueue(_ action: WatchCompanionAction) {
        var current = load()
        guard !current.contains(where: { $0.id == action.id }) else { return }
        current.append(action)
        save(Array(current.suffix(100)))
    }

    func actions() -> [WatchCompanionAction] {
        load()
    }

    func remove(id: String) {
        var current = load()
        current.removeAll { $0.id == id }
        save(current)
    }

    private func load() -> [WatchCompanionAction] {
        if let cached { return cached }
        let value = (try? Data(contentsOf: fileURL))
            .flatMap { try? JSONDecoder().decode([WatchCompanionAction].self, from: $0) }
            ?? []
        cached = value
        return value
    }

    private func save(_ actions: [WatchCompanionAction]) {
        cached = actions
        let directory = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        guard let data = try? JSONEncoder().encode(actions) else { return }
        try? data.write(
            to: fileURL,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedURL = fileURL
        try? protectedURL.setResourceValues(values)
    }
}
#endif
