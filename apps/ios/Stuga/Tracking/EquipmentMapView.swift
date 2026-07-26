import CoreLocation
import MapKit
import SwiftUI

struct EquipmentMapView: View {
    private enum DisplayMode: String, CaseIterable, Identifiable {
        case list = "List"
        case map = "Map"

        var id: Self { self }
    }

    private enum ServiceFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case active = "Active"
        case outOfService = "Out of service"
        case retired = "Retired"

        var id: Self { self }

        var status: String? {
            switch self {
            case .all: nil
            case .active: "active"
            case .outOfService: "out-of-service"
            case .retired: "retired"
            }
        }
    }

    private enum ConditionFilter: String, CaseIterable, Identifiable {
        case all = "All conditions"
        case attention = "Needs attention"
        case moving = "Moving"
        case lowBattery = "Low battery"
        case notSeen = "Not seen"

        var id: Self { self }
    }

    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var tracker: MobileTrackingController
    @State private var cameraPosition: MapCameraPosition = .automatic
    @State private var selectedEquipmentID: String?
    @State private var displayMode: DisplayMode = .list
    @State private var query = ""
    @State private var serviceFilter: ServiceFilter = .all
    @State private var areaFilterID = ""
    @State private var conditionFilter: ConditionFilter = .all
    @State private var showingScanner = false
    @State private var showingEquipmentEditor = false

    var body: some View {
        NavigationStack {
            ZStack {
                StugaScreenBackground()
                if model.propertyInventory == nil {
                    unavailable
                } else if displayMode == .map, let snapshot = model.trackingSnapshot {
                    content(snapshot)
                } else {
                    inventoryList
                }
            }
            .navigationTitle("Inventory")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if !model.isReadOnly {
                            Button {
                                showingEquipmentEditor = true
                            } label: {
                                Label("Add equipment", systemImage: "plus")
                            }
                            .disabled(model.selectedPropertyAreas.isEmpty)
                            Divider()
                        }
                        Button {
                            showingScanner = true
                        } label: {
                            Label("Scan equipment tag", systemImage: "qrcode.viewfinder")
                        }
                    } label: {
                        Label("Inventory actions", systemImage: "plus.circle")
                    }
                }
                if model.properties.count > 1 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            ForEach(model.properties) { property in
                                Button {
                                    Task { await model.selectProperty(property.id) }
                                } label: {
                                    if property.id == model.selectedPropertyID {
                                        Label(property.name, systemImage: "checkmark")
                                    } else {
                                        Text(property.name)
                                    }
                                }
                            }
                        } label: {
                            Label("Choose Property", systemImage: "building.2")
                        }
                        .accessibilityLabel(
                            "Choose Property. \(model.selectedProperty?.name ?? "None selected")"
                        )
                    }
                }
            }
        }
        .sheet(item: Binding(
            get: {
                model.selectedPropertyEquipment.first { $0.id == selectedEquipmentID }
            },
            set: { selectedEquipmentID = $0?.id }
        )) { equipment in
            EquipmentDetailView(
                asset: model.trackedState(for: equipment.id)
                    ?? TrackedEquipmentState(equipment: equipment),
                snapshot: model.trackingSnapshot,
                tracker: tracker
            )
            .environmentObject(model)
        }
        .sheet(isPresented: $showingScanner) {
            EquipmentScannerSheet { value in
                guard let code = EquipmentQRCode.parse(value) else {
                    model.errorMessage = "This is not a valid Stuga equipment tag."
                    return
                }
                Task {
                    if let asset = await model.resolveEquipmentCode(code) {
                        selectedEquipmentID = asset.id
                    }
                }
            }
        }
        .sheet(isPresented: $showingEquipmentEditor) {
            EquipmentEditorView(equipment: nil)
                .environmentObject(model)
        }
        .onChange(of: model.selectedPropertyID) {
            displayMode = .list
            resetFilters()
        }
        .onChange(of: model.propertyInventory?.syncToken) {
            if !areaFilterID.isEmpty,
               !model.selectedPropertyAreas.contains(where: { $0.id == areaFilterID }) {
                areaFilterID = ""
            }
        }
        .onChange(of: model.requestedEquipmentID) { _, equipmentID in
            guard let equipmentID,
                  model.selectedPropertyEquipment.contains(where: { $0.id == equipmentID }) else {
                return
            }
            selectedEquipmentID = equipmentID
            model.requestedEquipmentID = nil
        }
    }

    private func content(_ snapshot: TrackingMapSnapshot) -> some View {
        let assets = filteredAssets(snapshot.assets)
        let selected = assets.first { $0.id == selectedEquipmentID }
        return VStack(spacing: 0) {
            VStack(spacing: 10) {
                displayModePicker
                compactFilterControls
                if model.memberLocationSharingAvailable {
                    MemberLocationSharingBanner(controller: model.memberLocationSharing)
                }
                if !model.equipmentObservationEnabled, model.mobileTrackingAvailable {
                    observationPrompt
                } else if model.equipmentObservationEnabled {
                    observerStatus
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Map(position: $cameraPosition) {
                if snapshot.settings.propertyBoundary.count >= 3 {
                    MapPolygon(coordinates: snapshot.settings.propertyBoundary.map(\.clCoordinate))
                        .foregroundStyle(StugaTheme.action.opacity(0.05))
                        .stroke(StugaTheme.action.opacity(0.55), lineWidth: 1.5)
                }
                if let selected,
                   let position = selected.position,
                   let coordinate = position.coordinate,
                   let radius = position.accuracyRadiusMeters {
                    MapCircle(center: coordinate.clCoordinate, radius: radius)
                        .foregroundStyle(StugaTheme.action.opacity(0.12))
                        .stroke(StugaTheme.action.opacity(0.75), lineWidth: 1.5)
                }
                if let selected,
                   let zoneID = selected.position?.zoneId,
                   let zone = snapshot.zones.first(where: { $0.id == zoneID }),
                   zone.polygon.count >= 3 {
                    MapPolygon(coordinates: zone.polygon.map(\.clCoordinate))
                        .foregroundStyle(StugaTheme.warning.opacity(0.14))
                        .stroke(StugaTheme.warning, lineWidth: 2)
                }
                ForEach(snapshot.members) { member in
                    MapCircle(
                        center: member.coordinate.clCoordinate,
                        radius: member.horizontalAccuracyMeters
                    )
                    .foregroundStyle(StugaTheme.action.opacity(0.08))
                    .stroke(StugaTheme.action.opacity(0.5), lineWidth: 1)
                    Annotation(member.memberLabel, coordinate: member.coordinate.clCoordinate) {
                        MemberLocationMarker(member: member)
                    }
                }
                ForEach(assets) { asset in
                    if let coordinate = displayCoordinate(for: asset, in: snapshot) {
                        Annotation(asset.equipment.name, coordinate: coordinate) {
                            Button {
                                selectedEquipmentID = asset.id
                            } label: {
                                EquipmentMarker(
                                    asset: asset,
                                    selected: selectedEquipmentID == asset.id
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(markerAccessibility(asset, snapshot: snapshot))
                        }
                    }
                }
            }
            .mapStyle(.standard(elevation: .realistic))
            .overlay(alignment: .bottomTrailing) {
                if model.trackingLiveConnected {
                    StatusPill(
                        label: "Live",
                        systemImage: "dot.radiowaves.left.and.right",
                        color: StugaTheme.success
                    )
                    .padding(12)
                }
            }
            .frame(minHeight: 280)

            assetTray(assets, snapshot: snapshot)
                .frame(maxHeight: 260)
        }
        .refreshable { await model.refreshTracking() }
    }

    private var inventoryList: some View {
        let equipment = filteredInventory(model.selectedPropertyEquipment)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                inventoryOverview

                if model.trackingSnapshot != nil {
                    displayModePicker
                }

                inventoryControls

                HStack {
                    Text(
                        "Showing \(equipment.count) item"
                            + (equipment.count == 1 ? "" : "s")
                    )
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
                    .accessibilityLabel(
                        "\(equipment.count) inventory "
                            + (equipment.count == 1 ? "result" : "results")
                    )
                    Spacer()
                    if filtersAreActive {
                        Button("Clear filters", action: resetFilters)
                            .font(.caption.weight(.semibold))
                    }
                }
                .padding(.horizontal, 2)

                if equipment.isEmpty {
                    VStack(spacing: 16) {
                        ContentUnavailableView {
                            Label(
                                model.selectedPropertyEquipment.isEmpty
                                    ? "No inventory items"
                                    : "No matching items",
                                systemImage: "shippingbox"
                            )
                        } description: {
                            Text(emptyInventoryMessage)
                        }
                        if model.selectedPropertyEquipment.isEmpty,
                           !model.isReadOnly,
                           !model.selectedPropertyAreas.isEmpty {
                            Button {
                                showingEquipmentEditor = true
                            } label: {
                                Label("Add equipment", systemImage: "plus")
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .frame(maxWidth: 360)
                        } else if filtersAreActive {
                            Button("Clear search and filters", action: resetFilters)
                                .buttonStyle(SecondaryButtonStyle())
                                .frame(maxWidth: 360)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                } else {
                    inventoryRows(equipment)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh() }
    }

    private var inventoryOverview: some View {
        let equipment = model.selectedPropertyEquipment
        let trackedCount = equipment.filter {
            model.trackedState(for: $0.id) != nil
        }.count
        let attentionCount = equipment.filter(needsAttention).count
        let locationCount = Set(equipment.map(\.areaId)).count

        return StugaCard {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.selectedProperty?.name ?? "Property")
                        .font(.headline)
                    Text("Property-wide equipment catalogue")
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)
                }
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.flexible(), spacing: 10),
                        count: dynamicTypeSize.isAccessibilitySize ? 1 : 2
                    ),
                    spacing: 10
                ) {
                    InventorySummaryMetric(
                        value: "\(equipment.count)",
                        label: "Total",
                        systemImage: "shippingbox",
                        color: StugaTheme.action
                    )
                    InventorySummaryMetric(
                        value: "\(attentionCount)",
                        label: "Needs attention",
                        systemImage: "wrench.adjustable",
                        color: attentionCount > 0
                            ? StugaTheme.warning
                            : model.trackingSnapshot == nil
                                ? StugaTheme.muted
                                : StugaTheme.success
                    )
                    InventorySummaryMetric(
                        value: "\(locationCount)",
                        label: "Assigned areas",
                        systemImage: "mappin.and.ellipse",
                        color: StugaTheme.muted
                    )
                    InventorySummaryMetric(
                        value: model.trackingSnapshot == nil ? "—" : "\(trackedCount)",
                        label: model.trackingSnapshot == nil ? "Live map off" : "BLE tracked",
                        systemImage: "dot.radiowaves.left.and.right",
                        color: StugaTheme.muted
                    )
                }
            }
        }
    }

    private var displayModePicker: some View {
        Picker("Inventory view", selection: $displayMode) {
            ForEach(DisplayMode.allCases) { value in
                Text(value.rawValue).tag(value)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Inventory view")
    }

    private var inventoryControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(StugaTheme.muted)
                    .accessibilityHidden(true)
                TextField("Search name, kind, serial or notes", text: $query)
                    .submitLabel(.search)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(StugaTheme.muted)
                    }
                    .accessibilityLabel("Clear inventory search")
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 46)
            .background(StugaTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(StugaTheme.line)
            }

            compactFilterControls
        }
    }

    private var compactFilterControls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        query = ""
                    } label: {
                        filterChip("Search: \(query)", systemImage: "xmark")
                    }
                    .accessibilityLabel("Clear inventory search for \(query)")
                }

                Menu {
                    Picker("Service state", selection: $serviceFilter) {
                        ForEach(ServiceFilter.allCases) { value in
                            Text(value.rawValue).tag(value)
                        }
                    }
                } label: {
                    filterChip(
                        serviceFilter == .all ? "Service: All" : serviceFilter.rawValue,
                        systemImage: "wrench.and.screwdriver"
                    )
                }
                .accessibilityLabel("Service state filter, \(serviceFilter.rawValue)")

                Menu {
                    Button {
                        areaFilterID = ""
                    } label: {
                        if areaFilterID.isEmpty {
                            Label("All areas", systemImage: "checkmark")
                        } else {
                            Text("All areas")
                        }
                    }
                    ForEach(model.selectedPropertyAreas.sorted {
                        $0.name.localizedStandardCompare($1.name) == .orderedAscending
                    }) { area in
                        Button {
                            areaFilterID = area.id
                        } label: {
                            if areaFilterID == area.id {
                                Label(area.name, systemImage: "checkmark")
                            } else {
                                Text(area.name)
                            }
                        }
                    }
                } label: {
                    filterChip(
                        areaFilterID.isEmpty
                            ? "Area: All"
                            : model.areaName(for: areaFilterID) ?? "Area",
                        systemImage: "mappin.and.ellipse"
                    )
                }
                .accessibilityLabel(
                    "Assigned area filter, "
                        + (areaFilterID.isEmpty
                            ? "all"
                            : model.areaName(for: areaFilterID) ?? "selected area")
                )

                Menu {
                    Picker("Condition", selection: $conditionFilter) {
                        ForEach(ConditionFilter.allCases) { value in
                            Text(value.rawValue).tag(value)
                        }
                    }
                } label: {
                    filterChip(
                        conditionFilter.rawValue,
                        systemImage: "line.3.horizontal.decrease"
                    )
                }
                .accessibilityLabel("Condition filter, \(conditionFilter.rawValue)")
            }
        }
    }

    private func filterChip(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(StugaTheme.ink)
            .lineLimit(1)
            .padding(.horizontal, 11)
            .frame(minHeight: 44)
            .background(StugaTheme.surface)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(StugaTheme.strongLine, lineWidth: 1)
            }
    }

    @ViewBuilder
    private func inventoryRows(_ equipment: [AreaEquipment]) -> some View {
        let attention = equipment.filter(needsAttention)
        let remaining = equipment.filter { !needsAttention($0) }

        if conditionFilter == .all, !attention.isEmpty {
            inventorySectionHeader("Needs attention", count: attention.count)
            ForEach(attention) { inventoryRow($0) }
            if !remaining.isEmpty {
                inventorySectionHeader("Everything else", count: remaining.count)
                ForEach(remaining) { inventoryRow($0) }
            }
        } else {
            ForEach(equipment) { inventoryRow($0) }
        }
    }

    private func inventorySectionHeader(_ title: String, count: Int) -> some View {
        HStack {
            Text(title)
                .font(.headline)
            Spacer()
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(StugaTheme.muted)
        }
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func inventoryRow(_ item: AreaEquipment) -> some View {
        let tracked = model.trackedState(for: item.id)
        return Button {
            selectedEquipmentID = item.id
        } label: {
            InventoryEquipmentRow(
                equipment: item,
                areaName: model.areaName(for: item.areaId),
                tracked: tracked,
                trackingAreaName: tracked?.position?.zoneId
                    .flatMap { model.areaName(for: $0) }
            )
        }
        .buttonStyle(.plain)
    }

    private var emptyInventoryMessage: String {
        if !model.selectedPropertyEquipment.isEmpty {
            return "Change or clear the search and filters."
        }
        if model.selectedPropertyAreas.isEmpty {
            return "Add a Property area in Stuga before assigning equipment."
        }
        if model.isReadOnly {
            return "No equipment is available to this account in the selected Property."
        }
        return "Add the first item, then print or scan its Stuga QR tag."
    }

    private var observationPrompt: some View {
        HStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(StugaTheme.action)
            VStack(alignment: .leading, spacing: 2) {
                Text("Help locate your equipment")
                    .font(.subheadline.weight(.semibold))
                Text("Opt in to nearby Bluetooth detections. iOS background detections are opportunistic.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
            Spacer()
            Button("Turn on") {
                Task { await model.setEquipmentObservationEnabled(true) }
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
        }
        .padding(12)
        .background(StugaTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(StugaTheme.line)
        }
    }

    private var observerStatus: some View {
        HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(StugaTheme.success)
            Text(tracker.bluetoothStatus)
                .font(.caption.weight(.semibold))
            Spacer()
            if tracker.queueStatus.queuedCount > 0 {
                Text("\(tracker.queueStatus.queuedCount) saved")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private func assetTray(
        _ assets: [TrackedEquipmentState],
        snapshot: TrackingMapSnapshot
    ) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if assets.isEmpty {
                    VStack(spacing: 6) {
                        Label("No tracked items match", systemImage: "map")
                            .font(.subheadline.weight(.semibold))
                        Text("Change the inventory filters or return to List.")
                            .font(.caption)
                            .foregroundStyle(StugaTheme.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(20)
                }
                let unknown = assets.filter {
                    displayCoordinate(for: $0, in: snapshot) == nil
                }
                if !unknown.isEmpty {
                    HStack {
                        Label("Unknown location", systemImage: "questionmark.circle")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StugaTheme.muted)
                        Spacer()
                        Text("\(unknown.count)")
                            .font(.caption.monospacedDigit())
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                ForEach(assets) { asset in
                    Button {
                        selectedEquipmentID = asset.id
                    } label: {
                        EquipmentRow(
                            asset: asset,
                            zoneName: zoneName(for: asset, snapshot: snapshot)
                        )
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(StugaTheme.line).padding(.leading, 56)
                }
            }
        }
        .background(StugaTheme.surface)
    }

    private var unavailable: some View {
        ContentUnavailableView {
            Label("Inventory unavailable", systemImage: "shippingbox")
        } description: {
            Text("Pull to refresh, or check that this account can access the selected Property.")
        }
    }

    private func filteredAssets(_ assets: [TrackedEquipmentState]) -> [TrackedEquipmentState] {
        let available = Dictionary(uniqueKeysWithValues: assets.map { ($0.id, $0) })
        return filteredInventory(model.selectedPropertyEquipment).compactMap { item in
            guard let asset = available[item.id] else { return nil }
            return model.trackedState(for: item.id) ?? asset
        }
    }

    private func filteredInventory(_ equipment: [AreaEquipment]) -> [AreaEquipment] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return equipment.filter { item in
            if let status = serviceFilter.status, item.status != status {
                return false
            }
            if !areaFilterID.isEmpty, item.areaId != areaFilterID {
                return false
            }
            if !trimmedQuery.isEmpty {
                let values = [
                    item.name,
                    item.kind,
                    item.manufacturer,
                    item.model,
                    item.serialNumber,
                    item.notes,
                    model.areaName(for: item.areaId),
                ].compactMap { $0 }
                guard values.contains(where: {
                    $0.localizedCaseInsensitiveContains(trimmedQuery)
                }) else {
                    return false
                }
            }

            let tracked = model.trackedState(for: item.id)
            switch conditionFilter {
            case .all:
                return true
            case .attention:
                return needsAttention(item)
            case .moving:
                return tracked?.position?.movementState == "moving"
            case .lowBattery:
                return (tracked?.tag?.batteryPercent ?? 101) <= 20
            case .notSeen:
                guard let tracked else { return false }
                return ["last-known", "stale", "unknown"].contains(
                    tracked.position?.freshnessState ?? "unknown"
                )
            }
        }.sorted {
            let leftNeedsAttention = needsAttention($0)
            let rightNeedsAttention = needsAttention($1)
            if leftNeedsAttention != rightNeedsAttention {
                return leftNeedsAttention
            }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private func needsAttention(_ item: AreaEquipment) -> Bool {
        if item.status == "out-of-service" { return true }
        guard let tracked = model.trackedState(for: item.id) else { return false }
        if (tracked.tag?.batteryPercent ?? 101) <= 20 { return true }
        return ["stale", "unknown"].contains(
            tracked.position?.freshnessState ?? "unknown"
        )
    }

    private var filtersAreActive: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || serviceFilter != .all
            || !areaFilterID.isEmpty
            || conditionFilter != .all
    }

    private func resetFilters() {
        query = ""
        serviceFilter = .all
        areaFilterID = ""
        conditionFilter = .all
    }

    private func displayCoordinate(
        for asset: TrackedEquipmentState,
        in snapshot: TrackingMapSnapshot
    ) -> CLLocationCoordinate2D? {
        if let coordinate = asset.position?.coordinate {
            return coordinate.clCoordinate
        }
        guard let zoneID = asset.position?.zoneId,
              let zone = snapshot.zones.first(where: { $0.id == zoneID }) else {
            return nil
        }
        if let location = zone.location { return location.clCoordinate }
        guard !zone.polygon.isEmpty else { return nil }
        return CLLocationCoordinate2D(
            latitude: zone.polygon.map(\.latitude).reduce(0, +) / Double(zone.polygon.count),
            longitude: zone.polygon.map(\.longitude).reduce(0, +) / Double(zone.polygon.count)
        )
    }

    private func zoneName(
        for asset: TrackedEquipmentState,
        snapshot: TrackingMapSnapshot
    ) -> String? {
        guard let zoneID = asset.position?.zoneId else { return nil }
        return snapshot.zones.first { $0.id == zoneID }?.name
    }

    private func markerAccessibility(
        _ asset: TrackedEquipmentState,
        snapshot: TrackingMapSnapshot
    ) -> String {
        let location = TrackingPresentation.locationText(
            asset,
            zoneName: zoneName(for: asset, snapshot: snapshot)
        )
        return "\(asset.equipment.name), \(location)"
    }
}

private struct InventorySummaryMetric: View {
    let value: String
    let label: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
                .frame(width: 28, height: 28)
                .background(color.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(value)
                    .font(.headline.monospacedDigit())
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(StugaTheme.muted)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value) \(label)")
    }
}

private struct MemberLocationSharingBanner: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var controller: MemberLocationSharingController

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: controller.isSharing
                ? "location.fill"
                : "location.circle")
                .foregroundStyle(controller.isSharing ? StugaTheme.success : StugaTheme.action)
            VStack(alignment: .leading, spacing: 2) {
                Text(controller.isSharing ? controller.status : "Show me on the Property map?")
                    .font(.subheadline.weight(.semibold))
                Text(controller.isSharing
                    ? "Sharing stops when Stuga leaves the foreground or after one hour."
                    : "Optional foreground sharing; no location trail is kept.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
            Spacer()
            if controller.isSharing {
                Button("Stop") {
                    Task { await model.stopMemberLocationSharing() }
                }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
            } else {
                Button("Share") {
                    Task { await model.startMemberLocationSharing() }
                }
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: 44)
            }
        }
        .padding(12)
        .background(StugaTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(StugaTheme.line)
        }
    }
}

private struct MemberLocationMarker: View {
    let member: PropertyMemberLocation

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: "person.fill")
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(StugaTheme.action)
                .clipShape(Circle())
                .overlay { Circle().stroke(.white, lineWidth: 2) }
                .shadow(radius: 2, y: 1)
            Text(member.memberLabel)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(.regularMaterial)
                .clipShape(Capsule())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(member.memberLabel), shared location, accuracy approximately "
                + "\(Int(member.horizontalAccuracyMeters.rounded())) metres"
        )
    }
}

