import SwiftUI

struct SensorsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""

    private var filtered: [SensorCondition] {
        let conditions = model.selectedConditions
        guard !searchText.isEmpty else { return conditions }
        return conditions.filter {
            $0.sensor.name.localizedCaseInsensitiveContains(searchText)
                || $0.sensor.room.localizedCaseInsensitiveContains(searchText)
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                StuguScreenBackground()
                if model.selectedHome == nil {
                    ContentUnavailableView(
                        "No Home selected",
                        systemImage: "house",
                        description: Text("Choose a Home to see its sensors.")
                    )
                } else if model.selectedConditions.isEmpty {
                    ContentUnavailableView {
                        Label("No sensors yet", systemImage: "sensor")
                    } description: {
                        Text("Add and place sensors in the Stugu web app.")
                    } actions: {
                        if let url = model.serverAddress?.webURL() {
                            Link("Open Stugu", destination: url)
                        }
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ConnectionStatusLine()
                                .padding(.bottom, 4)
                            ForEach(filtered) { condition in
                                NavigationLink {
                                    SensorDetailView(condition: condition)
                                } label: {
                                    SensorListRow(condition: condition)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                    }
                    .refreshable { await model.refresh() }
                }
            }
            .navigationTitle("Sensors")
            .searchable(text: $searchText, prompt: "Search sensors or rooms")
            .toolbar { HomePickerToolbar() }
        }
    }
}

private struct SensorListRow: View {
    @EnvironmentObject private var model: AppModel
    let condition: SensorCondition

    var body: some View {
        let freshness = ConditionPresentation.freshness(condition)
        StuguCard {
            HStack(spacing: 14) {
                Image(systemName: ConditionPresentation.freshnessSymbol(freshness))
                    .font(.title3)
                    .foregroundStyle(ConditionPresentation.freshnessColor(freshness))
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(condition.sensor.name)
                        .font(.headline)
                    Text(condition.sensor.room.isEmpty ? "Room not linked" : condition.sensor.room)
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                    Text(ConditionPresentation.freshnessLabel(freshness))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(ConditionPresentation.freshnessColor(freshness))
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    ForEach(Array(MetricOrder.sort(condition.measurements.keys).prefix(2)), id: \.self) { metric in
                        if let sample = condition.measurements[metric] {
                            Text(ConditionPresentation.metricValue(sample, model: model))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                        }
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(StuguTheme.muted)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}
