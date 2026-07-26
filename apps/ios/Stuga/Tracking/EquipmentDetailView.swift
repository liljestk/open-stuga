import SwiftUI

enum TrackingPresentation {
    static func locationText(
        _ asset: TrackedEquipmentState,
        zoneName: String?
    ) -> String {
        guard let position = asset.position else { return "Unknown location" }
        switch position.positionType {
        case "nearby-live":
            return "Live nearby"
        case "confirmed-zone":
            return zoneName.map { "In or near \($0)" } ?? "Confirmed area"
        case "estimated-coordinate":
            return "Estimated location"
        case "last-known":
            return relativeLastSeen(position) ?? "Last known location"
        default:
            return "Unknown location"
        }
    }

    static func relativeLastSeen(_ position: AssetPositionEstimate) -> String? {
        guard let date = position.lastObservedDate else { return nil }
        return "Last observed \(date.formatted(.relative(presentation: .named)))"
    }

    static func confidence(_ value: String) -> String {
        value.prefix(1).uppercased() + value.dropFirst()
    }
}

struct EquipmentDetailView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var tracker: MobileTrackingController
    let asset: TrackedEquipmentState
    let snapshot: TrackingMapSnapshot?
    @Environment(\.dismiss) private var dismiss
    @State private var showingFind = false
    @State private var showingEditor = false

    init(
        asset: TrackedEquipmentState,
        snapshot: TrackingMapSnapshot?,
        tracker: MobileTrackingController
    ) {
        self.asset = asset
        self.snapshot = snapshot
        self.tracker = tracker
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    identity
                    equipmentDetails
                    location
                    if let tag = currentAsset.tag { tagStatus(tag) }
                    evidence
                    findAction
                    EquipmentOperationsView(equipment: equipment)
                }
                .padding(16)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            .background(StugaScreenBackground())
            .navigationTitle(equipment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showingFind) {
                FindNearbyView(asset: currentAsset, tracker: tracker)
                    .environmentObject(model)
            }
            .sheet(isPresented: $showingEditor) {
                EquipmentEditorView(equipment: equipment)
                    .environmentObject(model)
            }
        }
    }

    private var equipmentDetails: some View {
        section("Inventory details") {
            valueRow("Service state", serviceState)
            if let areaName = model.areaName(for: equipment.areaId)
                ?? snapshot?.zones.first(where: { $0.id == equipment.areaId })?.name {
                valueRow("Assigned area", areaName)
            }
            if let manufacturer = equipment.manufacturer {
                valueRow("Manufacturer", manufacturer)
            }
            if let equipmentModel = equipment.model {
                valueRow("Model", equipmentModel)
            }
            if let serialNumber = equipment.serialNumber {
                valueRow("Serial number", serialNumber)
            }
            if let notes = equipment.notes {
                Divider().overlay(StugaTheme.line)
                Text(notes)
                    .font(.subheadline)
            }
            if !model.isReadOnly {
                Divider().overlay(StugaTheme.line)
                Button {
                    showingEditor = true
                } label: {
                    Label("Edit inventory record", systemImage: "square.and.pencil")
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    private var identity: some View {
        StugaCard {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.title2)
                    .foregroundStyle(StugaTheme.action)
                    .frame(width: 48, height: 48)
                    .background(StugaTheme.action.opacity(0.1))
                    .clipShape(Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(equipment.kind.capitalized)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StugaTheme.muted)
                    Text(TrackingPresentation.locationText(currentAsset, zoneName: zoneName))
                        .font(.title3.weight(.semibold))
                    if currentAsset.position?.positionType != "last-known",
                       let seen = currentAsset.position.flatMap(TrackingPresentation.relativeLastSeen) {
                        Text(seen)
                            .font(.caption)
                            .foregroundStyle(StugaTheme.muted)
                    }
                }
            }
        }
    }

    private var location: some View {
        section("Location estimate") {
            if let position = currentAsset.position {
                valueRow("Type", locationType(position))
                valueRow(
                    "Confidence",
                    TrackingPresentation.confidence(position.confidenceLevel)
                )
                if let radius = position.accuracyRadiusMeters {
                    valueRow("Accuracy", "Approximately \(Int(radius.rounded())) metres")
                } else if let zoneName {
                    valueRow("Area", "In or near \(zoneName)")
                }
                valueRow("Movement", position.movementState.capitalized)
                valueRow(
                    "Supporting observers",
                    "\(position.observerCount)"
                )
                Text("BLE location is an estimate, not an exact GPS coordinate.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
                    .padding(.top, 4)
            } else {
                Label("No reliable location estimate is available.", systemImage: "questionmark.circle")
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private func tagStatus(_ tag: TrackingTag) -> some View {
        section("Tag") {
            valueRow("Model", tag.hardwareModel)
            if let battery = tag.batteryPercent {
                valueRow("Battery", "\(battery)%")
            } else {
                valueRow("Battery", "Not reported")
            }
            valueRow("Status", tag.status.capitalized)
            if tag.capabilities.motion {
                Label("Motion reporting", systemImage: "figure.walk.motion")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private var evidence: some View {
        section("Why this location") {
            if let position = currentAsset.position {
                Text(explanation(position))
                    .font(.subheadline)
                Text(
                    "\(position.explanation.acceptedObservationCount) supporting observation"
                        + (position.explanation.acceptedObservationCount == 1 ? "" : "s")
                )
                .font(.caption)
                .foregroundStyle(StugaTheme.muted)
            } else {
                Text("No recent accepted observations.")
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private var findAction: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                showingFind = true
            } label: {
                Label("Find nearby", systemImage: "dot.radiowaves.left.and.right")
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(currentAsset.tag == nil || !model.equipmentObservationEnabled)

            if currentAsset.tag == nil {
                Text("Assign a BLE tracking tag to use foreground Find nearby.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            } else if !model.equipmentObservationEnabled {
                Text("Turn on equipment observation to use foreground Find nearby.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            } else {
                Text("Signal strength provides warmer/colder guidance, not an exact distance.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private var zoneName: String? {
        guard let zoneID = currentAsset.position?.zoneId else { return nil }
        return snapshot?.zones.first { $0.id == zoneID }?.name
    }

    private func locationType(_ position: AssetPositionEstimate) -> String {
        switch position.positionType {
        case "nearby-live": "Live nearby"
        case "confirmed-zone": "Confirmed zone"
        case "estimated-coordinate": "Estimated map position"
        case "last-known": "Last known"
        default: "Unknown"
        }
    }

    private var serviceState: String {
        switch equipment.status {
        case "active": "Active"
        case "out-of-service": "Out of service"
        case "retired": "Retired"
        default: equipment.status.capitalized
        }
    }

    private var equipment: AreaEquipment {
        model.selectedPropertyEquipment.first { $0.id == asset.id }
            ?? asset.equipment
    }

    private var currentAsset: TrackedEquipmentState {
        model.trackedState(for: asset.id)
            ?? TrackedEquipmentState(equipment: equipment)
    }

    private func explanation(_ position: AssetPositionEstimate) -> String {
        switch position.explanation.method {
        case "FIND_NEARBY":
            "Detected directly by a phone in foreground Find mode."
        case "MULTI_OBSERVER_WEIGHTED_MEDIAN":
            "Estimated from several recent observers that broadly agree."
        case "SINGLE_MOBILE_OBSERVER":
            "Estimated around one nearby phone, with broad uncertainty."
        case "MULTIPLE_FIXED_GATEWAYS":
            "Estimated from multiple fixed gateways."
        case "FIXED_GATEWAY_ZONE":
            zoneName.map { "The strongest reliable gateway evidence places it in or near \($0)." }
                ?? "The strongest reliable gateway evidence identifies this area."
        case "LAST_KNOWN":
            "No recent detection is available; this is the last reliable estimate."
        default:
            "Available observations are too old or unreliable."
        }
    }

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            StugaCard {
                VStack(alignment: .leading, spacing: 10) {
                    content()
                }
            }
        }
    }

    private func valueRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(StugaTheme.muted)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

struct EquipmentEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment?
    let onSaved: (AreaEquipment) -> Void

    @State private var name: String
    @State private var kind: String
    @State private var areaID: String
    @State private var status: AreaEquipmentServiceStatus
    @State private var manufacturer: String
    @State private var equipmentModel: String
    @State private var serialNumber: String
    @State private var notes: String
    @State private var saving = false
    @State private var errorMessage: String?

    init(
        equipment: AreaEquipment?,
        onSaved: @escaping (AreaEquipment) -> Void = { _ in }
    ) {
        self.equipment = equipment
        self.onSaved = onSaved
        _name = State(initialValue: equipment?.name ?? "")
        _kind = State(initialValue: equipment?.kind ?? "")
        _areaID = State(initialValue: equipment?.areaId ?? "")
        _status = State(
            initialValue: AreaEquipmentServiceStatus(
                rawValue: equipment?.status ?? ""
            ) ?? .active
        )
        _manufacturer = State(initialValue: equipment?.manufacturer ?? "")
        _equipmentModel = State(initialValue: equipment?.model ?? "")
        _serialNumber = State(initialValue: equipment?.serialNumber ?? "")
        _notes = State(initialValue: equipment?.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Equipment type", text: $kind)
                    Picker("Assigned area", selection: $areaID) {
                        if areaID.isEmpty {
                            Text("Choose an area").tag("")
                        }
                        ForEach(sortedAreas) { area in
                            Text(area.name).tag(area.id)
                        }
                    }
                } header: {
                    Text("Inventory record")
                } footer: {
                    Text(
                        "The assigned area is the expected storage location. "
                            + "BLE tracking remains a separate estimate."
                    )
                }

                Section("Service state") {
                    Picker("Status", selection: $status) {
                        ForEach(AreaEquipmentServiceStatus.allCases) { value in
                            Text(statusLabel(value)).tag(value)
                        }
                    }
                }

                Section("Identification") {
                    TextField("Manufacturer (optional)", text: $manufacturer)
                    TextField("Model (optional)", text: $equipmentModel)
                    TextField("Serial number (optional)", text: $serialNumber)
                        .textInputAutocapitalization(.characters)
                }

                Section("Inventory notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 120)
                        .accessibilityLabel("Inventory notes")
                }

                if !fieldsWithinLimits {
                    Section {
                        Label(
                            "Names and identifiers must be 200 characters or fewer; "
                                + "notes must be 5,000 characters or fewer.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .foregroundStyle(StugaTheme.critical)
                        .font(.caption)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(StugaScreenBackground())
            .navigationTitle(equipment == nil ? "Add equipment" : "Edit equipment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if saving {
                            ProgressView()
                                .accessibilityLabel("Saving equipment")
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(!canSave || saving || model.isReadOnly)
                }
            }
            .task {
                if areaID.isEmpty {
                    areaID = sortedAreas.first?.id ?? ""
                }
            }
            .interactiveDismissDisabled(saving)
            .alert("Equipment could not be saved", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var sortedAreas: [PropertyArea] {
        model.selectedPropertyAreas.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !kind.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && sortedAreas.contains(where: { $0.id == areaID })
            && fieldsWithinLimits
    }

    private var fieldsWithinLimits: Bool {
        [name, kind, manufacturer, equipmentModel, serialNumber]
            .allSatisfy { $0.count <= 200 }
            && notes.count <= 5_000
    }

    private func statusLabel(_ value: AreaEquipmentServiceStatus) -> String {
        switch value {
        case .active: "Active"
        case .outOfService: "Out of service"
        case .retired: "Retired"
        }
    }

    private func save() {
        guard canSave, !saving else { return }
        saving = true
        errorMessage = nil
        Task {
            do {
                let saved: AreaEquipment
                if let equipment {
                    saved = try await model.updateEquipment(
                        id: equipment.id,
                        input: AreaEquipmentUpdateInput(
                            areaId: areaID,
                            name: cleaned(name) ?? "",
                            kind: cleaned(kind) ?? "",
                            manufacturer: cleaned(manufacturer),
                            model: cleaned(equipmentModel),
                            serialNumber: cleaned(serialNumber),
                            status: status,
                            notes: cleaned(notes)
                        )
                    )
                } else {
                    saved = try await model.createEquipment(
                        AreaEquipmentCreateInput(
                            areaId: areaID,
                            name: cleaned(name) ?? "",
                            kind: cleaned(kind) ?? "",
                            manufacturer: cleaned(manufacturer),
                            model: cleaned(equipmentModel),
                            serialNumber: cleaned(serialNumber),
                            status: status,
                            notes: cleaned(notes)
                        )
                    )
                }
                onSaved(saved)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            saving = false
        }
    }

    private func cleaned(_ value: String) -> String? {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
}

private struct FindNearbyView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var tracker: MobileTrackingController
    let asset: TrackedEquipmentState
    @Environment(\.dismiss) private var dismiss
    @State private var startedAt = Date()

    init(asset: TrackedEquipmentState, tracker: MobileTrackingController) {
        self.asset = asset
        self.tracker = tracker
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                signal
                VStack(spacing: 8) {
                    Text(primaryText)
                        .font(.largeTitle.weight(.bold))
                        .multilineTextAlignment(.center)
                    Text(secondaryText)
                        .foregroundStyle(StugaTheme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)
                Spacer()
                Button("Stop finding") {
                    model.stopFindingNearby()
                    dismiss()
                }
                .buttonStyle(SecondaryButtonStyle())
                .padding(16)
            }
            .background(StugaScreenBackground())
            .navigationTitle(asset.equipment.name)
            .navigationBarTitleDisplayMode(.inline)
            .task {
                startedAt = Date()
                await model.findNearby(asset)
            }
            .onDisappear { model.stopFindingNearby() }
        }
    }

    @ViewBuilder
    private var signal: some View {
        if let reading = tracker.proximity {
            ZStack {
                Circle()
                    .stroke(StugaTheme.line, lineWidth: 16)
                Circle()
                    .trim(from: 0, to: signalProgress(reading.smoothedRSSI))
                    .stroke(
                        signalColor(reading.band),
                        style: StrokeStyle(lineWidth: 16, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                Image(systemName: signalSymbol(reading.band))
                    .font(.system(size: 48, weight: .semibold))
                    .foregroundStyle(signalColor(reading.band))
            }
            .frame(width: 190, height: 190)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(primaryText)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                ZStack {
                    Circle()
                        .stroke(StugaTheme.line, style: StrokeStyle(lineWidth: 8, dash: [8]))
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 44))
                        .foregroundStyle(StugaTheme.action)
                }
                .frame(width: 190, height: 190)
            }
        }
    }

    private var primaryText: String {
        guard tracker.findingEquipmentID == asset.id else {
            return Date().timeIntervalSince(startedAt) > 4 ? "Not detected" : "Searching"
        }
        guard let reading = tracker.proximity else { return "Searching" }
        switch reading.band {
        case .far: return reading.trend == .gettingCloser ? "Getting closer" : "Weak signal"
        case .nearby: return reading.trend == .gettingCloser ? "Getting closer" : "Nearby"
        case .close: return "Close"
        case .veryClose: return "Very close"
        }
    }

    private var secondaryText: String {
        guard tracker.findingEquipmentID == asset.id else {
            return "Move around the last known area while Stuga listens for the tag."
        }
        guard let reading = tracker.proximity else {
            return "Keep this screen open and move around slowly."
        }
        switch reading.trend {
        case .gettingCloser: return "The recent signal trend is stronger."
        case .gettingFarther: return "The recent signal trend is weaker. Try another direction."
        case .steady: return "Move a few steps and watch for a trend."
        }
    }

    private func signalProgress(_ rssi: Double) -> Double {
        min(1, max(0.08, (rssi + 100) / 50))
    }

    private func signalColor(_ band: TrackingProximityBand) -> Color {
        switch band {
        case .far: StugaTheme.muted
        case .nearby: StugaTheme.action
        case .close: StugaTheme.warning
        case .veryClose: StugaTheme.success
        }
    }

    private func signalSymbol(_ band: TrackingProximityBand) -> String {
        switch band {
        case .far: "antenna.radiowaves.left.and.right"
        case .nearby: "dot.radiowaves.left.and.right"
        case .close: "location.circle"
        case .veryClose: "checkmark.circle.fill"
        }
    }
}
