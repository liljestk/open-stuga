import SwiftUI

@main
struct StugaApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(StugaTheme.action)
                .task {
                    appDelegate.configure(model: model)
                    await model.start()
                    await appDelegate.modelDidStart()
                }
                .onOpenURL { model.handleDeepLink($0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await model.sceneBecameActive() }
                    case .inactive, .background:
                        model.sceneBecameInactive()
                    @unknown default:
                        break
                    }
                }
        }
    }
}
