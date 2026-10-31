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

    private enum AddLocationChoice {
        case currentLocation
        case propertyMap
        case withoutMapPin
    }

    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var tracker: MobileTrackingController
    @State private var cameraPosition: MapCameraPosition = .automatic
    @State private var selectedEquipmentID: String?
    @State private var displayMode: DisplayMode = .list
    @State private var query = ""
    @State private var serviceFilter: ServiceFilter = .all
    @State private var placementFilterID = ""
    @State private var conditionFilter: ConditionFilter = .all
    @State private var showingScanner = false
    @State private var showingEquipmentEditor = false
    @State private var showingAddLocationChoice = false
    @State private var showingAddMapPicker = false
    @State private var addEquipmentCoordinate: GeoCoordinate?
    @State private var openEditorAfterMapPicker = false
    @StateObject private var addLocation = EquipmentCurrentLocationProvider()

    var body: some View {
        NavigationStack {
            ZStack {
                StuguScreenBackground()
                if model.propertyInventory == nil {
                    unavailable
                } else if displayMode == .map {
                    mapContent(snapshot: model.trackingSnapshot)
                } else {
                    inventoryList
                }
            }
            .navigationTitle("Inventory")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if !model.selectedPropertyReadOnly {
                            Button {
                                beginAddingEquipment()
                            } label: {
                                Label("Add equipment", systemImage: "plus")
                            }
                            .disabled(!model.inventoryMutationsAvailable)
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
                state: model.trackedState(for: equipment.id)
                    ?? TrackedEquipmentState(equipment: equipment),
                snapshot: model.trackingSnapshot,
                tracker: tracker
            )
            .environmentObject(model)
        }
        .sheet(isPresented: $showingScanner) {
            EquipmentScannerSheet { value in
                guard let code = EquipmentQRCode.parse(value) else {
                    model.errorMessage = "This is not a valid Stugu equipment tag."
                    return
                }
                Task {
                    if let state = await model.resolveEquipmentCode(code) {
                        selectedEquipmentID = state.id
                    }
                }
            }
        }
        .sheet(isPresented: $showingEquipmentEditor, onDismiss: {
            addEquipmentCoordinate = nil
        }) {
            EquipmentEditorView(
                equipment: nil,
                initialCoordinate: addEquipmentCoordinate
            )
                .environmentObject(model)
        }
        .sheet(isPresented: $showingAddMapPicker, onDismiss: {
            if openEditorAfterMapPicker {
                openEditorAfterMapPicker = false
                showingEquipmentEditor = true
            }
        }) {
            EquipmentLocationMapPicker(
                propertyName: model.selectedProperty?.name ?? "Property",
                areas: model.selectedPropertyAreas,
                homes: model.selectedPropertyHouses,
                boundary: propertyBoundary(snapshot: model.trackingSnapshot),
                equipment: model.selectedPropertyEquipment,
                initialCoordinate: nil
            ) { coordinate in
                addEquipmentCoordinate = coordinate
                openEditorAfterMapPicker = true
            }
        }
        .confirmationDialog(
            "Use your location for this equipment?",
            isPresented: $showingAddLocationChoice,
            titleVisibility: .visible
        ) {
            Button("Use current location") {
                handleAddLocationChoice(.currentLocation)
            }
            Button("Choose on Property map") {
                handleAddLocationChoice(.propertyMap)
            }
            Button("Add without map pin") {
                handleAddLocationChoice(.withoutMapPin)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Stugu can request your location once or let you choose a point "
                    + "on the map. This does not start live location sharing."
            )
        }
        .alert("Current location unavailable", isPresented: Binding(
            get: { addLocation.errorMessage != nil },
            set: { if !$0 { addLocation.clearError() } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(addLocation.errorMessage ?? "")
        }
        .onChange(of: addLocation.coordinate) { _, coordinate in
            guard let coordinate else { return }
            addEquipmentCoordinate = coordinate
            showingEquipmentEditor = true
        }
        .onChange(of: model.selectedPropertyID) {
            displayMode = .list
            cameraPosition = .automatic
            resetFilters()
        }
        .onChange(of: displayMode) { _, mode in
            if mode == .map {
                cameraPosition = .automatic
            }
        }
        .onChange(of: model.propertyInventory?.syncToken) {
            if !placementFilterID.isEmpty,
               !validPlacementFilterIDs.contains(placementFilterID) {
                placementFilterID = ""
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

    private func mapContent(snapshot: TrackingMapSnapshot?) -> some View {
        let zones = model.selectedPropertyAreas.isEmpty
            ? snapshot?.zones ?? []
            : model.selectedPropertyAreas
        let boundary = propertyBoundary(snapshot: snapshot)
        let states = filteredEquipmentStates(snapshot?.equipment ?? [])
        let selected = states.first { $0.id == selectedEquipmentID }
        return VStack(spacing: 0) {
            VStack(spacing: 10) {
                displayModePicker
                compactFilterControls
                mutationGate
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
                if boundary.count >= 3 {
                    MapPolygon(coordinates: boundary.map(\.clCoordinate))
                        .foregroundStyle(StuguTheme.action.opacity(0.05))
                        .stroke(StuguTheme.action.opacity(0.55), lineWidth: 1.5)
                }
                ForEach(zones) { zone in
                    if zone.polygon.count >= 3 {
                        MapPolygon(coordinates: zone.polygon.map(\.clCoordinate))
                            .foregroundStyle(StuguTheme.action.opacity(0.08))
                            .stroke(StuguTheme.action.opacity(0.6), lineWidth: 1.25)
                    }
                    if let coordinate = mapCoordinate(for: zone) {
                        Annotation(zone.name, coordinate: coordinate) {
                            PropertyMapContextLabel(
                                name: zone.name,
                                systemImage: "square.dashed"
                            )
                            .accessibilityLabel("Property area, \(zone.name)")
                        }
                    }
                }
                if let selected,
                   let position = selected.position,
                   let coordinate = position.coordinate,
                   let radius = position.uncertaintyRadiusMeters {
                    MapCircle(center: coordinate.clCoordinate, radius: radius)
                        .foregroundStyle(StuguTheme.action.opacity(0.12))
                        .stroke(StuguTheme.action.opacity(0.75), lineWidth: 1.5)
                }
                if let selected,
                   let zoneID = selected.position?.zoneId ?? selected.equipment.areaId,
                   let zone = zones.first(where: { $0.id == zoneID }),
                   zone.polygon.count >= 3 {
                    MapPolygon(coordinates: zone.polygon.map(\.clCoordinate))
                        .foregroundStyle(StuguTheme.warning.opacity(0.14))
                        .stroke(StuguTheme.warning, lineWidth: 2)
                }
                ForEach(model.selectedPropertyHouses) { home in
                    if let coordinate = mapCoordinate(for: home) {
                        Annotation(home.name, coordinate: coordinate) {
                            PropertyMapContextLabel(
                                name: home.name,
                                systemImage: "house.fill"
                            )
                            .accessibilityLabel("Home, \(home.name)")
                        }
                    }
                }
                ForEach(snapshot?.members ?? []) { member in
                    MapCircle(
                        center: member.coordinate.clCoordinate,
                        radius: member.horizontalAccuracyMeters
                    )
                    .foregroundStyle(StuguTheme.action.opacity(0.08))
                    .stroke(StuguTheme.action.opacity(0.5), lineWidth: 1)
                    Annotation(member.memberLabel, coordinate: member.coordinate.clCoordinate) {
                        MemberLocationMarker(member: member)
                    }
                }
                ForEach(states) { state in
                    if let coordinate = displayCoordinate(for: state, zones: zones) {
                        Annotation(state.equipment.name, coordinate: coordinate) {
                            Button {
                                selectedEquipmentID = state.id
                            } label: {
                                EquipmentMarker(
                                    state: state,
                                    selected: selectedEquipmentID == state.id
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(markerAccessibility(state, zones: zones))
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
                        color: StuguTheme.success
                    )
                    .padding(12)
                }
            }
            .frame(minHeight: 280)

            equipmentTray(states, zones: zones)
                .frame(maxHeight: 260)
        }
        .refreshable {
            if snapshot == nil {
                await model.refresh()
            } else {
                await model.refreshTracking()
            }
        }
    }

    private var inventoryList: some View {
        let equipment = filteredInventory(model.selectedPropertyEquipment)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                inventoryOverview
                mutationGate

                if mapAvailable {
                    displayModePicker
                }

                inventoryControls

                HStack {
                    Text(
                        "Showing \(equipment.count) item"
                            + (equipment.count == 1 ? "" : "s")
                    )
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
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
                           !model.selectedPropertyReadOnly {
                            Button {
                                beginAddingEquipment()
                            } label: {
                                Label("Add equipment", systemImage: "plus")
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .frame(maxWidth: 360)
                            .disabled(!model.inventoryMutationsAvailable)
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
        let placedCount = equipment.filter {
            $0.areaId != nil || $0.houseId != nil || $0.location != nil
        }.count

        return StuguCard {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.selectedProperty?.name ?? "Property")
                        .font(.headline)
                    Text("Property-wide equipment catalogue")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
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
                        color: StuguTheme.action
                    )
                    InventorySummaryMetric(
                        value: "\(attentionCount)",
                        label: "Needs attention",
                        systemImage: "wrench.adjustable",
                        color: attentionCount > 0
                            ? StuguTheme.warning
                            : model.trackingSnapshot == nil
                                ? StuguTheme.muted
                                : StuguTheme.success
                    )
                    InventorySummaryMetric(
                        value: "\(placedCount)",
                        label: "Placed",
                        systemImage: "mappin.and.ellipse",
                        color: StuguTheme.muted
                    )
                    InventorySummaryMetric(
                        value: model.trackingSnapshot == nil ? "—" : "\(trackedCount)",
                        label: model.trackingSnapshot == nil ? "Live map off" : "BLE tracked",
                        systemImage: "dot.radiowaves.left.and.right",
                        color: StuguTheme.muted
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
                    .foregroundStyle(StuguTheme.muted)
                    .accessibilityHidden(true)
                TextField("Search name, kind, serial or notes", text: $query)
                    .submitLabel(.search)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(StuguTheme.muted)
                    }
                    .accessibilityLabel("Clear inventory search")
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 46)
            .background(StuguTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: StuguTheme.Radius.control, style: .continuous)
                    .stroke(StuguTheme.line)
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
                        placementFilterID = ""
                    } label: {
                        if placementFilterID.isEmpty {
                            Label("All locations", systemImage: "checkmark")
                        } else {
                            Text("All locations")
                        }
                    }
                    ForEach(model.selectedPropertyAreas.sorted {
                        $0.name.localizedStandardCompare($1.name) == .orderedAscending
                    }) { area in
                        Button {
                            placementFilterID = "area:\(area.id)"
                        } label: {
                            if placementFilterID == "area:\(area.id)" {
                                Label("Area · \(area.name)", systemImage: "checkmark")
                            } else {
                                Text("Area · \(area.name)")
                            }
                        }
                    }
                    ForEach(model.selectedPropertyHouses) { home in
                        Button {
                            placementFilterID = "home:\(home.id)"
                        } label: {
                            if placementFilterID == "home:\(home.id)" {
                                Label("Home · \(home.name)", systemImage: "checkmark")
                            } else {
                                Text("Home · \(home.name)")
                            }
                        }
                    }
                    Button {
                        placementFilterID = "unassigned"
                    } label: {
                        if placementFilterID == "unassigned" {
                            Label("Unassigned", systemImage: "checkmark")
                        } else {
                            Text("Unassigned")
                        }
                    }
                } label: {
                    filterChip(
                        placementFilterID.isEmpty
                            ? "Location: All"
                            : placementFilterName,
                        systemImage: "mappin.and.ellipse"
                    )
                }
                .accessibilityLabel(
                    "Expected location filter, "
                        + (placementFilterID.isEmpty
                            ? "all"
                            : placementFilterName)
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
            .foregroundStyle(StuguTheme.ink)
            .lineLimit(1)
            .padding(.horizontal, 11)
            .frame(minHeight: 44)
            .background(StuguTheme.surface)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(StuguTheme.strongLine, lineWidth: 1)
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
                .foregroundStyle(StuguTheme.muted)
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
                placementName: model.equipmentPlacementName(item),
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
        if model.selectedPropertyReadOnly {
            return "No equipment is available to this account in the selected Property."
        }
        return "Add the first item, then print or scan its Stugu QR tag."
    }

    @ViewBuilder
    private var mutationGate: some View {
        if !model.inventoryMutationsAvailable {
            Label {
                Text(LocalizedStringKey(
                    model.selectedPropertyReadOnly
                        ? "This Property is read-only. Inventory can be viewed but not changed."
                        : "Reconnect to Stugu before changing inventory."
                ))
            } icon: {
                Image(systemName: model.selectedPropertyReadOnly ? "eye" : "wifi.slash")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(StuguTheme.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var observationPrompt: some View {
        HStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(StuguTheme.action)
            VStack(alignment: .leading, spacing: 2) {
                Text("Help locate your equipment")
                    .font(.subheadline.weight(.semibold))
                Text("Opt in to nearby Bluetooth detections. iOS background detections are opportunistic.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            }
            Spacer()
            Button("Turn on") {
                Task { await model.setEquipmentObservationEnabled(true) }
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: 44)
        }
        .padding(12)
        .background(StuguTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous)
                .stroke(StuguTheme.line)
        }
    }

    private var observerStatus: some View {
        HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(StuguTheme.success)
            Text(tracker.bluetoothStatus)
                .font(.caption.weight(.semibold))
            Spacer()
            if tracker.queueStatus.queuedCount > 0 {
                Text("\(tracker.queueStatus.queuedCount) saved")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            }
        }
    }

    private func equipmentTray(
        _ states: [TrackedEquipmentState],
        zones: [PropertyArea]
    ) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if states.isEmpty {
                    VStack(spacing: 6) {
                        Label("No mapped items match", systemImage: "map")
                            .font(.subheadline.weight(.semibold))
                        Text("Change the inventory filters or return to List.")
                            .font(.caption)
                            .foregroundStyle(StuguTheme.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(20)
                }
                let unknown = states.filter {
                    displayCoordinate(for: $0, zones: zones) == nil
                }
                if !unknown.isEmpty {
                    HStack {
                        Label("Unknown location", systemImage: "questionmark.circle")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StuguTheme.muted)
                        Spacer()
                        Text("\(unknown.count)")
                            .font(.caption.monospacedDigit())
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                ForEach(states) { state in
                    Button {
                        selectedEquipmentID = state.id
                    } label: {
                        EquipmentRow(
                            state: state,
                            zoneName: zoneName(for: state, zones: zones)
                        )
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(StuguTheme.line).padding(.leading, 56)
                }
            }
        }
        .background(StuguTheme.surface)
    }

    private var unavailable: some View {
        ContentUnavailableView {
            Label("Inventory unavailable", systemImage: "shippingbox")
        } description: {
            Text("Pull to refresh, or check that this account can access the selected Property.")
        }
    }

    private func filteredEquipmentStates(_ states: [TrackedEquipmentState]) -> [TrackedEquipmentState] {
        let available = Dictionary(uniqueKeysWithValues: states.map { ($0.id, $0) })
        return filteredInventory(model.selectedPropertyEquipment).map { item in
            model.trackedState(for: item.id)
                ?? available[item.id]
                ?? TrackedEquipmentState(equipment: item)
        }
    }

    private func filteredInventory(_ equipment: [AreaEquipment]) -> [AreaEquipment] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return equipment.filter { item in
            if let status = serviceFilter.status, item.status != status {
                return false
            }
            if !placementFilterID.isEmpty,
               placementFilterKey(for: item) != placementFilterID {
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
                    model.equipmentPlacementName(item),
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
                return (tracked?.endpoint?.reportedBatteryPercent ?? 101) <= 20
            case .notSeen:
                guard let tracked else { return false }
                return ["aging", "stale", "unknown"].contains(
                    tracked.position?.freshness ?? "unknown"
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
        if (tracked.endpoint?.reportedBatteryPercent ?? 101) <= 20 { return true }
        return ["stale", "unknown"].contains(
            tracked.position?.freshness ?? "unknown"
        )
    }

    private var mapAvailable: Bool {
        if model.trackingSnapshot != nil { return true }
        if propertyBoundary(snapshot: nil).count >= 3 { return true }
        if model.selectedPropertyAreas.contains(where: {
            $0.location != nil || !$0.polygon.isEmpty
        }) {
            return true
        }
        if model.selectedPropertyHouses.contains(where: {
            $0.mapPlacement != nil || $0.location != nil
        }) {
            return true
        }
        return model.selectedPropertyEquipment.contains { item in
            if item.location != nil { return true }
            if let houseID = item.houseId,
               let home = model.selectedPropertyHouses.first(where: { $0.id == houseID }) {
                return home.mapPlacement != nil || home.location != nil
            }
            if let areaID = item.areaId,
               let area = model.selectedPropertyAreas.first(where: { $0.id == areaID }) {
                return area.location != nil || !area.polygon.isEmpty
            }
            return false
        }
    }

    private var filtersAreActive: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || serviceFilter != .all
            || !placementFilterID.isEmpty
            || conditionFilter != .all
    }

    private func resetFilters() {
        query = ""
        serviceFilter = .all
        placementFilterID = ""
        conditionFilter = .all
    }

    private func beginAddingEquipment() {
        guard model.inventoryMutationsAvailable else {
            model.errorMessage = model.selectedPropertyReadOnly
                ? "This Property is read-only. Inventory can be viewed but not changed."
                : "Reconnect to Stugu before changing inventory."
            return
        }
        addEquipmentCoordinate = nil
        openEditorAfterMapPicker = false
        addLocation.clearError()
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            showingAddLocationChoice = true
        }
    }

    private func handleAddLocationChoice(_ choice: AddLocationChoice) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            switch choice {
            case .currentLocation:
                addLocation.request()
            case .propertyMap:
                showingAddMapPicker = true
            case .withoutMapPin:
                showingEquipmentEditor = true
            }
        }
    }

    private func propertyBoundary(snapshot: TrackingMapSnapshot?) -> [GeoCoordinate] {
        if let boundary = snapshot?.settings.propertyBoundary, !boundary.isEmpty {
            return boundary
        }
        return model.trackingSettings?.propertyBoundary ?? []
    }

    private func mapCoordinate(for area: PropertyArea) -> CLLocationCoordinate2D? {
        if let location = area.location {
            return location.clCoordinate
        }
        guard !area.polygon.isEmpty else { return nil }
        return CLLocationCoordinate2D(
            latitude: area.polygon.map(\.latitude).reduce(0, +)
                / Double(area.polygon.count),
            longitude: area.polygon.map(\.longitude).reduce(0, +)
                / Double(area.polygon.count)
        )
    }

    private func mapCoordinate(for home: House) -> CLLocationCoordinate2D? {
        if let placement = home.mapPlacement {
            return CLLocationCoordinate2D(
                latitude: placement.latitude,
                longitude: placement.longitude
            )
        }
        guard let location = home.location else { return nil }
        return CLLocationCoordinate2D(
            latitude: location.latitude,
            longitude: location.longitude
        )
    }

    private func displayCoordinate(
        for state: TrackedEquipmentState,
        zones: [PropertyArea]
    ) -> CLLocationCoordinate2D? {
        if let position = state.position,
           position.freshness != "unknown",
           let coordinate = position.coordinate {
            return coordinate.clCoordinate
        }
        if let zoneID = state.position?.zoneId,
           let zone = zones.first(where: { $0.id == zoneID }) {
            if let location = zone.location { return location.clCoordinate }
            if !zone.polygon.isEmpty {
                return CLLocationCoordinate2D(
                    latitude: zone.polygon.map(\.latitude).reduce(0, +)
                        / Double(zone.polygon.count),
                    longitude: zone.polygon.map(\.longitude).reduce(0, +)
                        / Double(zone.polygon.count)
                )
            }
        }
        if let location = state.equipment.location {
            return location.clCoordinate
        }
        if let houseID = state.equipment.houseId,
           let home = model.selectedPropertyHouses.first(where: { $0.id == houseID }) {
            if let placement = home.mapPlacement {
                return CLLocationCoordinate2D(
                    latitude: placement.latitude,
                    longitude: placement.longitude
                )
            }
            if let location = home.location {
                return CLLocationCoordinate2D(
                    latitude: location.latitude,
                    longitude: location.longitude
                )
            }
        }
        guard let areaID = state.equipment.areaId,
              let area = model.selectedPropertyAreas.first(where: { $0.id == areaID }) else {
            return nil
        }
        if let location = area.location {
            return location.clCoordinate
        }
        guard !area.polygon.isEmpty else { return nil }
        return CLLocationCoordinate2D(
            latitude: area.polygon.map(\.latitude).reduce(0, +)
                / Double(area.polygon.count),
            longitude: area.polygon.map(\.longitude).reduce(0, +)
                / Double(area.polygon.count)
        )
    }

    private func zoneName(
        for state: TrackedEquipmentState,
        zones: [PropertyArea]
    ) -> String? {
        guard let zoneID = state.position?.zoneId else { return nil }
        return zones.first { $0.id == zoneID }?.name
    }

    private func markerAccessibility(
        _ state: TrackedEquipmentState,
        zones: [PropertyArea]
    ) -> String {
        let location: String
        if state.position == nil {
            if state.equipment.location != nil {
                location = "Pinned expected location"
            } else if state.equipment.houseId != nil {
                location = "Expected at assigned Home"
            } else if state.equipment.areaId != nil {
                location = "Expected in assigned area"
            } else {
                location = "Unknown location"
            }
        } else {
            location = TrackingPresentation.locationText(
                state,
                zoneName: zoneName(for: state, zones: zones)
            )
        }
        return "\(state.equipment.name), \(location)"
    }

    private var validPlacementFilterIDs: Set<String> {
        Set(
            ["", "unassigned"]
                + model.selectedPropertyAreas.map { "area:\($0.id)" }
                + model.selectedPropertyHouses.map { "home:\($0.id)" }
        )
    }

    private var placementFilterName: String {
        if placementFilterID == "unassigned" { return "Unassigned" }
        if placementFilterID.hasPrefix("area:") {
            let id = String(placementFilterID.dropFirst("area:".count))
            return model.areaName(for: id).map { "Area · \($0)" } ?? "Area"
        }
        if placementFilterID.hasPrefix("home:") {
            let id = String(placementFilterID.dropFirst("home:".count))
            return model.houseName(for: id).map { "Home · \($0)" } ?? "Home"
        }
        return "Location"
    }

    private func placementFilterKey(for equipment: AreaEquipment) -> String {
        if let areaID = equipment.areaId { return "area:\(areaID)" }
        if let houseID = equipment.houseId { return "home:\(houseID)" }
        return "unassigned"
    }
}

private struct PropertyMapContextLabel: View {
    let name: String
    let systemImage: String

    var body: some View {
        Label(name, systemImage: systemImage)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .foregroundStyle(StuguTheme.ink)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.small, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: StuguTheme.Radius.small, style: .continuous)
                    .stroke(StuguTheme.strongLine, lineWidth: 1)
            }
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
                .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.control, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(value)
                    .font(.headline.monospacedDigit())
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(StuguTheme.muted)
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
                .foregroundStyle(controller.isSharing ? StuguTheme.success : StuguTheme.action)
            VStack(alignment: .leading, spacing: 2) {
                Text(controller.isSharing ? controller.status : "Show me on the Property map?")
                    .font(.subheadline.weight(.semibold))
                Text(controller.isSharing
                    ? "Sharing stops when Stugu leaves the foreground or after one hour."
                    : "Optional foreground sharing; no location trail is kept.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
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
        .background(StuguTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous)
                .stroke(StuguTheme.line)
        }
    }
}

private struct MemberLocationMarker: View {
    let member: PropertyMemberLocation

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: "person.fill")
                .foregroundStyle(StuguTheme.actionText)
                .frame(width: 34, height: 34)
                .background(StuguTheme.action)
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
    let state: TrackedEquipmentState
    let selected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        ZStack {
            if state.position?.freshness == "live", !reduceMotion {
                Circle()
                    .fill(StuguTheme.success.opacity(0.25))
                    .frame(width: pulsing ? 46 : 28, height: pulsing ? 46 : 28)
                    .opacity(pulsing ? 0 : 1)
            }
            Image(systemName: markerSymbol)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(StuguTheme.actionText)
                .frame(width: selected ? 38 : 32, height: selected ? 38 : 32)
                .background(markerColor)
                .clipShape(Circle())
                .overlay { Circle().stroke(.white, lineWidth: selected ? 3 : 2) }
                .shadow(radius: 2, y: 1)
        }
        .onAppear {
            guard state.position?.freshness == "live", !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.8).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }

    private var markerColor: Color {
        switch state.position?.freshness {
        case "live": StuguTheme.success
        case "recent": StuguTheme.action
        case "aging", "stale": StuguTheme.muted
        default: StuguTheme.strongLine
        }
    }

    private var markerSymbol: String {
        state.position?.movementState == "moving" ? "arrow.up.right" : "wrench.and.screwdriver.fill"
    }
}

private struct EquipmentRow: View {
    let state: TrackedEquipmentState
    let zoneName: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "wrench.and.screwdriver")
                .foregroundStyle(StuguTheme.action)
                .frame(width: 32, height: 32)
                .background(StuguTheme.action.opacity(0.1))
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(state.equipment.name)
                    .font(.subheadline.weight(.semibold))
                Text(locationText)
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                    .lineLimit(1)
            }
            Spacer()
            if let battery = state.endpoint?.reportedBatteryPercent {
                Label("\(battery)%", systemImage: battery <= 20 ? "battery.25" : "battery.75")
                    .labelStyle(.titleAndIcon)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(battery <= 20 ? StuguTheme.warning : StuguTheme.muted)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(StuguTheme.muted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var locationText: String {
        guard state.position == nil else {
            return TrackingPresentation.locationText(state, zoneName: zoneName)
        }
        if state.equipment.location != nil { return "Pinned expected location" }
        if state.equipment.houseId != nil { return "Expected at assigned Home" }
        if state.equipment.areaId != nil { return "Expected in assigned area" }
        return "Unknown location"
    }
}

private struct InventoryEquipmentRow: View {
    let equipment: AreaEquipment
    let placementName: String
    let tracked: TrackedEquipmentState?
    let trackingAreaName: String?

    var body: some View {
        StuguCard {
            HStack(spacing: 12) {
                Image(systemName: statusSymbol)
                    .foregroundStyle(statusColor)
                    .frame(width: 38, height: 38)
                    .background(statusColor.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(equipment.name)
                        .font(.subheadline.weight(.semibold))
                    Text("\(equipment.kind.capitalized) · \(placementName)")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                        .lineLimit(1)
                    if let tracked {
                        Text(
                            TrackingPresentation.locationText(
                                tracked,
                                zoneName: trackingAreaName
                            )
                        )
                        .font(.caption2)
                        .foregroundStyle(StuguTheme.muted)
                        .lineLimit(1)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(statusText)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(statusColor)
                    if let battery = tracked?.endpoint?.reportedBatteryPercent {
                        Label("\(battery)%", systemImage: battery <= 20 ? "battery.25" : "battery.75")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(battery <= 20 ? StuguTheme.warning : StuguTheme.muted)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(StuguTheme.muted)
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
        case "active": StuguTheme.action
        case "out-of-service": StuguTheme.warning
        default: StuguTheme.muted
        }
    }
}

private extension GeoCoordinate {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

private extension TrackingEndpoint {
    var reportedBatteryPercent: Int? {
        guard let raw = telemetry["batteryPercent"],
              case let .number(value) = raw else { return nil }
        return Int(value)
    }
}
