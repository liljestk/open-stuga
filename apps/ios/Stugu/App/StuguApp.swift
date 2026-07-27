import SwiftUI

@main
struct StuguApp: App {
    @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(StuguTheme.action)
                .stuguWindowSizing()
                .task {
                    appDelegate.configure(model: model)
                    await model.start()
                    await appDelegate.modelDidStart()
                    consumeAppIntentRoute()
                }
                .onOpenURL { model.handleDeepLink($0) }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: StuguAppIntentRouteStore.didRequestRoute
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

    private func consumeAppIntentRoute() {
        guard let url = StuguAppIntentRouteStore.consume() else { return }
        model.handleDeepLink(url)
    }
}

private extension View {
    @ViewBuilder
    func stuguWindowSizing() -> some View {
        #if targetEnvironment(macCatalyst)
        self.frame(minWidth: 960, minHeight: 680)
        #else
        self
        #endif
    }
}
