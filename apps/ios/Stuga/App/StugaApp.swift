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
                    consumeAppIntentRoute()
                }
                .onOpenURL { model.handleDeepLink($0) }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: StugaAppIntentRouteStore.didRequestRoute
                    )
                ) { _ in
                    consumeAppIntentRoute()
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        consumeAppIntentRoute()
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

    private func consumeAppIntentRoute() {
        guard let url = StugaAppIntentRouteStore.consume() else { return }
        model.handleDeepLink(url)
    }
}