private struct EquipmentMarker: View {
    let asset: TrackedEquipmentState
    let selected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        ZStack {
            if asset.position?.freshnessState == "live", !reduceMotion {
                Circle()
                    .fill(StugaTheme.success.opacity(0.25))
                    .frame(width: pulsing ? 46 : 28, height: pulsing ? 46 : 28)
                    .opacity(pulsing ? 0 : 1)
            }
            Image(systemName: markerSymbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: selected ? 38 : 32, height: selected ? 38 : 32)
                .background(markerColor)
                .clipShape(Circle())
                .overlay { Circle().stroke(.white, lineWidth: selected ? 3 : 2) }
                .shadow(radius: 2, y: 1)
        }
        .onAppear {
            guard asset.position?.freshnessState == "live", !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.8).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }

    private var markerColor: Color {
        switch asset.position?.freshnessState {
        case "live": StugaTheme.success
        case "recent": StugaTheme.action
        case "last-known", "stale": StugaTheme.muted
        default: StugaTheme.strongLine
        }
    }

    private var markerSymbol: String {
        asset.position?.movementState == "moving" ? "arrow.up.right" : "wrench.and.screwdriver.fill"
    }
}

private struct EquipmentRow: View {
    let asset: TrackedEquipmentState
    let zoneName: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "wrench.and.screwdriver")
                .foregroundStyle(StugaTheme.action)
                .frame(width: 32, height: 32)
                .background(StugaTheme.action.opacity(0.1))
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(asset.equipment.name)
                    .font(.subheadline.weight(.semibold))
                Text(TrackingPresentation.locationText(asset, zoneName: zoneName))
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
                    .lineLimit(1)
            }
            Spacer()
            if let battery = asset.tag?.batteryPercent {
                Label("\(battery)%", systemImage: battery <= 20 ? "battery.25" : "battery.75")
                    .labelStyle(.titleAndIcon)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(battery <= 20 ? StugaTheme.warning : StugaTheme.muted)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(StugaTheme.muted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct InventoryEquipmentRow: View {
    let equipment: AreaEquipment
    let areaName: String?
    let tracked: TrackedEquipmentState?
    let trackingAreaName: String?

    var body: some View {
        StugaCard {
            HStack(spacing: 12) {
                Image(systemName: statusSymbol)
                    .foregroundStyle(statusColor)
                    .frame(width: 38, height: 38)
                    .background(statusColor.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(equipment.name)
                        .font(.subheadline.weight(.semibold))
                    Text("\(equipment.kind.capitalized) · \(areaName ?? "Unknown area")")
                        .font(.caption)
                        .foregroundStyle(StugaTheme.muted)
                        .lineLimit(1)
                    if let tracked {
                        Text(
                            TrackingPresentation.locationText(
                                tracked,
                                zoneName: trackingAreaName
                            )
                        )
                        .font(.caption2)
                        .foregroundStyle(StugaTheme.muted)
                        .lineLimit(1)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(statusText)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(statusColor)
                    if let battery = tracked?.tag?.batteryPercent {
                        Label("\(battery)%", systemImage: battery <= 20 ? "battery.25" : "battery.75")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(battery <= 20 ? StugaTheme.warning : StugaTheme.muted)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(StugaTheme.muted)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var statusText: String {
        switch equipment.status {
        case "active": "Active"
        case "out-of-service": "Out of service"
        case "retired": "Retired"
        default: equipment.status.capitalized
        }
    }

    private var statusSymbol: String {
        switch equipment.status {
        case "active": "shippingbox.fill"
        case "out-of-service": "exclamationmark.square.fill"
        case "retired": "archivebox"
        default: "shippingbox"
        }
    }

    private var statusColor: Color {
        switch equipment.status {
        case "active": StugaTheme.action
        case "out-of-service": StugaTheme.warning
        default: StugaTheme.muted
        }
    }
}

private extension GeoCoordinate {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}
