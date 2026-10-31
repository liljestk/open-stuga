import Combine
import CoreLocation
import MapKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum TrackingPresentation {
    static func locationText(
        _ state: TrackedEquipmentState,
        zoneName: String?
    ) -> String {
        guard let position = state.position else { return "Unknown location" }
        switch position.kind {
        case "nearby":
            return position.freshness == "live" ? "Live nearby" : "Recently nearby"
        case "zone", "area":
            return zoneName.map { "In or near \($0)" } ?? "Estimated area"
        case "coordinate":
            return "Estimated location"
        default:
            return "Unknown location"
        }
    }

    static func relativeLastSeen(_ position: EquipmentLocationEstimate) -> String? {
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
    let state: TrackedEquipmentState
    let snapshot: TrackingMapSnapshot?
    @Environment(\.dismiss) private var dismiss
    @State private var showingFind = false
    @State private var showingEditor = false

    init(
        state: TrackedEquipmentState,
        snapshot: TrackingMapSnapshot?,
        tracker: MobileTrackingController
    ) {
        self.state = state
        self.snapshot = snapshot
        self.tracker = tracker
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    identity
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
                    }
                    equipmentDetails
                    location
                    if let endpoint = currentState.endpoint { endpointStatus(endpoint) }
                    evidence
                    findAction
                    EquipmentResourcesView(equipment: equipment)
                    EquipmentOperationsView(equipment: equipment)
                }
                .padding(16)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
            .background(StuguScreenBackground())
            .navigationTitle(equipment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $showingFind) {
                FindNearbyView(state: currentState, tracker: tracker)
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
            if let areaID = equipment.areaId,
               let areaName = model.areaName(for: areaID)
                ?? snapshot?.zones.first(where: { $0.id == areaID })?.name {
                valueRow("Assigned area", areaName)
            } else if let homeName = model.houseName(for: equipment.houseId) {
                valueRow("Assigned Home", homeName)
            } else if equipment.areaId != nil {
                valueRow("Assigned area", "Unavailable")
            } else if equipment.houseId != nil {
                valueRow("Assigned Home", "Unavailable")
            } else {
                valueRow(
                    "Expected location",
                    equipment.location == nil ? "Unassigned" : "Property map pin"
                )
            }
            if let coordinate = equipment.location {
                valueRow(
                    "Pinned coordinate",
                    coordinate.latitude.formatted(.number.precision(.fractionLength(5)))
                        + ", "
                        + coordinate.longitude.formatted(.number.precision(.fractionLength(5)))
                )
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
                Divider().overlay(StuguTheme.line)
                Text(notes)
                    .font(.subheadline)
            }
            if !model.selectedPropertyReadOnly {
                Divider().overlay(StuguTheme.line)
                Button {
                    showingEditor = true
                } label: {
                    Label("Edit inventory record", systemImage: "square.and.pencil")
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(!model.inventoryMutationsAvailable)
            }
        }
    }

    private var identity: some View {
        StuguCard {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.title2)
                    .foregroundStyle(StuguTheme.action)
                    .frame(width: 48, height: 48)
                    .background(StuguTheme.action.opacity(0.1))
                    .clipShape(Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(equipment.kind.capitalized)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StuguTheme.muted)
                    Text(primaryLocationText)
                        .font(.title3.weight(.semibold))
                    if let seen = currentState.position.flatMap(TrackingPresentation.relativeLastSeen) {
                        Text(seen)
                            .font(.caption)
                            .foregroundStyle(StuguTheme.muted)
                    }
                }
            }
        }
    }

    private var location: some View {
        section("Location estimate") {
            if let position = currentState.position {
                valueRow("Type", locationType(position))
                valueRow(
                    "Confidence",
                    "\(Int((position.confidence * 100).rounded()))% · "
                        + TrackingPresentation.confidence(position.truthClass)
                )
                if let radius = position.uncertaintyRadiusMeters {
                    valueRow("Uncertainty", "Approximately ±\(Int(radius.rounded())) metres")
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
                    .foregroundStyle(StuguTheme.muted)
                    .padding(.top, 4)
            } else {
                Label("No reliable location estimate is available.", systemImage: "questionmark.circle")
                    .foregroundStyle(StuguTheme.muted)
                if equipment.location != nil {
                    Text("The manually pinned expected location remains visible on the map.")
                        .font(.caption)
                        .foregroundStyle(StuguTheme.muted)
                }
            }
        }
    }

    private func endpointStatus(_ endpoint: TrackingEndpoint) -> some View {
        section("Tracking endpoint") {
            valueRow("Name", endpoint.displayName)
            valueRow("Profile", endpoint.profileId)
            valueRow("Model", endpoint.model ?? "Not reported")
            if let raw = endpoint.telemetry["batteryPercent"],
               case let .number(value) = raw {
                let battery = Int(value)
                valueRow("Battery", "\(battery)%")
            } else {
                valueRow("Battery", "Not reported")
            }
            valueRow("Claim", endpoint.claimStatus.capitalized)
            valueRow("Trackability", endpoint.trackabilityTier.capitalized)
        }
    }

    private var evidence: some View {
        section("Why this location") {
            if let position = currentState.position {
                Text(explanation(position))
                    .font(.subheadline)
                Text(
                    "\(position.provenance.observationIds.count) supporting observation"
                        + (position.provenance.observationIds.count == 1 ? "" : "s")
                )
                .font(.caption)
                .foregroundStyle(StuguTheme.muted)
            } else {
                Text("No recent accepted observations.")
                    .foregroundStyle(StuguTheme.muted)
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
            .disabled(currentState.endpoint == nil || !model.equipmentObservationEnabled)

            if currentState.endpoint == nil {
                Text("Bind a compatible tracking endpoint to use foreground Find nearby.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            } else if !model.equipmentObservationEnabled {
                Text("Turn on equipment observation to use foreground Find nearby.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                Text("Signal strength provides warmer/colder guidance, not an exact distance.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
            }
        }
    }

    private var zoneName: String? {
        guard let zoneID = currentState.position?.zoneId else { return nil }
        return snapshot?.zones.first { $0.id == zoneID }?.name
    }

    private func locationType(_ position: EquipmentLocationEstimate) -> String {
        switch position.kind {
        case "nearby": "Nearby"
        case "zone": "Estimated zone"
        case "area": "Estimated area"
        case "coordinate": "Estimated map position"
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
        model.selectedPropertyEquipment.first { $0.id == state.id }
            ?? state.equipment
    }

    private var currentState: TrackedEquipmentState {
        model.trackedState(for: state.id)
            ?? TrackedEquipmentState(equipment: equipment)
    }

    private var primaryLocationText: String {
        if currentState.position == nil {
            if equipment.location != nil { return "Pinned expected location" }
            if equipment.areaId != nil || equipment.houseId != nil {
                return "Expected at \(model.equipmentPlacementName(equipment))"
            }
        }
        return TrackingPresentation.locationText(currentState, zoneName: zoneName)
    }

    private func explanation(_ position: EquipmentLocationEstimate) -> String {
        switch position.source {
        case "mobile-observer":
            "Detected directly by a phone in foreground Find mode."
        case "multi-observer":
            "Estimated from several recent observers that broadly agree."
        case "fixed-gateway":
            zoneName.map { "The strongest reliable gateway evidence places it in or near \($0)." }
                ?? "The strongest reliable gateway evidence identifies this area."
        case "manual":
            "This estimate was set manually and remains separate from the expected inventory location."
        default:
            position.provenance.factors.first
                ?? "Available observations are too old or unreliable."
        }
    }

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            StuguCard {
                VStack(alignment: .leading, spacing: 10) {
                    content()
                }
            }
        }
    }

    private func valueRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(StuguTheme.muted)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

private struct EquipmentResourcesView: View {
    @EnvironmentObject private var model: AppModel
    let equipment: AreaEquipment
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var showingDocumentPicker = false
    @State private var showingLinkForm = false
    @State private var sharingURL: URL?
    @State private var attachmentToDelete: EquipmentAttachment?
    @State private var linkToDelete: EquipmentLink?
    @State private var busy = false
    @State private var errorMessage: String?

    private var attachments: [EquipmentAttachment] {
        model.equipmentAttachments(for: equipment.id)
    }

    private var photos: [EquipmentAttachment] {
        attachments.filter { $0.kind == .photo }
    }

    private var documents: [EquipmentAttachment] {
        attachments.filter { $0.kind == .document }
    }

    private var links: [EquipmentLink] {
        model.equipmentLinks(for: equipment.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Photos, manuals & links")
                .font(.headline)
            StuguCard {
                VStack(alignment: .leading, spacing: 14) {
                    photosSection
                    Divider().overlay(StuguTheme.line)
                    documentsSection
                    Divider().overlay(StuguTheme.line)
                    linksSection
                    if !model.selectedPropertyReadOnly {
                        Divider().overlay(StuguTheme.line)
                        addActions
                    }
                    if busy {
                        ProgressView("Saving item resource")
                            .font(.caption)
                    }
                }
            }
        }
        .fileImporter(
            isPresented: $showingDocumentPicker,
            allowedContentTypes: [.pdf, .plainText, .rtf, .data],
            allowsMultipleSelection: true
        ) { result in
            Task { await importDocuments(result) }
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            selectedPhotos = []
            Task { await importPhotos(items) }
        }
        .sheet(isPresented: $showingLinkForm) {
            EquipmentLinkForm(equipment: equipment)
                .environmentObject(model)
        }
        .sheet(isPresented: Binding(
            get: { sharingURL != nil },
            set: { if !$0 { sharingURL = nil } }
        )) {
            if let sharingURL {
                EquipmentResourceShareSheet(items: [sharingURL])
            }
        }
        .confirmationDialog(
            "Remove this file?",
            isPresented: Binding(
                get: { attachmentToDelete != nil },
                set: { if !$0 { attachmentToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove file", role: .destructive) {
                guard let attachment = attachmentToDelete else { return }
                attachmentToDelete = nil
                Task { await deleteAttachment(attachment) }
            }
            Button("Cancel", role: .cancel) { attachmentToDelete = nil }
        } message: {
            Text(attachmentToDelete?.name ?? "")
        }
        .confirmationDialog(
            "Remove this link?",
            isPresented: Binding(
                get: { linkToDelete != nil },
                set: { if !$0 { linkToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove link", role: .destructive) {
                guard let link = linkToDelete else { return }
                linkToDelete = nil
                Task { await deleteLink(link) }
            }
            Button("Cancel", role: .cancel) { linkToDelete = nil }
        } message: {
            Text(linkToDelete?.label ?? "")
        }
        .alert("Item resource action failed", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var photosSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("Item photos", systemImage: "photo.on.rectangle.angled")
                .font(.subheadline.weight(.semibold))
            if photos.isEmpty {
                Text("No item photos have been added.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 116), spacing: 8)],
                    spacing: 8
                ) {
                    ForEach(photos) { attachment in
                        EquipmentPhotoTile(
                            equipmentID: equipment.id,
                            attachment: attachment,
                            canDelete: model.inventoryMutationsAvailable && !busy,
                            onDelete: { attachmentToDelete = attachment }
                        )
                    }
                }
            }
        }
    }

    private var documentsSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("Manuals & documents", systemImage: "doc.text")
                .font(.subheadline.weight(.semibold))
            if documents.isEmpty {
                Text("No manuals or related documents have been added.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                ForEach(documents) { attachment in
                    HStack(spacing: 10) {
                        Button {
                            Task { await share(attachment) }
                        } label: {
                            HStack(spacing: 9) {
                                Image(systemName: "doc.text")
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(attachment.name)
                                        .lineLimit(2)
                                    Text(resourceSize(attachment.size))
                                        .font(.caption)
                                        .foregroundStyle(StuguTheme.muted)
                                }
                                Spacer()
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(StuguTheme.action)
                        if !model.selectedPropertyReadOnly {
                            Button(role: .destructive) {
                                attachmentToDelete = attachment
                            } label: {
                                Image(systemName: "trash")
                            }
                            .disabled(busy || !model.inventoryMutationsAvailable)
                            .accessibilityLabel("Remove \(attachment.name)")
                        }
                    }
                }
            }
        }
    }

    private var linksSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("Relevant links", systemImage: "link")
                .font(.subheadline.weight(.semibold))
            if links.isEmpty {
                Text("No relevant links have been added.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                ForEach(links) { link in
                    HStack(spacing: 10) {
                        if let destination = URL(string: link.url) {
                            Link(destination: destination) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(link.label)
                                            .lineLimit(2)
                                        Text(link.url)
                                            .font(.caption)
                                            .foregroundStyle(StuguTheme.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.up.right.square")
                                }
                            }
                        }
                        if !model.selectedPropertyReadOnly {
                            Button(role: .destructive) {
                                linkToDelete = link
                            } label: {
                                Image(systemName: "trash")
                            }
                            .disabled(busy || !model.inventoryMutationsAvailable)
                            .accessibilityLabel("Remove link \(link.label)")
                        }
                    }
                }
            }
        }
    }

    private var addActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { addActionButtons }
            VStack(alignment: .leading, spacing: 8) { addActionButtons }
        }
    }

    @ViewBuilder private var addActionButtons: some View {
        PhotosPicker(
            selection: $selectedPhotos,
            maxSelectionCount: 10,
            matching: .images
        ) {
            Label("Add photos", systemImage: "photo.badge.plus")
        }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(busy || !model.inventoryMutationsAvailable)

        Button {
            showingDocumentPicker = true
        } label: {
            Label("Add documents", systemImage: "doc.badge.plus")
        }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(busy || !model.inventoryMutationsAvailable)

        Button {
            showingLinkForm = true
        } label: {
            Label("Add link", systemImage: "link.badge.plus")
        }
        .buttonStyle(SecondaryButtonStyle())
        .disabled(busy || !model.inventoryMutationsAvailable)
    }

    @MainActor
    private func importPhotos(_ items: [PhotosPickerItem]) async {
        busy = true
        defer { busy = false }
        do {
            for item in items {
                guard let source = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: source),
                      let data = image.jpegData(compressionQuality: 0.9) else {
                    throw StuguAPIError(
                        status: 0,
                        code: "INVALID_PHOTO",
                        message: "One selected photo could not be read."
                    )
                }
                guard data.count <= 10 * 1_024 * 1_024 else {
                    throw StuguAPIError(
                        status: 413,
                        code: "ATTACHMENT_TOO_LARGE",
                        message: "Each photo must be 10 MiB or smaller."
                    )
                }
                _ = try await model.uploadEquipmentAttachment(
                    equipmentID: equipment.id,
                    kind: .photo,
                    name: "Item photo \(UUID().uuidString.prefix(8)).jpg",
                    mimeType: "image/jpeg",
                    data: data
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func importDocuments(_ result: Result<[URL], Error>) async {
        busy = true
        defer { busy = false }
        do {
            for url in try result.get() {
                guard let mimeType = documentMimeType(for: url) else {
                    throw StuguAPIError(
                        status: 415,
                        code: "UNSUPPORTED_ATTACHMENT_TYPE",
                        message: "\(url.lastPathComponent) is not a supported document."
                    )
                }
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                guard !data.isEmpty, data.count <= 10 * 1_024 * 1_024 else {
                    throw StuguAPIError(
                        status: 413,
                        code: "ATTACHMENT_TOO_LARGE",
                        message: "Each document must be 10 MiB or smaller."
                    )
                }
                _ = try await model.uploadEquipmentAttachment(
                    equipmentID: equipment.id,
                    kind: .document,
                    name: url.lastPathComponent,
                    mimeType: mimeType,
                    data: data
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func share(_ attachment: EquipmentAttachment) async {
        busy = true
        defer { busy = false }
        do {
            let data = try await model.equipmentAttachmentData(
                equipmentID: equipment.id,
                attachmentID: attachment.id
            )
            let safeName = attachment.name.replacingOccurrences(
                of: #"[/\\:]"#,
                with: "_",
                options: .regularExpression
            )
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(attachment.id)-\(safeName)")
            try data.write(to: url, options: .atomic)
            sharingURL = url
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func deleteAttachment(_ attachment: EquipmentAttachment) async {
        busy = true
        defer { busy = false }
        do {
            try await model.deleteEquipmentAttachment(
                equipmentID: equipment.id,
                attachmentID: attachment.id
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func deleteLink(_ link: EquipmentLink) async {
        busy = true
        defer { busy = false }
        do {
            try await model.deleteEquipmentLink(equipmentID: equipment.id, linkID: link.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func documentMimeType(for url: URL) -> String? {
        switch url.pathExtension.lowercased() {
        case "pdf": "application/pdf"
        case "txt": "text/plain"
        case "md", "markdown": "text/markdown"
        case "rtf": "application/rtf"
        case "doc": "application/msword"
        case "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        case "odt": "application/vnd.oasis.opendocument.text"
        default: nil
        }
    }

    private func resourceSize(_ size: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB]
        formatter.countStyle = .binary
        return formatter.string(fromByteCount: Int64(size))
    }
}

private struct EquipmentPhotoTile: View {
    @EnvironmentObject private var model: AppModel
    let equipmentID: String
    let attachment: EquipmentAttachment
    let canDelete: Bool
    let onDelete: () -> Void
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack {
                RoundedRectangle(cornerRadius: StuguTheme.Radius.control)
                    .fill(StuguTheme.action.opacity(0.08))
                    .aspectRatio(4 / 3, contentMode: .fit)
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .aspectRatio(4 / 3, contentMode: .fill)
                        .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.control))
                } else if failed {
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(StuguTheme.muted)
                } else {
                    ProgressView()
                        .accessibilityLabel("Loading \(attachment.name)")
                }
            }
            .clipped()
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(attachment.name)
                    .font(.caption)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if canDelete {
                    Button(role: .destructive, action: onDelete) {
                        Image(systemName: "trash")
                    }
                    .accessibilityLabel("Remove \(attachment.name)")
                }
            }
        }
        .task(id: attachment.id) {
            do {
                let data = try await model.equipmentAttachmentData(
                    equipmentID: equipmentID,
                    attachmentID: attachment.id
                )
                image = UIImage(data: data)
                failed = image == nil
            } catch {
                failed = true
            }
        }
    }
}

private struct EquipmentLinkForm: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment
    @State private var label = ""
    @State private var url = "https://"
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if !model.inventoryMutationsAvailable {
                    Section {
                        Label(
                            "Reconnect to Stugu before changing inventory.",
                            systemImage: "wifi.slash"
                        )
                        .foregroundStyle(StuguTheme.warning)
                    }
                }
                Section("Relevant information") {
                    TextField("Link name", text: $label)
                    TextField("Web address", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Add link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        Task { await save() }
                    }
                    .disabled(!canSave || saving || !model.inventoryMutationsAvailable)
                }
            }
            .interactiveDismissDisabled(saving)
            .alert("Link could not be added", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var canSave: Bool {
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 200, address.count <= 2_048,
              let parsed = URL(string: address) else {
            return false
        }
        return ["http", "https"].contains(parsed.scheme?.lowercased() ?? "")
            && parsed.host != nil
            && parsed.user == nil
            && parsed.password == nil
    }

    @MainActor
    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await model.addEquipmentLink(
                equipmentID: equipment.id,
                label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                url: url.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct EquipmentResourceShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}

struct EquipmentEditorView: View {
    private enum Placement: Hashable {
        case unassigned
        case area(String)
        case home(String)

        var areaID: String? {
            guard case let .area(id) = self else { return nil }
            return id
        }

        var houseID: String? {
            guard case let .home(id) = self else { return nil }
            return id
        }
    }

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment?
    let onSaved: (AreaEquipment) -> Void

    @State private var name: String
    @State private var kind: String
    @State private var placement: Placement
    @State private var status: AreaEquipmentServiceStatus
    @State private var manufacturer: String
    @State private var equipmentModel: String
    @State private var serialNumber: String
    @State private var notes: String
    @State private var latitude: String
    @State private var longitude: String
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var showingMapPicker = false
    @StateObject private var currentLocation = EquipmentCurrentLocationProvider()

    init(
        equipment: AreaEquipment?,
        initialCoordinate: GeoCoordinate? = nil,
        onSaved: @escaping (AreaEquipment) -> Void = { _ in }
    ) {
        self.equipment = equipment
        self.onSaved = onSaved
        let startingCoordinate = equipment?.location ?? initialCoordinate
        _name = State(initialValue: equipment?.name ?? "")
        _kind = State(initialValue: equipment?.kind ?? "")
        if let areaID = equipment?.areaId {
            _placement = State(initialValue: .area(areaID))
        } else if let houseID = equipment?.houseId {
            _placement = State(initialValue: .home(houseID))
        } else {
            _placement = State(initialValue: .unassigned)
        }
        _status = State(
            initialValue: AreaEquipmentServiceStatus(
                rawValue: equipment?.status ?? ""
            ) ?? .active
        )
        _manufacturer = State(initialValue: equipment?.manufacturer ?? "")
        _equipmentModel = State(initialValue: equipment?.model ?? "")
        _serialNumber = State(initialValue: equipment?.serialNumber ?? "")
        _notes = State(initialValue: equipment?.notes ?? "")
        _latitude = State(
            initialValue: startingCoordinate.map { String($0.latitude) } ?? ""
        )
        _longitude = State(
            initialValue: startingCoordinate.map { String($0.longitude) } ?? ""
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                if !model.inventoryMutationsAvailable {
                    Section {
                        Label {
                            Text(LocalizedStringKey(
                                model.selectedPropertyReadOnly
                                    ? "This Property is read-only. Inventory can be viewed but not changed."
                                    : "Reconnect to Stugu before changing inventory."
                            ))
                        } icon: {
                            Image(systemName: model.selectedPropertyReadOnly ? "eye" : "wifi.slash")
                        }
                        .foregroundStyle(StuguTheme.warning)
                    }
                }
                Section {
                    TextField("Name", text: $name)
                    TextField("Equipment type", text: $kind)
                    Picker("Expected location", selection: $placement) {
                        Text("Unassigned").tag(Placement.unassigned)
                        ForEach(sortedAreas) { area in
                            Text("Area · \(area.name)").tag(Placement.area(area.id))
                        }
                        ForEach(selectableHouses) { home in
                            Text(
                                "Home · \(home.name)"
                                    + (home.stuguby?.isForeignSharedHome == true ? " · Remote" : "")
                                    + (home.stuguby?.isReadOnly == true ? " · Read-only" : "")
                            )
                            .tag(Placement.home(home.id))
                        }
                    }
                } header: {
                    Text("Inventory record")
                } footer: {
                    Text(
                        "Choose a Property area, a Home, or leave this item unassigned. "
                            + "A manual map pin and BLE tracking remain separate."
                    )
                }

                Section {
                    Button {
                        currentLocation.request()
                    } label: {
                        if currentLocation.isRequesting {
                            HStack {
                                ProgressView()
                                Text("Getting current location...")
                            }
                        } else {
                            Label("Use current location", systemImage: "location.fill")
                        }
                    }
                    .disabled(currentLocation.isRequesting)

                    Button {
                        showingMapPicker = true
                    } label: {
                        Label("Choose on Property map", systemImage: "map")
                    }

                    LabeledContent("Latitude") {
                        TextField("Optional", text: $latitude)
                            .keyboardType(.numbersAndPunctuation)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Longitude") {
                        TextField("Optional", text: $longitude)
                            .keyboardType(.numbersAndPunctuation)
                            .multilineTextAlignment(.trailing)
                    }
                    if !coordinateInputIsEmpty {
                        Button("Clear map pin", role: .destructive) {
                            latitude = ""
                            longitude = ""
                            currentLocation.clearError()
                        }
                    }
                    if let locationError = currentLocation.errorMessage {
                        Label(locationError, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(StuguTheme.critical)
                    }
                    if !coordinateIsValid {
                        Label(
                            "Enter both coordinates: latitude −90…90 and longitude −180…180.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption)
                        .foregroundStyle(StuguTheme.critical)
                    }
                } header: {
                    Text("Property map pin")
                } footer: {
                    Text("Optional expected point. It never replaces a BLE location estimate.")
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
                        .foregroundStyle(StuguTheme.critical)
                        .font(.caption)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(StuguScreenBackground())
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
                    .disabled(!canSave || saving || !model.inventoryMutationsAvailable)
                }
            }
            .task {
                guard equipment == nil, placement == .unassigned else { return }
                if let area = sortedAreas.first {
                    placement = .area(area.id)
                } else if let home = model.selectedHome,
                          home.propertyId == model.selectedProperty?.id,
                          home.stuguby?.isReadOnly != true {
                    placement = .home(home.id)
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
            .sheet(isPresented: $showingMapPicker) {
                EquipmentLocationMapPicker(
                    propertyName: model.selectedProperty?.name ?? "Property",
                    areas: sortedAreas,
                    homes: sortedHouses,
                    boundary: propertyBoundary,
                    equipment: model.selectedPropertyEquipment.filter {
                        $0.id != equipment?.id
                    },
                    initialCoordinate: parsedCoordinate
                ) { coordinate in
                    setMapPin(coordinate)
                }
            }
            .onChange(of: currentLocation.coordinate) { _, coordinate in
                guard let coordinate else { return }
                setMapPin(coordinate)
            }
        }
    }

    private var sortedAreas: [PropertyArea] {
        model.selectedPropertyAreas.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private var sortedHouses: [House] {
        model.selectedPropertyHouses
    }

    private var selectableHouses: [House] {
        sortedHouses.filter {
            $0.stuguby?.isReadOnly != true || $0.id == equipment?.houseId
        }
    }

    private var propertyBoundary: [GeoCoordinate] {
        if let boundary = model.trackingSnapshot?.settings.propertyBoundary,
           !boundary.isEmpty {
            return boundary
        }
        return model.trackingSettings?.propertyBoundary ?? []
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !kind.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.selectedProperty != nil
            && placementIsValid
            && coordinateIsValid
            && fieldsWithinLimits
    }

    private var placementIsValid: Bool {
        switch placement {
        case .unassigned:
            return true
        case let .area(id):
            return sortedAreas.contains { $0.id == id }
        case let .home(id):
            return sortedHouses.contains {
                $0.id == id
                    && ($0.stuguby?.isReadOnly != true || id == equipment?.houseId)
            }
        }
    }

    private var fieldsWithinLimits: Bool {
        [name, kind, manufacturer, equipmentModel, serialNumber]
            .allSatisfy { $0.count <= 200 }
            && notes.count <= 5_000
    }

    private var coordinateInputIsEmpty: Bool {
        latitude.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && longitude.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var coordinateIsValid: Bool {
        coordinateInputIsEmpty || parsedCoordinate != nil
    }

    private var parsedCoordinate: GeoCoordinate? {
        guard !coordinateInputIsEmpty,
              let latitude = coordinateNumber(latitude),
              let longitude = coordinateNumber(longitude),
              latitude.isFinite,
              longitude.isFinite,
              (-90...90).contains(latitude),
              (-180...180).contains(longitude) else {
            return nil
        }
        return GeoCoordinate(latitude: latitude, longitude: longitude)
    }

    private func statusLabel(_ value: AreaEquipmentServiceStatus) -> String {
        switch value {
        case .active: "Active"
        case .outOfService: "Out of service"
        case .retired: "Retired"
        }
    }

    private func setMapPin(_ coordinate: GeoCoordinate) {
        latitude = String(coordinate.latitude)
        longitude = String(coordinate.longitude)
        currentLocation.clearError()
    }

    private func save() {
        guard canSave, !saving, let propertyID = model.selectedProperty?.id else { return }
        saving = true
        errorMessage = nil
        Task {
            do {
                let saved: AreaEquipment
                let location = parsedCoordinate
                if let equipment {
                    saved = try await model.updateEquipment(
                        id: equipment.id,
                        input: AreaEquipmentUpdateInput(
                            areaId: placement.areaID,
                            houseId: placement.houseID,
                            location: location,
                            updatesPlacement: placement.areaID != equipment.areaId
                                || placement.houseID != equipment.houseId,
                            updatesLocation: location != equipment.location,
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
                            propertyId: propertyID,
                            areaId: placement.areaID,
                            houseId: placement.houseID,
                            location: location,
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

    private func coordinateNumber(_ value: String) -> Double? {
        Double(
            value.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: ",", with: ".")
        )
    }
}

struct EquipmentLocationMapPicker: View {
    @Environment(\.dismiss) private var dismiss
    let propertyName: String
    let areas: [PropertyArea]
    let homes: [House]
    let boundary: [GeoCoordinate]
    let equipment: [AreaEquipment]
    let onSelect: (GeoCoordinate) -> Void

    @State private var selectedCoordinate: GeoCoordinate?
    @State private var cameraPosition: MapCameraPosition = .automatic

    init(
        propertyName: String,
        areas: [PropertyArea],
        homes: [House],
        boundary: [GeoCoordinate],
        equipment: [AreaEquipment],
        initialCoordinate: GeoCoordinate?,
        onSelect: @escaping (GeoCoordinate) -> Void
    ) {
        self.propertyName = propertyName
        self.areas = areas
        self.homes = homes
        self.boundary = boundary
        self.equipment = equipment
        self.onSelect = onSelect
        _selectedCoordinate = State(initialValue: initialCoordinate)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(propertyName)
                        .font(.subheadline.weight(.semibold))
                    Text(
                        "Tap the map to place the expected location. "
                            + "Property areas, Homes, and existing pins stay visible."
                    )
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(StuguTheme.surface)

                MapReader { proxy in
                    Map(position: $cameraPosition) {
                        if boundary.count >= 3 {
                            MapPolygon(coordinates: boundary.map { clCoordinate($0) })
                                .foregroundStyle(StuguTheme.action.opacity(0.05))
                                .stroke(StuguTheme.action.opacity(0.65), lineWidth: 1.5)
                        }
                        ForEach(areas) { area in
                            if area.polygon.count >= 3 {
                                MapPolygon(
                                    coordinates: area.polygon.map { clCoordinate($0) }
                                )
                                    .foregroundStyle(StuguTheme.action.opacity(0.1))
                                    .stroke(StuguTheme.action.opacity(0.7), lineWidth: 1.25)
                            }
                            if let coordinate = mapCoordinate(for: area) {
                                Annotation(area.name, coordinate: coordinate) {
                                    InventoryLocationContextLabel(
                                        name: area.name,
                                        systemImage: "square.dashed"
                                    )
                                    .accessibilityLabel("Property area, \(area.name)")
                                }
                            }
                        }
                        ForEach(homes) { home in
                            if let coordinate = mapCoordinate(for: home) {
                                Annotation(home.name, coordinate: coordinate) {
                                    InventoryLocationContextLabel(
                                        name: home.name,
                                        systemImage: "house.fill"
                                    )
                                    .accessibilityLabel("Home, \(home.name)")
                                }
                            }
                        }
                        ForEach(equipment) { item in
                            if let location = item.location {
                                Marker(
                                    item.name,
                                    systemImage: "wrench.and.screwdriver.fill",
                                    coordinate: clCoordinate(location)
                                )
                                .tint(StuguTheme.muted)
                            }
                        }
                        if let selectedCoordinate {
                            Annotation(
                                "Selected equipment location",
                                coordinate: clCoordinate(selectedCoordinate)
                            ) {
                                Image(systemName: "mappin.circle.fill")
                                    .font(.system(size: 34, weight: .semibold))
                                    .foregroundStyle(StuguTheme.action)
                                    .background(Circle().fill(StuguTheme.actionText))
                                    .accessibilityLabel("Selected equipment location")
                            }
                        }
                    }
                    .mapStyle(.standard(elevation: .realistic))
                    .mapControls {
                        MapCompass()
                        MapScaleView()
                    }
                    .onTapGesture { point in
                        guard let coordinate = proxy.convert(point, from: .local) else {
                            return
                        }
                        selectedCoordinate = GeoCoordinate(
                            latitude: coordinate.latitude,
                            longitude: coordinate.longitude
                        )
                    }
                }
            }
            .background(StuguScreenBackground())
            .navigationTitle("Choose location")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use location") {
                        guard let selectedCoordinate else { return }
                        onSelect(selectedCoordinate)
                        dismiss()
                    }
                    .disabled(selectedCoordinate == nil)
                }
            }
        }
    }

    private func mapCoordinate(for area: PropertyArea) -> CLLocationCoordinate2D? {
        if let location = area.location {
            return clCoordinate(location)
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

    private func clCoordinate(_ coordinate: GeoCoordinate) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: coordinate.latitude,
            longitude: coordinate.longitude
        )
    }
}

private struct InventoryLocationContextLabel: View {
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

@MainActor
final class EquipmentCurrentLocationProvider: NSObject, ObservableObject {
    @Published private(set) var coordinate: GeoCoordinate?
    @Published private(set) var isRequesting = false
    @Published private(set) var errorMessage: String?

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .other
    }

    func request() {
        coordinate = nil
        errorMessage = nil
        guard CLLocationManager.locationServicesEnabled() else {
            fail(
                "Location Services are off. Choose a point on the map or enable "
                    + "Location Services in Settings."
            )
            return
        }

        isRequesting = true
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            fail(
                "Location access is off for Stugu. Choose a point on the map or "
                    + "allow location access in Settings."
            )
        @unknown default:
            fail("Current location is unavailable. Choose a point on the map instead.")
        }
    }

    func clearError() {
        errorMessage = nil
    }

    private func fail(_ message: String) {
        isRequesting = false
        errorMessage = message
    }
}

extension EquipmentCurrentLocationProvider: CLLocationManagerDelegate {
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isRequesting else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            fail(
                "Location permission was not granted. Choose a point on the map "
                    + "or allow location access in Settings."
            )
        case .notDetermined:
            break
        @unknown default:
            fail("Current location is unavailable. Choose a point on the map instead.")
        }
    }

    func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let location = locations
            .filter({ $0.horizontalAccuracy >= 0 })
            .max(by: { $0.timestamp < $1.timestamp }) else {
            fail("Current location is unavailable. Choose a point on the map instead.")
            return
        }
        coordinate = GeoCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
        )
        isRequesting = false
        errorMessage = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        fail("Current location is temporarily unavailable. Choose it on the map instead.")
    }
}

private struct FindNearbyView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var tracker: MobileTrackingController
    let state: TrackedEquipmentState
    @Environment(\.dismiss) private var dismiss
    @State private var startedAt = Date()

    init(state: TrackedEquipmentState, tracker: MobileTrackingController) {
        self.state = state
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
                        .foregroundStyle(StuguTheme.muted)
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
            .background(StuguScreenBackground())
            .navigationTitle(state.equipment.name)
            .navigationBarTitleDisplayMode(.inline)
            .task {
                startedAt = Date()
                await model.findNearby(state)
            }
            .onDisappear { model.stopFindingNearby() }
        }
    }

    @ViewBuilder
    private var signal: some View {
        if let reading = tracker.proximity {
            ZStack {
                Circle()
                    .stroke(StuguTheme.line, lineWidth: 16)
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
                        .stroke(StuguTheme.line, style: StrokeStyle(lineWidth: 8, dash: [8]))
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 44))
                        .foregroundStyle(StuguTheme.action)
                }
                .frame(width: 190, height: 190)
            }
        }
    }

    private var primaryText: String {
        guard tracker.findingEquipmentID == state.id else {
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
        guard tracker.findingEquipmentID == state.id else {
            return "Move around the last known area while Stugu listens for the endpoint."
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
        case .far: StuguTheme.muted
        case .nearby: StuguTheme.action
        case .close: StuguTheme.warning
        case .veryClose: StuguTheme.success
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
