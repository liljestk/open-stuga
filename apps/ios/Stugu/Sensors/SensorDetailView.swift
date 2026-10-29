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
            StuguScreenBackground()
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
                    .foregroundStyle(StuguTheme.muted)
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
                .background(StuguTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.control))
                .overlay {
                    RoundedRectangle(cornerRadius: StuguTheme.Radius.control)
                        .stroke(StuguTheme.strongLine, lineWidth: 1)
                }
            }
        }
    }

    private var currentValueCard: some View {
        StuguCard {
            VStack(alignment: .leading, spacing: 5) {
                Text(ConditionPresentation.metricName(selectedMetric, model: model))
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                if let sample = currentSample {
                    Text(ConditionPresentation.metricValue(sample, model: model))
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .monospacedDigit()
                    if let observed = sample.observedAt {
                        Text("Updated \(observed.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(StuguTheme.muted)
                    }
                } else {
                    Text("No current reading")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(StuguTheme.muted)
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
                        .foregroundStyle(StuguTheme.muted)
                    if model.usingCachedData {
                        Label("Protected snapshot", systemImage: "iphone")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(StuguTheme.warning)
                    }
                }
                Spacer()
                if isLoading { ProgressView() }
            }
            StuguCard {
                if let historyError {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(historyError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(StuguTheme.critical)
                        Button("Try again") { Task { await loadHistory() } }
                    }
                } else if history.isEmpty && !isLoading {
                    Label("No history is available for this period.", systemImage: "chart.xyaxis.line")
                        .foregroundStyle(StuguTheme.muted)
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
                            .foregroundStyle(StuguTheme.action)
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
                            .foregroundStyle(StuguTheme.action)
                            .symbolSize(history.count > 60 ? 0 : 12)
                        }
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) {
                            AxisGridLine().foregroundStyle(StuguTheme.line)
                            AxisValueLabel(format: .dateTime.hour().minute())
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading) {
                            AxisGridLine().foregroundStyle(StuguTheme.line)
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
        StuguCard {
            DisclosureGroup("Reading details") {
                VStack(alignment: .leading, spacing: 10) {
                    detailRow("Sensor", condition.sensor.name)
                    detailRow("Model", condition.sensor.model)
                    if let sample = currentSample {
                        detailRow("Source", sourceLabel(sample.source))
                        detailRow("Quality", sample.quality.capitalized)
                        detailRow("Recorded", sample.observedAt.map {
                            StuguDateParser.dateTime(from: $0, includesSeconds: true)
                        } ?? sample.timestamp)
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
                .foregroundStyle(StuguTheme.muted)
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
        case "api": "Stugu API"
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

struct ContactSensorDetailView: View {
    private enum HistoryRange: Int, CaseIterable, Identifiable {
        case sixHours = 6
        case day = 24
        case week = 168

        var id: Int { rawValue }
        var label: String {
            switch self {
            case .sixHours: "6 h"
            case .day: "24 h"
            case .week: "7 d"
            }
        }
    }

    private struct ChartPoint: Identifiable {
        let id: String
        let date: Date
        let state: StuguOpeningState

        var value: Int { state == .open ? 1 : 0 }
    }

    @EnvironmentObject private var model: AppModel
    let deviceID: String
    let initialDevice: TpLinkDiscoveredDevice

    @State private var range: HistoryRange = .day
    @State private var rangeEnd = Date()
    @State private var history: [OpeningStateObservation] = []
    @State private var isLoading = false
    @State private var historyError: String?

    private var device: TpLinkDiscoveredDevice {
        model.contactDevice(id: deviceID) ?? initialDevice
    }

    private var assignment: ContactOpeningAssignment? {
        model.contactOpeningAssignment(for: device)
    }

    private var rangeStart: Date {
        rangeEnd.addingTimeInterval(-TimeInterval(range.rawValue) * 3_600)
    }

    private var homeTimeZone: TimeZone {
        guard let identifier = model.selectedHome?.timezone,
              let timeZone = TimeZone(identifier: identifier) else {
            return .autoupdatingCurrent
        }
        return timeZone
    }

    private var summary: ContactHistorySummary {
        guard let assignment else {
            return ContactHistorySummary(
                openingCount: 0,
                closingCount: 0,
                confirmedOpenDuration: 0,
                currentState: .unknown,
                transitions: []
            )
        }
        return ContactHistoryAnalyzer.analyze(
            history,
            deviceId: device.deviceId,
            connectionId: device.connectionId,
            floorId: assignment.floorId,
            elementId: assignment.elementId,
            invert: assignment.invert,
            staleAfterSeconds: assignment.staleAfterSeconds,
            from: rangeStart,
            to: rangeEnd
        )
    }

    private var displayedCurrentState: StuguOpeningState {
        let liveState = model.contactState(for: device)
        return liveState == .unknown ? summary.currentState : liveState
    }

    private var chartPoints: [ChartPoint] {
        guard let assignment else { return [] }
        return history.compactMap { observation in
            guard observation.floorId == assignment.floorId,
                  observation.elementId == assignment.elementId,
                  observation.source == "tapo",
                  observation.externalId == device.deviceId,
                  device.connectionId == nil
                    || observation.connectionId == device.connectionId,
                  observation.state != .unknown,
                  let date = observation.observedDate,
                  date >= rangeStart,
                  date <= rangeEnd else {
                return nil
            }
            let state: StuguOpeningState
            if assignment.invert {
                state = observation.state == .open ? .closed : .open
            } else {
                state = observation.state
            }
            return ChartPoint(id: observation.id, date: date, state: state)
        }.sorted { $0.date < $1.date }
    }

    var body: some View {
        ZStack {
            StuguScreenBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    currentStateCard
                    historySection
                    evidenceCard
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(model.contactDisplayName(device))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: range) { await loadHistory() }
        .onChange(of: model.latestOpeningStateObservation) { _, observation in
            guard let observation, matches(observation) else { return }
            history.removeAll { $0.id == observation.id }
            history.append(observation)
            history.sort { ($0.observedDate ?? .distantPast) < ($1.observedDate ?? .distantPast) }
            if let observedAt = observation.observedDate {
                rangeEnd = max(rangeEnd, observedAt)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(assignment.map { "\($0.label) · \($0.floorName)" } ?? "Opening not linked")
                    .font(.title2.weight(.bold))
                Text(device.model)
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            }
            Spacer()
            StatusPill(
                label: ContactPresentation.label(displayedCurrentState),
                systemImage: ContactPresentation.symbol(
                    displayedCurrentState,
                    kind: assignment?.kind
                ),
                color: ContactPresentation.color(displayedCurrentState)
            )
        }
    }

    private var currentStateCard: some View {
        return StuguCard {
            HStack(alignment: .top, spacing: 14) {
                Image(
                    systemName: ContactPresentation.symbol(
                        displayedCurrentState,
                        kind: assignment?.kind
                    )
                )
                    .font(.largeTitle)
                    .foregroundStyle(ContactPresentation.color(displayedCurrentState))
                    .frame(width: 44)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(ContactPresentation.label(displayedCurrentState))
                        .font(.title2.weight(.bold))
                    if let seen = device.lastSeenDate {
                        Text("Last observed \(seen.formatted(.relative(presentation: .named)))")
                            .font(.subheadline)
                            .foregroundStyle(StuguTheme.muted)
                    }
                    if assignment == nil {
                        Text("Attach this contact sensor to a door or window in the full Stugu interface.")
                            .font(.subheadline)
                            .foregroundStyle(StuguTheme.muted)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Opening history")
                        .font(.headline)
                    Text("Confirmed contact transitions; gaps are not inferred.")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }
                Spacer()
                if isLoading { ProgressView() }
            }

            Picker("History range", selection: $range) {
                ForEach(HistoryRange.allCases) { item in
                    Text(item.label).tag(item)
                }
            }
            .pickerStyle(.segmented)

            if let historyError {
                StuguCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(historyError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(StuguTheme.critical)
                        Button("Try again") { Task { await loadHistory() } }
                    }
                }
            } else if assignment == nil {
                StuguCard {
                    Label(
                        "History becomes available after this device is linked to an opening.",
                        systemImage: "link.badge.plus"
                    )
                    .foregroundStyle(StuguTheme.muted)
                }
            } else {
                historySummary
            }
        }
    }

    private var historySummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 10)], spacing: 10) {
                statistic("Opened", "\(summary.openingCount)")
                statistic("Closed", "\(summary.closingCount)")
                statistic("Confirmed open", durationLabel(summary.confirmedOpenDuration))
            }

            StuguCard {
                if chartPoints.isEmpty && !isLoading {
                    Label(
                        "No confirmed state changes are available for this period.",
                        systemImage: "clock"
                    )
                    .foregroundStyle(StuguTheme.muted)
                    .frame(minHeight: 150)
                } else {
                    Chart(chartPoints) { point in
                        PointMark(
                            x: .value("Time", point.date),
                            y: .value("State", point.value)
                        )
                        .foregroundStyle(
                            point.state == .open ? StuguTheme.action : StuguTheme.success
                        )
                        .symbol(by: .value("State", point.state.rawValue))
                        .symbolSize(42)
                    }
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: 4)) { value in
                            AxisGridLine().foregroundStyle(StuguTheme.line)
                            AxisValueLabel {
                                if let date = value.as(Date.self) {
                                    Text(axisLabel(date))
                                }
                            }
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: [0, 1]) { value in
                            AxisGridLine().foregroundStyle(StuguTheme.line)
                            AxisValueLabel {
                                Text((value.as(Int.self) ?? 0) == 1 ? "Open" : "Closed")
                            }
                        }
                    }
                    .chartYScale(domain: -0.2...1.2)
                    .chartLegend(.hidden)
                    .frame(height: 190)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Recorded opening state changes")
                    .accessibilityValue(
                        "\(summary.openingCount) openings and \(summary.closingCount) closings"
                    )
                }
            }

            if !summary.transitions.isEmpty {
                StuguCard {
                    DisclosureGroup("Recent changes") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(summary.transitions.suffix(12).reversed()) { transition in
                                HStack(alignment: .firstTextBaseline) {
                                    Label(
                                        transition.kind == .opened ? "Opened" : "Closed",
                                        systemImage: transition.kind == .opened
                                            ? "door.left.hand.open"
                                            : "door.left.hand.closed"
                                    )
                                    Spacer()
                                    Text(
                                        StuguDateParser.dateTime(
                                            from: transition.observedAt,
                                            timeZone: homeTimeZone
                                        )
                                    )
                                        .foregroundStyle(StuguTheme.muted)
                                }
                                .font(.subheadline)
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .padding(.top, 10)
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private var evidenceCard: some View {
        StuguCard {
            DisclosureGroup("Device details") {
                VStack(alignment: .leading, spacing: 10) {
                    detailRow("Device", device.deviceId)
                    detailRow("Model", device.model)
                    detailRow("Source", "TP-Link")
                    if let connectionID = device.connectionId {
                        detailRow("Connection", connectionID)
                    }
                    if let battery = device.battery {
                        detailRow("Battery", "\(battery.formatted(.number.precision(.fractionLength(0)))) %")
                    }
                    if let seen = device.lastSeenDate {
                        detailRow(
                            "Recorded",
                            StuguDateParser.dateTime(
                                from: seen,
                                includesSeconds: true,
                                timeZone: homeTimeZone
                            )
                        )
                    }
                    if let url = fullSensorsURL {
                        Link("Manage in full Stugu", destination: url)
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .padding(.top, 12)
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private var fullSensorsURL: URL? {
        guard let origin = model.serverAddress?.webURL(),
              let home = model.selectedHome else {
            return nil
        }
        return ["properties", home.propertyId, "homes", home.id, "sensors"].reduce(origin) {
            $0.appendingPathComponent($1)
        }
    }

    private func statistic(_ label: String, _ value: String) -> some View {
        StuguCard {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                Text(value)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(StuguTheme.muted)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .fontWeight(.regular)
        .accessibilityElement(children: .combine)
    }

    private func durationLabel(_ duration: TimeInterval) -> String {
        let minutes = max(0, Int(duration / 60))
        let hours = minutes / 60
        let remainder = minutes % 60
        if hours == 0 { return "\(minutes) min" }
        if remainder == 0 { return "\(hours) h" }
        return "\(hours) h \(remainder) min"
    }

    private func axisLabel(_ date: Date) -> String {
        if range != .week {
            return StuguDateParser.time(from: date, timeZone: homeTimeZone)
        }
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeZone = homeTimeZone
        formatter.dateFormat = "EEE HH"
        return formatter.string(from: date)
    }

    private func matches(_ observation: OpeningStateObservation) -> Bool {
        guard let assignment,
              let homeID = device.houseId ?? model.selectedHomeID else {
            return false
        }
        return observation.houseId == homeID
            && observation.floorId == assignment.floorId
            && observation.elementId == assignment.elementId
            && observation.source == "tapo"
            && observation.externalId == device.deviceId
            && (device.connectionId == nil
                || observation.connectionId == device.connectionId)
    }

    private func loadHistory() async {
        let requestedRange = range
        guard assignment != nil else {
            history = []
            historyError = nil
            return
        }
        if model.usingCachedData {
            history = []
            historyError = "Opening history is unavailable in the protected offline snapshot."
            return
        }
        isLoading = true
        historyError = nil
        let requestedEnd = Date()
        rangeEnd = requestedEnd
        defer {
            if range == requestedRange {
                isLoading = false
            }
        }
        do {
            let loaded = try await model.contactHistory(
                device: device,
                hours: requestedRange.rawValue,
                to: requestedEnd
            )
            guard !Task.isCancelled, range == requestedRange else { return }
            history = loaded
        } catch {
            guard !Task.isCancelled, range == requestedRange else { return }
            history = []
            historyError = error.localizedDescription
        }
    }
}
