import Charts
import SwiftUI

struct SensorDetailView: View {
    @EnvironmentObject private var model: AppModel
    let condition: SensorCondition

    @State private var selectedMetric: String
    @State private var history: [MeasurementSample] = []
    @State private var isLoading = false
    @State private var historyError: String?

    init(condition: SensorCondition) {
        self.condition = condition
        let first = MetricOrder.sort(condition.measurements.keys).first ?? "temperature"
        _selectedMetric = State(initialValue: first)
    }

    private var currentSample: MeasurementSample? {
        condition.measurements[selectedMetric]
    }

    private var definition: MeasurementDefinition? {
        model.definition(for: selectedMetric)
    }

    var body: some View {
        ZStack {
            StugaScreenBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    metricPicker
                    currentValueCard
                    historyCard
                    evidenceCard
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(condition.sensor.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: selectedMetric) { await loadHistory() }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(condition.sensor.room.isEmpty ? "Room not linked" : condition.sensor.room)
                    .font(.title2.weight(.bold))
                Text(condition.sensor.model)
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
            }
            Spacer()
            let freshness = ConditionPresentation.freshness(condition)
            StatusPill(
                label: ConditionPresentation.freshnessLabel(freshness),
                systemImage: ConditionPresentation.freshnessSymbol(freshness),
                color: ConditionPresentation.freshnessColor(freshness)
            )
        }
    }

    @ViewBuilder
    private var metricPicker: some View {
        let metrics = MetricOrder.sort(condition.measurements.keys)
        if metrics.count > 1 {
            VStack(alignment: .leading, spacing: 7) {
                Text("Measurement")
                    .font(.subheadline.weight(.semibold))
                Picker("Measurement", selection: $selectedMetric) {
                    ForEach(metrics, id: \.self) { metric in
                        Text(ConditionPresentation.metricName(metric, model: model)).tag(metric)
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .background(StugaTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay {
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(StugaTheme.strongLine, lineWidth: 1)
                }
            }
        }
    }

    private var currentValueCard: some View {
        StugaCard {
            VStack(alignment: .leading, spacing: 5) {
                Text(ConditionPresentation.metricName(selectedMetric, model: model))
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
                if let sample = currentSample {
                    Text(ConditionPresentation.metricValue(sample, model: model))
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .monospacedDigit()
                    if let observed = sample.observedAt {
                        Text("Updated \(observed.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(StugaTheme.muted)
                    }
                } else {
                    Text("No current reading")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(StugaTheme.muted)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Last 24 hours")
                        .font(.headline)
                    Text(
                        displayUnit.isEmpty
                            ? "Observed sensor values"
                            : "Observed sensor values · \(displayUnit)"
                    )
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)
                }
                Spacer()
                if isLoading { ProgressView() }
            }
            StugaCard {
                if let historyError {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(historyError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(StugaTheme.critical)
                        Button("Try again") { Task { await loadHistory() } }
                    }
                } else if history.isEmpty && !isLoading {
                    Label("No history is available for this period.", systemImage: "chart.xyaxis.line")
                        .foregroundStyle(StugaTheme.muted)
                        .frame(minHeight: 180)
                } else {
                    Chart(history, id: \.timestamp) { sample in
                        if let date = sample.observedAt {
                            LineMark(
                                x: .value("Time", date),
                                y: .value(
                                    ConditionPresentation.metricName(selectedMetric, model: model),
                                    MetricValueFormatter.convertedValue(
                                        sample.value,
                                        metric: selectedMetric,
                                        units: model.unitSystem
                                    )
                                )
                            )
                            .foregroundStyle(StugaTheme.action)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                            PointMark(
                                x: .value("Time", date),
                                y: .value(
                                    ConditionPresentation.metricName(selectedMetric, model: model),
                                    MetricValueFormatter.convertedValue(
                                        sample.value,
                                        metric: selectedMetric,
                                        units: model.unitSystem
                                    )
                                )
                            )
                            .foregroundStyle(StugaTheme.action)
                            .symbolSize(history.count > 60 ? 0 : 12)
                        }
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) {
                            AxisGridLine().foregroundStyle(StugaTheme.line)
                            AxisValueLabel(format: .dateTime.hour().minute())
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading) {
                            AxisGridLine().foregroundStyle(StugaTheme.line)
                            AxisValueLabel()
                        }
                    }
                    .frame(height: 220)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(ConditionPresentation.metricName(selectedMetric, model: model)) history for the last 24 hours")
                    .accessibilityValue(chartAccessibilityValue)
                }
            }
        }
    }

    private var evidenceCard: some View {
        StugaCard {
            DisclosureGroup("Reading details") {
                VStack(alignment: .leading, spacing: 10) {
                    detailRow("Sensor", condition.sensor.name)
                    detailRow("Model", condition.sensor.model)
                    if let sample = currentSample {
                        detailRow("Source", sourceLabel(sample.source))
                        detailRow("Quality", sample.quality.capitalized)
                        detailRow("Recorded", sample.observedAt?.formatted(date: .abbreviated, time: .standard) ?? sample.timestamp)
                        detailRow("Unit", definition?.unit ?? sample.canonicalUnit)
                    }
                }
                .padding(.top, 12)
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private var chartAccessibilityValue: String {
        guard let minimum = history.map(\.value).min(), let maximum = history.map(\.value).max() else {
            return "No values"
        }
        let unit = definition?.unit ?? currentSample?.canonicalUnit ?? ""
        let low = MetricValueFormatter.text(
            value: minimum,
            precision: definition?.precision ?? 1,
            unit: unit,
            metric: selectedMetric,
            units: model.unitSystem
        )
        let high = MetricValueFormatter.text(
            value: maximum,
            precision: definition?.precision ?? 1,
            unit: unit,
            metric: selectedMetric,
            units: model.unitSystem
        )
        return "\(history.count) points, from \(low) to \(high)"
    }

    private var displayUnit: String {
        MetricValueFormatter.displayUnit(
            metric: selectedMetric,
            canonicalUnit: definition?.unit ?? currentSample?.canonicalUnit ?? "",
            units: model.unitSystem
        )
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(StugaTheme.muted)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .fontWeight(.regular)
        .accessibilityElement(children: .combine)
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "home-assistant": "Home Assistant"
        case "tp-link": "TP-Link"
        case "mock": "Demo data"
        case "replay": "Replay"
        case "import": "Imported history"
        case "api": "Stuga API"
        default: source.capitalized
        }
    }

    private func loadHistory() async {
        guard condition.measurements[selectedMetric] != nil else {
            history = []
            return
        }
        isLoading = true
        historyError = nil
        defer { isLoading = false }
        do {
            history = try await model.history(sensorID: condition.sensor.id, metric: selectedMetric)
        } catch {
            history = []
            historyError = error.localizedDescription
        }
    }
}
