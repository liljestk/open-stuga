import SwiftUI

struct PinnedOverviewSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Pinned overview") {
                    Picker("Overview scope", selection: scopeBinding) {
                        Label("Home", systemImage: "house")
                            .tag(GlanceOverviewScope.home)
                        Label("Property", systemImage: "building.2")
                            .tag(GlanceOverviewScope.property)
                    }
                    .pickerStyle(.segmented)

                    if model.pinnedOverviewScope == .home {
                        Picker("Home", selection: targetBinding) {
                            ForEach(model.houses) { home in
                                Text(home.name).tag(home.id)
                            }
                        }
                    } else {
                        Picker("Property", selection: targetBinding) {
                            ForEach(model.properties) { property in
                                Text(property.name).tag(property.id)
                            }
                        }
                    }
                } footer: {
                    Text("This overview opens first, so the most important status is ready at a glance.")
                }

                Section("Quick stats") {
                    metricToggle("Temperature", metric: .temperature)
                    metricToggle("Humidity", metric: .humidity)
                    metricToggle("Electricity now", metric: .power)
                    metricToggle("Carbon dioxide", metric: .co2)
                } footer: {
                    Text("Keep at least one quick stat visible.")
                }
            }
            .navigationTitle("Overview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var scopeBinding: Binding<GlanceOverviewScope> {
        Binding(
            get: { model.pinnedOverviewScope },
            set: { scope in
                let targetID = scope == .home
                    ? model.houses.first?.id
                    : model.properties.first?.id
                guard let targetID else { return }
                Task { await model.pinOverview(scope: scope, targetID: targetID) }
            }
        )
    }

    private var targetBinding: Binding<String> {
        Binding(
            get: {
                model.pinnedOverviewTargetID
                    ?? (model.pinnedOverviewScope == .home
                        ? model.houses.first?.id
                        : model.properties.first?.id)
                    ?? ""
            },
            set: { targetID in
                Task {
                    await model.pinOverview(
                        scope: model.pinnedOverviewScope,
                        targetID: targetID
                    )
                }
            }
        )
    }

    private func metricToggle(
        _ title: LocalizedStringKey,
        metric: GlanceOverviewMetric
    ) -> some View {
        Toggle(
            title,
            isOn: Binding(
                get: { model.overviewMetrics.contains(metric) },
                set: { model.setOverviewMetric(metric, enabled: $0) }
            )
        )
        .disabled(
            model.overviewMetrics.count == 1
                && model.overviewMetrics.contains(metric)
        )
    }
}
