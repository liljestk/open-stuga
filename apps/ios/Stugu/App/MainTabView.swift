import SwiftUI

struct MainTabView: View {
    enum Tab: Hashable {
        case home
        case sensors
        case equipment
        case alerts
        case settings
    }

    @EnvironmentObject private var model: AppModel
    @State private var selection: Tab = .home
    @State private var showingCapture = false
    @State private var showingRoomScan = false

    var body: some View {
        TabView(selection: $selection) {
            HomeDashboardView(
                openAlerts: { selection = .alerts },
                openCapture: { showingCapture = true },
                openRoomScan: { showingRoomScan = true }
            )
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)

            SensorsView()
                .tabItem { Label("Sensors", systemImage: "sensor") }
                .tag(Tab.sensors)

            EquipmentMapView(tracker: model.mobileTracking)
                .tabItem { Label("Inventory", systemImage: "shippingbox") }
                .tag(Tab.equipment)

            AlertsView()
                .tabItem { Label("Alerts", systemImage: "bell") }
                .badge(model.activeAlerts.count)
                .tag(Tab.alerts)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .background(StuguTheme.canvas)
        .sheet(isPresented: $showingCapture) {
            QuickCaptureView()
                .environmentObject(model)
        }
        .fullScreenCover(isPresented: $showingRoomScan) {
            RoomPlanImportView()
                .environmentObject(model)
        }
        .onChange(of: model.pendingDeepLink, initial: true) { _, link in
            guard let link else { return }
            switch link {
            case .home:
                selection = .home
            case .alerts:
                selection = .alerts
            case .inventory:
                selection = .equipment
            case .capture:
                showingCapture = true
            case .roomScan:
                showingRoomScan = true
            case let .equipment(code):
                selection = .equipment
                Task {
                    if let equipment = await model.resolveEquipmentCode(code) {
                        model.requestedEquipmentID = equipment.id
                    }
                }
            }
            model.pendingDeepLink = nil
        }
    }
}
