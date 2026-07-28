import SwiftUI

struct SensorsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""

    private var filteredConditions: [SensorCondition] {
        let conditions = model.selectedConditions
        guard !searchText.isEmpty else { return conditions }
        return conditions.filter {
            $0.sensor.name.localizedCaseInsensitiveContains(searchText)
                || $0.sensor.room.localizedCaseInsensitiveContains(searchText)
        }
    }

    private var filteredContacts: [TpLinkDiscoveredDevice] {
        guard !searchText.isEmpty else { return model.selectedContactDevices }
        return model.selectedContactDevices.filter { device in
            let assignment = model.contactOpeningAssignment(for: device)
            return model.contactDisplayName(device).localizedCaseInsensitiveContains(searchText)
                || device.model.localizedCaseInsensitiveContains(searchText)
                || assignment?.label.localizedCaseInsensitiveContains(searchText) == true
                || assignment?.floorName.localizedCaseInsensitiveContains(searchText) == true
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
                } else if model.selectedConditions.isEmpty
                            && model.selectedContactDevices.isEmpty {
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

                            if !filteredContacts.isEmpty {
                                sectionHeading("Doors and windows")
                                ForEach(filteredContacts) { device in
                                    NavigationLink {
                                        ContactSensorDetailView(
                                            deviceID: device.id,
                                            initialDevice: device
                                        )
                                    } label: {
                                        ContactSensorListRow(device: device)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            if !filteredConditions.isEmpty {
                                sectionHeading("Climate and energy")
                            }
                            ForEach(filteredConditions) { condition in
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

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.bold))
            .foregroundStyle(StuguTheme.muted)
            .textCase(.uppercase)
            .tracking(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct ContactSensorListRow: View {
    @EnvironmentObject private var model: AppModel
    let device: TpLinkDiscoveredDevice

    var body: some View {
        let assignment = model.contactOpeningAssignment(for: device)
        let state = model.contactState(for: device)
        StuguCard {
            HStack(spacing: 14) {
                Image(systemName: ContactPresentation.symbol(state, kind: assignment?.kind))
                    .font(.title3)
                    .foregroundStyle(ContactPresentation.color(state))
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.contactDisplayName(device))
                        .font(.headline)
                    Text(assignment.map { "\($0.label) · \($0.floorName)" } ?? "Opening not linked")
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                    Text(device.model)
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }
                Spacer(minLength: 8)
                Text(ContactPresentation.label(state))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ContactPresentation.color(state))
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(StuguTheme.muted)
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
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
