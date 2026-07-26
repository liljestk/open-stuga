import SwiftUI

@main
struct StugaApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(StugaTheme.action)
                .task { await model.start() }
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
