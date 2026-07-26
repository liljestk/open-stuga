import SwiftUI

@MainActor
enum ConditionPresentation {
    static func metricName(_ metric: String, model: AppModel) -> String {
        model.definition(for: metric)?.label() ?? metric.replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func metricValue(_ sample: MeasurementSample, model: AppModel) -> String {
        let definition = model.definition(for: sample.metric)
        return MetricValueFormatter.text(
            value: sample.value,
            precision: definition?.precision ?? 1,
            unit: definition?.unit ?? sample.canonicalUnit,
            metric: sample.metric,
            units: model.unitSystem
        )
    }

    static func freshness(_ condition: SensorCondition, now: Date = Date()) -> ReadingFreshness {
        guard let sample = condition.newestEnvironmentalSample ?? condition.newestSample else {
            return .missing
        }
        if sample.quality == "stale" { return .stale }
        let freshness = ReadingFreshness.evaluate(sampleDate: sample.observedAt, now: now)
        return sample.quality == "estimated" && freshness == .live ? .aging : freshness
    }

    static func freshnessLabel(_ freshness: ReadingFreshness) -> String {
        switch freshness {
        case .live: "Live"
        case .aging: "Check soon"
        case .stale: "Stale"
        case .missing: "No reading"
        }
    }

    static func freshnessSymbol(_ freshness: ReadingFreshness) -> String {
        switch freshness {
        case .live: "circle.fill"
        case .aging: "clock.fill"
        case .stale: "exclamationmark.triangle.fill"
        case .missing: "circle.dashed"
        }
    }

    static func freshnessColor(_ freshness: ReadingFreshness) -> Color {
        switch freshness {
        case .live: StugaTheme.success
        case .aging: StugaTheme.warning
        case .stale: StugaTheme.critical
        case .missing: StugaTheme.muted
        }
    }

    static func severityColor(_ severity: String) -> Color {
        switch severity {
        case "critical": StugaTheme.critical
        case "warning": StugaTheme.warning
        default: StugaTheme.action
        }
    }

    static func severitySymbol(_ severity: String) -> String {
        switch severity {
        case "critical": "exclamationmark.octagon.fill"
        case "warning": "exclamationmark.triangle.fill"
        default: "info.circle.fill"
        }
    }
}

struct ConnectionStatusLine: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.liveConnected ? "circle.fill" : "arrow.triangle.2.circlepath")
                .font(.caption2)
            Text(model.liveConnected ? "Live" : "Trying to reconnect")
            Spacer()
            if let updated = model.lastUpdated {
                Text(updated, style: .relative)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(model.liveConnected ? StugaTheme.success : StugaTheme.warning)
        .accessibilityElement(children: .combine)
    }
}

struct HomeOriginPill: View {
    let home: House

    var body: some View {
        let remote = home.stugby?.isForeignSharedHome == true
        Label(
            remote ? "Remote" : "Own",
            systemImage: remote ? "person.2.fill" : "house.fill"
        )
        .font(.caption.weight(.semibold))
        .foregroundStyle(remote ? StugaTheme.action : StugaTheme.ink)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            (remote ? StugaTheme.action : StugaTheme.surfaceRaised).opacity(0.12)
        )
        .clipShape(Capsule())
        .overlay {
            Capsule().stroke(
                remote ? StugaTheme.action.opacity(0.5) : StugaTheme.line,
                lineWidth: 1
            )
        }
        .accessibilityLabel(
            remote
                ? "Remote Home shared from another Stuga"
                : "Home owned by this Stuga"
        )
    }
}

struct SensorConditionCard: View {
    @EnvironmentObject private var model: AppModel
    let condition: SensorCondition

    var body: some View {
        let freshness = ConditionPresentation.freshness(condition)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(condition.sensor.name)
                        .font(.headline)
                        .foregroundStyle(StugaTheme.ink)
                        .lineLimit(2)
                    if !condition.sensor.room.isEmpty {
                        Text(condition.sensor.room)
                            .font(.caption)
                            .foregroundStyle(StugaTheme.muted)
                    }
                }
                Spacer(minLength: 4)
                Image(systemName: ConditionPresentation.freshnessSymbol(freshness))
                    .font(.caption)
                    .foregroundStyle(ConditionPresentation.freshnessColor(freshness))
                    .accessibilityLabel(ConditionPresentation.freshnessLabel(freshness))
            }

            let metrics = MetricOrder.sort(condition.measurements.keys).prefix(2)
            if metrics.isEmpty {
                Text("No current reading")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
            } else {
                ForEach(Array(metrics), id: \.self) { metric in
                    if let sample = condition.measurements[metric] {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ConditionPresentation.metricName(metric, model: model))
                                .font(.caption)
                                .foregroundStyle(StugaTheme.muted)
                            Text(ConditionPresentation.metricValue(sample, model: model))
                                .font(.title3.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(StugaTheme.ink)
                        }
                    }
                }
            }

            Text(ConditionPresentation.freshnessLabel(freshness))
                .font(.caption.weight(.semibold))
                .foregroundStyle(ConditionPresentation.freshnessColor(freshness))
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 166, alignment: .topLeading)
        .background(StugaTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(StugaTheme.line, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

@MainActor
struct HomePickerToolbar: ToolbarContent {
    @EnvironmentObject private var model: AppModel

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                ForEach(model.properties) { property in
                    let homes = model.houses.filter { $0.propertyId == property.id }
                    if !homes.isEmpty {
                        Section(property.name) {
                            ForEach(homes) { home in
                                Button {
                                    Task { await model.selectHome(home.id) }
                                } label: {
                                    Label(
                                        "\(home.name) · \(home.stugby?.isForeignSharedHome == true ? "Remote" : "Own")",
                                        systemImage: home.id == model.selectedHomeID
                                            ? "checkmark.circle.fill"
                                            : home.stugby?.isForeignSharedHome == true
                                                ? "person.2.fill"
                                                : "house"
                                    )
                                }
                            }
                        }
                    }
                }
            } label: {
                Label("Choose Home", systemImage: "house.and.flag")
            }
            .accessibilityLabel("Choose Home. \(model.selectedHome?.name ?? "None selected")")
        }
    }
}
