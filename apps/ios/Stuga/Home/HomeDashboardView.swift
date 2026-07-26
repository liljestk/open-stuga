import SwiftUI

struct HomeDashboardView: View {
    @EnvironmentObject private var model: AppModel
    let openAlerts: () -> Void
    let openCapture: () -> Void
    let openRoomScan: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                StugaScreenBackground()
                if let home = model.selectedHome {
                    dashboard(home: home)
                } else {
                    emptyHome
                }
            }
            .navigationTitle(model.selectedHome?.name ?? "Home")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(action: openCapture) {
                            Label("Quick capture", systemImage: "square.and.pencil")
                        }
                        .disabled(model.selectedHomeReadOnly)
                        Button(action: openRoomScan) {
                            Label("Scan a room", systemImage: "viewfinder")
                        }
                        .disabled(model.selectedHomeReadOnly || model.usingCachedData)
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                }
                HomePickerToolbar()
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
                                .foregroundStyle(StugaTheme.muted)
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
                stugbyStateNotice(home)
                attentionSection
                currentStateSection
                todaySection
                keyStatusSection
                everythingElseSection
            }
            .padding(16)
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder
    private func stugbyStateNotice(_ home: House) -> some View {
        if let link = home.stugby {
            let remote = link.isForeignSharedHome
            let readOnly = link.isReadOnly
            StugaCard {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .center, spacing: 10) {
                        Image(systemName: remote ? "person.2.fill" : "house.fill")
                            .foregroundStyle(remote ? StugaTheme.action : StugaTheme.ink)
                        Text(remote ? "Remote Stugby Home" : "Your Stugby Home")
                            .font(.headline)
                        Spacer()
                        StatusPill(
                            label: stugbySyncLabel(link.syncState),
                            systemImage: stugbySyncSymbol(link.syncState),
                            color: stugbySyncColor(link.syncState)
                        )
                    }
                    Text(
                        remote
                            ? readOnly
                                ? "Another Stuga owns this Home. You can monitor it here, but shared edits are read-only."
                                : "Another Stuga owns this Home and allows shared edits. Sensor and energy-source bindings remain with its owner."
                            : "This Stuga remains the owner. Sharing does not move integration credentials or authority elsewhere."
                    )
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func stugbySyncLabel(_ state: String) -> String {
        switch state {
        case "current": "Current"
        case "pending": "Syncing"
        case "offline": "Offline"
        case "conflict": "Conflict"
        case "detached": "Detached"
        default: state.capitalized
        }
    }

    private func stugbySyncSymbol(_ state: String) -> String {
        switch state {
        case "current": "checkmark.circle.fill"
        case "pending": "arrow.triangle.2.circlepath"
        case "offline": "wifi.slash"
        case "conflict": "exclamationmark.triangle.fill"
        case "detached": "link.badge.plus"
        default: "info.circle"
        }
    }

    private func stugbySyncColor(_ state: String) -> Color {
        switch state {
        case "current", "detached": StugaTheme.success
        case "pending", "offline": StugaTheme.warning
        case "conflict": StugaTheme.critical
        default: StugaTheme.muted
        }
    }

    @ViewBuilder
    private var savedStateNotice: some View {
        if model.usingCachedData || model.pendingActionCount > 0 {
            StugaCard {
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
                                .foregroundStyle(StugaTheme.muted)
                        }
                    }
                    if model.pendingActionCount > 0 {
                        Label(
                            "\(model.pendingActionCount) change\(model.pendingActionCount == 1 ? "" : "s") waiting to sync.",
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StugaTheme.warning)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var attentionSection: some View {
        let active = model.selectedHomeAlerts.filter(\.isActive)
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
                    .foregroundStyle(StugaTheme.ink)
                Text("\(sensorName) · \(value) reached a threshold of \(threshold).")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Open alert")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StugaTheme.action)
                    .padding(.top, 2)
            }
            Spacer()
        }
        .padding(14)
        .background(alert.severity == "critical" ? StugaTheme.criticalSurface : StugaTheme.warningSurface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(color)
                .frame(width: 4)
                .clipShape(.rect(cornerRadius: 2))
                .padding(.vertical, 8)
        }
        .accessibilityElement(children: .combine)
    }

    private var currentStateSection: some View {
        let summary = model.monitorSummary
        let appearance = monitorAppearance(summary.state)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Current state")
                .font(.headline)
            StugaCard {
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
                            .foregroundStyle(StugaTheme.muted)
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
                StugaCard {
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: recommendationSymbol(recommendation.kind))
                            .font(.title2)
                            .foregroundStyle(StugaTheme.action)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(recommendation.title)
                                .font(.title3.weight(.semibold))
                            Text(recommendation.detail)
                                .font(.subheadline)
                            if let startsAt = recommendation.startsAt,
                               let endsAt = recommendation.endsAt {
                                Text(
                                    "\(startsAt.formatted(date: .omitted, time: .shortened))–\(endsAt.formatted(date: .omitted, time: .shortened))"
                                )
                                .font(.subheadline.weight(.semibold))
                            }
                            Text(recommendation.evidence)
                                .font(.caption)
                                .foregroundStyle(StugaTheme.muted)
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
        }
    }

    @ViewBuilder
    private var keyStatusSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Key status")
                .font(.headline)
            if model.selectedConditions.isEmpty {
                StugaCard {
                    Label("No enabled sensors are available for this Home.", systemImage: "sensor.tag.radiowaves.forward.slash")
                        .foregroundStyle(StugaTheme.muted)
                }
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 12)], spacing: 12) {
                    ForEach(model.selectedConditions.prefix(6)) { condition in
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
            StugaCard {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("\(model.selectedSensors.count) enabled sensors", systemImage: "sensor")
                        Label("\(liveCount) reporting live", systemImage: "dot.radiowaves.left.and.right")
                        if model.selectedConditions.count > 6 {
                            Text("Open Sensors to see all rooms and measurements.")
                                .foregroundStyle(StugaTheme.muted)
                        }
                    }
                    .font(.subheadline)
                    .padding(.top, 12)
                } label: {
                    Label(
                        liveCount == model.selectedSensors.count && liveCount > 0
                            ? "Routine monitoring looks healthy"
                            : "Monitoring details",
                        systemImage: liveCount == model.selectedSensors.count && liveCount > 0
                            ? "checkmark.circle.fill"
                            : "info.circle"
                    )
                    .foregroundStyle(
                        liveCount == model.selectedSensors.count && liveCount > 0
                            ? StugaTheme.success
                            : StugaTheme.ink
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
            Text("Add a Home in the Stuga web app, or ask an Owner to grant access.")
        } actions: {
            if let url = model.serverAddress?.webURL() {
                Link("Open Stuga", destination: url)
            }
        }
    }

    private func monitorAppearance(_ state: HomeMonitorState) -> (symbol: String, color: Color) {
        switch state {
        case .critical: ("exclamationmark.octagon.fill", StugaTheme.critical)
        case .attention: ("exclamationmark.triangle.fill", StugaTheme.warning)
        case .limited: ("circle.dashed", StugaTheme.muted)
        case .balanced: ("checkmark.circle.fill", StugaTheme.success)
        }
    }
}
