import SwiftUI

struct QuickCaptureView: View {
    private struct Choice: Identifiable {
        let id: String
        let label: String
    }

    private enum CaptureKind: String, CaseIterable, Identifiable {
        case observation = "Observation"
        case maintenance = "Maintenance"

        var id: Self { self }
    }

    private let observationKinds = [
        Choice(id: "note", label: "Note"),
        Choice(id: "leak", label: "Leak"),
        Choice(id: "condensation", label: "Condensation"),
        Choice(id: "mould", label: "Mould"),
        Choice(id: "ventilation", label: "Ventilation"),
        Choice(id: "maintenance", label: "Maintenance"),
    ]
    private let observationSeverities = [
        Choice(id: "info", label: "Information"),
        Choice(id: "warning", label: "Warning"),
        Choice(id: "critical", label: "Critical"),
    ]
    private let maintenancePriorities = [
        Choice(id: "low", label: "Low"),
        Choice(id: "normal", label: "Normal"),
        Choice(id: "high", label: "High"),
        Choice(id: "urgent", label: "Urgent"),
    ]

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var captureKind = CaptureKind.observation
    @State private var observationKind = "note"
    @State private var observationSeverity = "info"
    @State private var selectedSensorID = ""
    @State private var note = ""
    @State private var title = ""
    @State private var maintenanceDescription = ""
    @State private var priority = "normal"
    @State private var selectedEquipment: AreaEquipment?
    @State private var showingScanner = false
    @State private var saving = false
    @State private var saveState: AppModel.QuickCaptureSaveState?
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Record", selection: $captureKind) {
                        ForEach(CaptureKind.allCases) { kind in
                            Text(kind.rawValue).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if captureKind == .observation {
                    observationForm
                } else {
                    maintenanceForm
                }

                if let saveState {
                    Section {
                        Label(
                            saveState == .saved
                                ? "Saved to Stuga."
                                : "Saved securely on this iPhone. It will sync after reconnection.",
                            systemImage: saveState == .saved
                                ? "checkmark.circle.fill"
                                : "arrow.triangle.2.circlepath"
                        )
                        .foregroundStyle(StugaTheme.success)
                    }
                }

                if let localError {
                    Section {
                        Label(localError, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(StugaTheme.critical)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(StugaTheme.canvas)
            .navigationTitle("Quick capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(!canSave || saving)
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .onChange(of: note) { _, value in
            note = bounded(value, limit: 5_000)
        }
        .onChange(of: title) { _, value in
            title = bounded(value, limit: 200)
        }
        .onChange(of: maintenanceDescription) { _, value in
            maintenanceDescription = bounded(value, limit: 5_000)
        }
        .sheet(isPresented: $showingScanner) {
            EquipmentScannerSheet { value in
                guard let code = EquipmentQRCode.parse(value) else {
                    localError = "This is not a valid Stuga equipment tag."
                    return
                }
                Task {
                    if let asset = await model.resolveEquipmentCode(code) {
                        selectedEquipment = asset.equipment
                    } else {
                        localError = "That equipment is not available to this account."
                    }
                }
            }
        }
    }

    private var observationForm: some View {
        Group {
            Section("What happened") {
                Picker("Kind", selection: $observationKind) {
                    ForEach(observationKinds) { choice in
                        Text(choice.label).tag(choice.id)
                    }
                }
                Picker("Importance", selection: $observationSeverity) {
                    ForEach(observationSeverities) { choice in
                        Text(choice.label).tag(choice.id)
                    }
                }
                Picker("Sensor", selection: $selectedSensorID) {
                    Text("No specific sensor").tag("")
                    ForEach(model.selectedSensors) { sensor in
                        Text(sensor.name).tag(sensor.id)
                    }
                }
            }

            Section("Note") {
                TextEditor(text: $note)
                    .frame(minHeight: 120)
                    .accessibilityLabel("Observation note")
                Text("You can use the keyboard microphone to dictate.")
                    .font(.caption)
                    .foregroundStyle(StugaTheme.muted)
            }
        }
    }

    private var maintenanceForm: some View {
        Group {
            Section("Work") {
                TextField("What needs doing?", text: $title)
                Picker("Priority", selection: $priority) {
                    ForEach(maintenancePriorities) { choice in
                        Text(choice.label).tag(choice.id)
                    }
                }
                TextEditor(text: $maintenanceDescription)
                    .frame(minHeight: 100)
                    .accessibilityLabel("Maintenance details")
            }

            Section("Equipment") {
                Picker(
                    "Equipment",
                    selection: Binding(
                        get: { selectedEquipment?.id ?? "" },
                        set: { id in
                            selectedEquipment = model.selectedPropertyEquipment.first {
                                $0.id == id
                            }
                        }
                    )
                ) {
                    Text("No specific equipment").tag("")
                    ForEach(model.selectedPropertyEquipment) { equipment in
                        Text(equipment.name).tag(equipment.id)
                    }
                }
                Button {
                    showingScanner = true
                } label: {
                    Label("Scan equipment tag", systemImage: "qrcode.viewfinder")
                }
            }
        }
    }

    private var canSave: Bool {
        guard !model.isReadOnly else { return false }
        switch captureKind {
        case .observation:
            return !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .maintenance:
            return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func bounded(_ value: String, limit: Int) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(limit))
    }

    private func save() async {
        saving = true
        localError = nil
        defer { saving = false }
        do {
            switch captureKind {
            case .observation:
                saveState = try await model.submitObservation(
                    kind: observationKind,
                    severity: observationSeverity,
                    note: note,
                    sensorID: selectedSensorID.isEmpty ? nil : selectedSensorID
                )
                note = ""
            case .maintenance:
                saveState = try await model.submitMaintenance(
                    title: title,
                    description: maintenanceDescription.isEmpty
                        ? nil
                        : maintenanceDescription,
                    priority: priority,
                    equipment: selectedEquipment
                )
                title = ""
                maintenanceDescription = ""
            }
        } catch {
            localError = error.localizedDescription
        }
    }
}
