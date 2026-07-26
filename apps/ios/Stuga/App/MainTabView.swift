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

    var body: some View {
        TabView(selection: $selection) {
            HomeDashboardView { selection = .alerts }
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
        .background(StugaTheme.canvas)
    }
}
