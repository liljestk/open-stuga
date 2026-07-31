import SwiftUI

struct AlertsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var scope: Scope = .active

    private enum Scope: String, CaseIterable, Identifiable {
        case active = "Active"
        case history = "History"
        var id: Self { self }
    }

    private var visibleAlerts: [AlertEvent] {
        switch scope {
        case .active: model.activeAlerts
        case .history: model.alerts.filter { !$0.isActive }
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                StuguScreenBackground()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        Picker("Alert view", selection: $scope) {
                            ForEach(Scope.allCases) { scope in
                                Text(scope.rawValue).tag(scope)
                            }
                        }
                        .pickerStyle(.segmented)

                        if visibleAlerts.isEmpty {
                            emptyState
                                .padding(.top, 40)
                        } else {
                            ForEach(visibleAlerts) { alert in
                                AlertCard(alert: alert)
                            }
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await model.refresh() }
            }
            .navigationTitle("Alerts")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                scope == .active ? "Nothing needs attention" : "No alert history",
                systemImage: scope == .active ? "checkmark.circle" : "clock"
            )
        } description: {
            Text(scope == .active
                 ? "Active, actionable exceptions will appear here."
                 : "Resolved alerts will remain available here.")
        }
    }
}

private struct AlertCard: View {
    @EnvironmentObject private var model: AppModel
    let alert: AlertEvent
    @State private var isAcknowledging = false

    private var rule: AlertRule? { model.rule(for: alert.ruleId) }
    private var sensor: Sensor? { model.sensor(for: alert.sensorId) }
    private var home: House? { model.house(for: alert.sensorId) }
    private var color: Color { ConditionPresentation.severityColor(alert.severity) }

    var body: some View {
        StuguCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: ConditionPresentation.severitySymbol(alert.severity))
                        .font(.title2)
                        .foregroundStyle(color)
                        .frame(width: 30)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(rule?.name ?? "\(metricName) alert")
                            .font(.headline)
                        Text(contextLine)
                            .font(.subheadline)
                            .foregroundStyle(StuguTheme.muted)
                    }
                    Spacer(minLength: 4)
                    StatusPill(
                        label: alert.severity.capitalized,
                        systemImage: ConditionPresentation.severitySymbol(alert.severity),
                        color: color
                    )
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("\(metricName): \(valueText)")
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                    Text(thresholdExplanation)
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                }

                HStack {
                    Label(startedText, systemImage: "clock")
                    Spacer()
                    if alert.resolvedAt != nil {
                        Label("Resolved", systemImage: "checkmark.circle")
                            .foregroundStyle(StuguTheme.success)
                    } else if alert.acknowledgedAt != nil {
                        Label("Seen", systemImage: "eye.fill")
                            .foregroundStyle(StuguTheme.action)
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(StuguTheme.muted)

                if alert.isActive,
                   alert.acknowledgedAt == nil,
                   model.canAcknowledgeAlert(alert) {
                    Button {
                        isAcknowledging = true
                        Task {
                            await model.acknowledge(alert)
                            isAcknowledging = false
                        }
                    } label: {
                        HStack {
                            if isAcknowledging { ProgressView() }
                            Label("Mark as seen", systemImage: "eye")
                        }
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(isAcknowledging)
                    Text("This records that you saw the alert. It does not resolve the underlying condition.")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }

                DisclosureGroup("Why Stugu is showing this") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("This measurement crossed the configured \(metricName.lowercased()) threshold.")
                        if let rule, rule.durationSeconds > 0 {
                            Text("The condition persisted for \(durationText(rule.durationSeconds)) before the alert opened.")
                        }
                        if let sampleSensor = sensor {
                            Text(evidenceText(sampleSensor))
                        }
                    }
                    .font(.subheadline)
                    .fontWeight(.regular)
                    .foregroundStyle(StuguTheme.muted)
                    .padding(.top, 10)
                }
                .font(.subheadline.weight(.semibold))
            }
        }
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(color)
                .frame(width: 4)
                .clipShape(.rect(cornerRadius: 2))
                .padding(.vertical, 9)
        }
    }

    private var metricName: String {
        ConditionPresentation.metricName(alert.metric, model: model)
    }

    private var valueText: String {
        let definition = model.definition(for: alert.metric)
        return MetricValueFormatter.text(
            value: alert.value,
            precision: definition?.precision ?? 1,
            unit: definition?.unit ?? "",
            metric: alert.metric,
            units: model.unitSystem
        )
    }

    private var thresholdExplanation: String {
        let definition = model.definition(for: alert.metric)
        let threshold = MetricValueFormatter.text(
            value: alert.threshold,
            precision: definition?.precision ?? 1,
            unit: definition?.unit ?? "",
            metric: alert.metric,
            units: model.unitSystem
        )
        switch rule?.operator {
        case "gt": return "Above the configured threshold of \(threshold)."
        case "gte": return "At or above the configured threshold of \(threshold)."
        case "lt": return "Below the configured threshold of \(threshold)."
        case "lte": return "At or below the configured threshold of \(threshold)."
        default: return "Crossed the configured threshold of \(threshold)."
        }
    }

    private var contextLine: String {
        let sensorName = sensor?.name ?? "Sensor"
        return home.map { "\($0.name) · \(sensorName)" } ?? sensorName
    }

    private var startedText: String {
        guard let date = alert.startedDate else { return alert.startedAt }
        return date.formatted(.relative(presentation: .named))
    }

    private func durationText(_ seconds: Int) -> String {
        if seconds >= 3_600 {
            return "\(seconds / 3_600) hr"
        }
        if seconds >= 60 {
            return "\(seconds / 60) min"
        }
        return "\(seconds) sec"
    }

    private func evidenceText(_ sensor: Sensor) -> String {
        sensor.room.isEmpty
            ? "Evidence: \(sensor.name)."
            : "Evidence: \(sensor.name) in \(sensor.room)."
    }
}
