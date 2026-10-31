import SwiftUI

struct HomeDashboardView: View {
    @EnvironmentObject private var model: AppModel
    let openAlerts: () -> Void
    let openCapture: () -> Void
    let openRoomScan: () -> Void
    @State private var showingOverviewSettings = false

    var body: some View {
        NavigationStack {
            ZStack {
                StuguScreenBackground()
                if model.pinnedOverviewScope == .property,
                   let property = model.pinnedOverviewProperty {
                    propertyDashboard(property: property)
                } else if let home = model.pinnedOverviewHome ?? model.selectedHome {
                    dashboard(home: home)
                } else {
                    emptyHome
                }
            }
            .navigationTitle(
                model.pinnedOverviewHome?.name
                    ?? model.pinnedOverviewProperty?.name
                    ?? model.selectedHome?.name
                    ?? "Overview"
            )
            .toolbar {
                if model.pinnedOverviewScope == .home,
                   let pinnedHome = model.pinnedOverviewHome ?? model.selectedHome,
                   pinnedHome.id == model.selectedHomeID {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button(action: openCapture) {
                                Label("Quick capture", systemImage: "square.and.pencil")
                            }
                            .disabled(model.selectedHomeReadOnly)
                            Button(action: openRoomScan) {
                                Label("Scan a room", systemImage: "viewfinder")
                            }
                            .disabled(!model.roomPlanCaptureAvailable)
                        } label: {
                            Label("Add", systemImage: "plus")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingOverviewSettings = true
                    } label: {
                        Label("Pin overview", systemImage: "pin")
                    }
                    .accessibilityHint("Choose a Home or Property and the quick stats to show.")
                }
            }
            .sheet(isPresented: $showingOverviewSettings) {
                PinnedOverviewSettingsView()
                    .environmentObject(model)
            }
        }
    }

    private func dashboard(home: House) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        if let property = model.selectedProperty {
                            Text(property.name.uppercased())
                                .font(.caption2.weight(.bold))
                                .tracking(1.2)
                                .foregroundStyle(StuguTheme.muted)
                        }
                        Spacer(minLength: 8)
                        HomeOriginPill(home: home)
                    }
                    Text("Here’s what matters now.")
                        .font(.title2.weight(.bold))
                    ConnectionStatusLine()
                        .padding(.top, 5)
                }

                savedStateNotice
                stugubyStateNotice(home)
                attentionSection(homeIDs: [home.id])
                quickStatsSection(homeIDs: [home.id])
                roomBreakdownSection(home: home)
                if home.id == model.selectedHomeID {
                    currentStateSection
                    todaySection
                    everythingElseSection
                }
            }
            .padding(16)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    private func propertyDashboard(property: StuguProperty) -> some View {
        let homes = model.houses.filter { $0.propertyId == property.id }
        let homeIDs = Set(homes.map(\.id))
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("PROPERTY OVERVIEW")
                        .font(.caption2.weight(.bold))
                        .tracking(1.2)
                        .foregroundStyle(StuguTheme.muted)
                    Text("Here’s what matters now.")
                        .font(.title2.weight(.bold))
                    ConnectionStatusLine()
                        .padding(.top, 5)
                }
                savedStateNotice
                attentionSection(homeIDs: homeIDs)
                quickStatsSection(homeIDs: homeIDs)
                homeBreakdownSection(homes: homes)
            }
            .padding(16)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder
    private func stugubyStateNotice(_ home: House) -> some View {
        if let link = home.stuguby {
            let remote = link.isForeignSharedHome
            let readOnly = link.isReadOnly
            StuguCard {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .center, spacing: 10) {
                        Image(systemName: remote ? "person.2.fill" : "house.fill")
                            .foregroundStyle(remote ? StuguTheme.action : StuguTheme.ink)
                        Text(remote ? "Remote Stuguby Home" : "Your Stuguby Home")
                            .font(.headline)
                        Spacer()
                        StatusPill(
                            label: stugubySyncLabel(link.syncState),
                            systemImage: stugubySyncSymbol(link.syncState),
                            color: stugubySyncColor(link.syncState)
                        )
                    }
                    Text(
                        remote
                            ? readOnly
                                ? "Another Stugu owns this Home. You can monitor it here, but shared edits are read-only."
                                : "Another Stugu owns this Home and allows shared edits. Sensor and energy-source bindings remain with its owner."
                            : "This Stugu remains the owner. Sharing does not move integration credentials or authority elsewhere."
                    )
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func stugubySyncLabel(_ state: String) -> String {
        switch state {
        case "current": "Current"
        case "pending": "Syncing"
        case "offline": "Offline"
        case "conflict": "Conflict"
        case "detached": "Detached"
        default: state.capitalized
        }
    }

    private func stugubySyncSymbol(_ state: String) -> String {
        switch state {
        case "current": "checkmark.circle.fill"
        case "pending": "arrow.triangle.2.circlepath"
        case "offline": "wifi.slash"
        case "conflict": "exclamationmark.triangle.fill"
        case "detached": "link.badge.plus"
        default: "info.circle"
        }
    }

    private func stugubySyncColor(_ state: String) -> Color {
        switch state {
        case "current", "detached": StuguTheme.success
        case "pending", "offline": StuguTheme.warning
        case "conflict": StuguTheme.critical
        default: StuguTheme.muted
        }
    }

    @ViewBuilder
    private var savedStateNotice: some View {
        if model.usingCachedData || model.pendingActionCount > 0 {
            StuguCard {
                VStack(alignment: .leading, spacing: 8) {
                    if model.usingCachedData {
                        Label(
                            "Showing the protected snapshot saved on this iPhone.",
                            systemImage: "iphone.and.arrow.forward"
                        )
                        .font(.subheadline.weight(.semibold))
                        if let updated = model.lastUpdated {
                            Text("Saved \(updated.formatted(.relative(presentation: .named))).")
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }
                    if model.pendingActionCount > 0 {
                        Label(
                            "\(model.pendingActionCount) change\(model.pendingActionCount == 1 ? "" : "s") waiting to sync.",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StuguTheme.warning)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func attentionSection(homeIDs: Set<String>) -> some View {
        let sensorIDs = Set(model.sensors.filter { homeIDs.contains($0.houseId) }.map(\.id))
        let active = model.alerts.filter {
            $0.isActive && $0.acknowledgedAt == nil && sensorIDs.contains($0.sensorId)
        }
        if !active.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Needs attention")
                    .font(.headline)
                ForEach(active.prefix(3)) { alert in
                    Button(action: openAlerts) {
                        alertSummary(alert)
                    }
                    .buttonStyle(.plain)
                }
                if active.count > 3 {
                    Button("View all \(active.count) alerts", action: openAlerts)
                        .font(.subheadline.weight(.semibold))
                }
            }
        } else {
            Label("Nothing needs attention", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(StuguTheme.success)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StuguTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous)
                        .stroke(StuguTheme.line, lineWidth: 1)
                }
        }
    }

    private func alertSummary(_ alert: AlertEvent) -> some View {
        let color = ConditionPresentation.severityColor(alert.severity)
        let sensorName = model.sensor(for: alert.sensorId)?.name ?? "A sensor"
        let metric = ConditionPresentation.metricName(alert.metric, model: model)
        let definition = model.definition(for: alert.metric)
        let value = MetricValueFormatter.text(
            value: alert.value,
            precision: definition?.precision ?? 1,
            unit: definition?.unit ?? "",
            metric: alert.metric,
            units: model.unitSystem
        )
        let threshold = MetricValueFormatter.text(
            value: alert.threshold,
            precision: definition?.precision ?? 1,
            unit: definition?.unit ?? "",
            metric: alert.metric,
            units: model.unitSystem
        )
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: ConditionPresentation.severitySymbol(alert.severity))
                .font(.title3)
                .foregroundStyle(color)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.rule(for: alert.ruleId)?.name ?? "\(metric) needs attention")
                    .font(.headline)
                    .foregroundStyle(StuguTheme.ink)
                Text("\(sensorName) · \(value) reached a threshold of \(threshold).")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Open alert")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StuguTheme.action)
                    .padding(.top, 2)
            }
            Spacer()
        }
        .padding(14)
        .background(alert.severity == "critical" ? StuguTheme.criticalSurface : StuguTheme.warningSurface)
        .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(color)
                .frame(width: 4)
                .clipShape(.rect(cornerRadius: 2))
                .padding(.vertical, 8)
        }
        .accessibilityElement(children: .combine)
    }

    private var visibleOverviewMetrics: [GlanceOverviewMetric] {
        GlanceOverviewMetric.allCases.filter(model.overviewMetrics.contains)
    }

    private func conditions(homeIDs: Set<String>) -> [SensorCondition] {
        homeIDs.flatMap { model.conditions(forHomeID: $0) }
    }

    private func quickStatsSection(homeIDs: Set<String>) -> some View {
        let scopedConditions = conditions(homeIDs: homeIDs)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Quick stats")
                .font(.headline)
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 145), spacing: 10)],
                spacing: 10
            ) {
                ForEach(visibleOverviewMetrics, id: \.self) { metric in
                    overviewMetricCard(
                        GlanceOverviewAggregation.summarize(
                            metric,
                            conditions: scopedConditions
                        )
                    )
                }
            }
        }
    }

    private func overviewMetricCard(_ summary: GlanceOverviewSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(metricLabel(summary.metric), systemImage: metricSymbol(summary.metric))
                .font(.caption.weight(.semibold))
                .foregroundStyle(metricColor(summary.metric))
                .lineLimit(1)
            Text(metricValue(summary))
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(StuguTheme.ink)
            Text(summary.value == nil ? "No recent reading" : "Updated recently")
                .font(.caption)
                .foregroundStyle(StuguTheme.muted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
        .background(StuguTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous)
                .stroke(StuguTheme.line, lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }

    private func roomBreakdownSection(home: House) -> some View {
        let activeSensorIDs = Set(model.selectedHomeAlerts.filter {
            $0.isActive && $0.acknowledgedAt == nil
        }.map(\.sensorId))
        let groups = Dictionary(grouping: model.conditions(forHomeID: home.id)) {
            $0.sensor.room.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? $0.sensor.name
                : $0.sensor.room
        }
        let items = groups.map { label, conditions in
            OverviewBreakdownItem(
                id: label,
                label: label,
                conditions: conditions,
                alertCount: conditions.filter { activeSensorIDs.contains($0.sensor.id) }.count
            )
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
        return overviewBreakdownSection(title: "Rooms", items: items)
    }

    private func homeBreakdownSection(homes: [House]) -> some View {
        let activeAlerts = model.alerts.filter { $0.isActive && $0.acknowledgedAt == nil }
        let items = homes.map { home in
            let homeConditions = model.conditions(forHomeID: home.id)
            let sensorIDs = Set(homeConditions.map(\.sensor.id))
            return OverviewBreakdownItem(
                id: home.id,
                label: home.name,
                conditions: homeConditions,
                alertCount: activeAlerts.filter { sensorIDs.contains($0.sensorId) }.count
            )
        }.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
        return overviewBreakdownSection(title: "Homes", items: items)
    }

    private func overviewBreakdownSection(
        title: LocalizedStringKey,
        items: [OverviewBreakdownItem]
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
            ForEach(items) { item in
                StuguCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            Text(item.label)
                                .font(.headline)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                            if item.alertCount > 0 {
                                HStack(spacing: 4) {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                    Text(verbatim: String(item.alertCount))
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(StuguTheme.warning)
                                .accessibilityLabel("Needs attention")
                            }
                        }
                        LazyVGrid(
                            columns: [GridItem(.adaptive(minimum: 70), spacing: 10)],
                            alignment: .leading,
                            spacing: 8
                        ) {
                            ForEach(visibleOverviewMetrics, id: \.self) { metric in
                                let summary = GlanceOverviewAggregation.summarize(
                                    metric,
                                    conditions: item.conditions
                                )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(metricLabel(metric))
                                        .font(.caption2)
                                        .foregroundStyle(StuguTheme.muted)
                                        .lineLimit(1)
                                    Text(metricValue(summary))
                                        .font(.subheadline.weight(.semibold))
                                        .monospacedDigit()
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func metricValue(_ summary: GlanceOverviewSummary) -> String {
        guard let value = summary.value else { return "—" }
        let definition = model.definition(for: summary.metric.rawValue)
        return MetricValueFormatter.text(
            value: value,
            precision: definition?.precision ?? (summary.metric == .temperature ? 1 : 0),
            unit: definition?.unit ?? defaultUnit(summary.metric),
            metric: summary.metric.rawValue,
            units: model.unitSystem
        )
    }

    private func metricLabel(_ metric: GlanceOverviewMetric) -> String {
        if metric == .power { return String(localized: "Electricity now") }
        if let definition = model.definition(for: metric.rawValue) {
            return definition.label()
        }
        switch metric {
        case .temperature: return String(localized: "Temperature")
        case .humidity: return String(localized: "Humidity")
        case .power: return String(localized: "Electricity now")
        case .co2: return String(localized: "Carbon dioxide")
        }
    }

    private func defaultUnit(_ metric: GlanceOverviewMetric) -> String {
        switch metric {
        case .temperature: "°C"
        case .humidity: "%"
        case .power: "W"
        case .co2: "ppm"
        }
    }

    private func metricSymbol(_ metric: GlanceOverviewMetric) -> String {
        switch metric {
        case .temperature: "thermometer.medium"
        case .humidity: "drop.fill"
        case .power: "bolt.fill"
        case .co2: "aqi.medium"
        }
    }

    private func metricColor(_ metric: GlanceOverviewMetric) -> Color {
        switch metric {
        case .temperature: StuguTheme.warm
        case .humidity: StuguTheme.action
        case .power: StuguTheme.warning
        case .co2: StuguTheme.muted
        }
    }

    private var currentStateSection: some View {
        let summary = model.monitorSummary
        let appearance = monitorAppearance(summary.state)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Current state")
                .font(.headline)
            StuguCard {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: appearance.symbol)
                        .font(.title2)
                        .foregroundStyle(appearance.color)
                        .frame(width: 30)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(summary.title)
                            .font(.title3.weight(.semibold))
                        Text(summary.detail)
                            .font(.subheadline)
                            .foregroundStyle(StuguTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private var todaySection: some View {
        if let recommendation = model.todayRecommendation {
            VStack(alignment: .leading, spacing: 12) {
                Text("Today")
                    .font(.headline)
                StuguCard {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: recommendationSymbol(recommendation.kind))
                            .font(.title2)
                            .foregroundStyle(StuguTheme.action)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(recommendation.title)
                                .font(.title3.weight(.semibold))
                            Text(recommendation.detail)
                                .font(.subheadline)
                            if let startsAt = recommendation.startsAt,
                               let endsAt = recommendation.endsAt {
                                Text(
                                    "\(StuguDateParser.time(from: startsAt))–\(StuguDateParser.time(from: endsAt))"
                                )
                                .font(.subheadline.weight(.semibold))
                            }
                            Text(recommendation.evidence)
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func recommendationSymbol(_ kind: TodayRecommendation.Kind) -> String {
        switch kind {
        case .weatherWarning: "exclamationmark.triangle.fill"
        case .ventilation: "wind"
        case .electricity: "bolt.fill"
        case .monitoring: "waveform.path.ecg"
        }
    }

    @ViewBuilder
    private var keyStatusSection: some View {
        let contacts = Array(model.selectedContactDevices.prefix(3))
        let conditionLimit = max(0, 6 - contacts.count)
        VStack(alignment: .leading, spacing: 12) {
            Text("Key status")
                .font(.headline)
            if model.selectedConditions.isEmpty && contacts.isEmpty {
                StuguCard {
                    Label("No enabled sensors are available for this Home.", systemImage: "sensor.tag.radiowaves.forward.slash")
                        .foregroundStyle(StuguTheme.muted)
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 12)], spacing: 12) {
                    ForEach(contacts) { device in
                        NavigationLink {
                            ContactSensorDetailView(
                                deviceID: device.id,
                                initialDevice: device
                            )
                        } label: {
                            ContactSensorCard(device: device)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(model.selectedConditions.prefix(conditionLimit)) { condition in
                        NavigationLink {
                            SensorDetailView(condition: condition)
                        } label: {
                            SensorConditionCard(condition: condition)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var everythingElseSection: some View {
        let liveCount = model.selectedConditions.filter {
            ConditionPresentation.freshness($0) == .live
        }.count
        return VStack(alignment: .leading, spacing: 12) {
            Text("Everything else")
                .font(.headline)
            StuguCard {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("\(model.selectedConditions.count) enabled measurement sensors", systemImage: "sensor")
                        if !model.selectedContactDevices.isEmpty {
                            Label(
                                "\(model.selectedContactDevices.count) door and window contacts",
                                systemImage: "door.left.hand.open"
                            )
                        }
                        Label("\(liveCount) reporting live", systemImage: "dot.radiowaves.left.and.right")
                        if model.selectedConditions.count + model.selectedContactDevices.count > 6 {
                            Text("Open Sensors to see all rooms and measurements.")
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }
                    .font(.subheadline)
                    .padding(.top, 12)
                } label: {
                    Label(
                        liveCount == model.selectedConditions.count && liveCount > 0
                            ? "Routine monitoring looks healthy"
                            : "Monitoring details",
                        systemImage: liveCount == model.selectedConditions.count && liveCount > 0
                            ? "checkmark.circle.fill"
                            : "info.circle"
                    )
                    .foregroundStyle(
                        liveCount == model.selectedConditions.count && liveCount > 0
                            ? StuguTheme.success
                            : StuguTheme.ink
                    )
                    .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private var emptyHome: some View {
        ContentUnavailableView {
            Label("No Homes available", systemImage: "house")
        } description: {
            Text("Add a Home in the Stugu web app, or ask an Owner to grant access.")
        } actions: {
            if let url = model.serverAddress?.webURL() {
                Link("Open Stugu", destination: url)
            }
        }
    }

    private func monitorAppearance(_ state: HomeMonitorState) -> (symbol: String, color: Color) {
        switch state {
        case .critical: ("exclamationmark.octagon.fill", StuguTheme.critical)
        case .attention: ("exclamationmark.triangle.fill", StuguTheme.warning)
        case .limited: ("circle.dashed", StuguTheme.muted)
        case .balanced: ("checkmark.circle.fill", StuguTheme.success)
        }
    }
}

private struct OverviewBreakdownItem: Identifiable {
    let id: String
    let label: String
    let conditions: [SensorCondition]
    let alertCount: Int
}
