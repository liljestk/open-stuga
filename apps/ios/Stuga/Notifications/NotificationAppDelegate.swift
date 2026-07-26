@preconcurrency import UIKit
@preconcurrency import UserNotifications

@MainActor
final class NotificationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let alertCategory = "STUGA_ALERT"
    static let readOnlyAlertCategory = "STUGA_ALERT_READ_ONLY"
    static let markSeenAction = "STUGA_MARK_SEEN"
    static let remindLaterAction = "STUGA_REMIND_LATER"
    static let alertIDKey = "stugaAlertId"
    static let deepLinkKey = "stugaDeepLink"

    static func reminderIdentifier(for alertID: String) -> String {
        "stuga-reminder-\(alertID)"
    }

    private weak var model: AppModel?
    private var pendingDeepLink: URL?
    private var pendingAcknowledgementID: String?

    func configure(model: AppModel) {
        self.model = model
        PhoneWatchConnectivityBridge.shared.configure(model: model)
        if let pendingDeepLink {
            model.handleDeepLink(pendingDeepLink)
            self.pendingDeepLink = nil
        }
    }

    func modelDidStart() async {
        await PhoneWatchConnectivityBridge.shared.modelDidStart()
        guard let alertID = pendingAcknowledgementID else { return }
        pendingAcknowledgementID = nil
        if model?.phase == .ready {
            await model?.acknowledgeAlert(id: alertID)
        } else if let url = URL(string: "stuga://alerts?id=\(alertID)") {
            route(url)
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let markSeen = UNNotificationAction(
            identifier: Self.markSeenAction,
            title: "Mark as seen",
            options: [.authenticationRequired]
        )
        let remindLater = UNNotificationAction(
            identifier: Self.remindLaterAction,
            title: "Remind in 1 hour"
        )
        let category = UNNotificationCategory(
            identifier: Self.alertCategory,
            actions: [markSeen, remindLater],
            intentIdentifiers: []
        )
        let readOnlyCategory = UNNotificationCategory(
            identifier: Self.readOnlyAlertCategory,
            actions: [remindLater],
            intentIdentifiers: []
        )
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories([category, readOnlyCategory])
        center.delegate = self
        PhoneWatchConnectivityBridge.shared.activate()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await model?.receiveNotificationDeviceToken(token) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        model?.errorMessage = "This iPhone could not register for remote notifications."
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        let alertID = validatedAlertID(info[Self.alertIDKey])

        switch response.actionIdentifier {
        case Self.markSeenAction:
            if let alertID {
                if model?.phase == .ready {
                    await model?.acknowledgeAlert(id: alertID)
                } else {
                    pendingAcknowledgementID = alertID
                }
            }
        case Self.remindLaterAction:
            await scheduleReminder(from: response.notification, center: center)
        default:
            if let rawURL = info[Self.deepLinkKey] as? String,
               let url = URL(string: rawURL) {
                route(url)
            } else if let alertID,
                      let url = URL(string: "stuga://alerts?id=\(alertID)") {
                route(url)
            } else if let url = URL(string: "stuga://alerts") {
                route(url)
            }
        }
    }

    private func validatedAlertID(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        var components = URLComponents()
        components.scheme = "stuga"
        components.host = "alerts"
        components.queryItems = [URLQueryItem(name: "id", value: value)]
        guard let url = components.url,
              let link = CompanionDeepLink.parse(url),
              case let .alerts(alertID) = link else {
            return nil
        }
        return alertID
    }

    private func route(_ url: URL) {
        if let model {
            model.handleDeepLink(url)
        } else {
            pendingDeepLink = url
        }
    }

    private func scheduleReminder(
        from notification: UNNotification,
        center: UNUserNotificationCenter
    ) async {
        let original = notification.request.content
        let content = UNMutableNotificationContent()
        content.title = original.title
        content.subtitle = original.subtitle
        content.body = original.body
        content.sound = .default
        content.categoryIdentifier = original.categoryIdentifier
        content.userInfo = original.userInfo
        let alertID = validatedAlertID(original.userInfo[Self.alertIDKey])
        let reminderIdentifier = alertID.map {
            Self.reminderIdentifier(for: $0)
        } ?? "stuga-reminder-\(UUID().uuidString.lowercased())"
        let request = UNNotificationRequest(
            identifier: reminderIdentifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(
                timeInterval: 3_600,
                repeats: false
            )
        )
        try? await center.add(request)
    }
}
