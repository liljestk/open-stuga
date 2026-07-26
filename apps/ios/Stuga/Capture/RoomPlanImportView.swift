import RoomPlan
import SwiftUI
import UIKit
import simd

struct RoomPlanImportView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @EnvironmentObject private var model: AppModel

    @State private var selectedFloorID = ""
    @State private var expectedHomeUpdatedAt = ""
    @State private var roomName = ""
    @State private var isCapturing = false
    @State private var captureShouldStop = false
    @State private var cancelledCapture = false
    @State private var capturedRoom: CapturedRoom?
    @State private var geometry: RoomScanGeometry?
    @State private var draft: StugaFloor?
    @State private var isImporting = false
    @State private var showingReplacementConfirmation = false
    @State private var sharePayload: RoomPlanSharePayload?
    @State private var exportedDirectory: URL?
    @State private var errorMessage: String?

    private var eligibleFloors: [StugaFloor] {
        model.selectedHomeFloors.filter { $0.rooms.count <= 1 }
    }

    private var selectedFloor: StugaFloor? {
        eligibleFloors.first { $0.id == selectedFloorID }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isCapturing {
                    captureView
                } else if let draft, let geometry {
                    reviewView(draft: draft, geometry: geometry)
                } else {
                    setupView
                }
            }
            .navigationTitle(isCapturing ? "Scan room" : "Room scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !isCapturing {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
            }
        }
        .onAppear {
            if selectedFloorID.isEmpty {
                selectedFloorID = eligibleFloors.first?.id ?? ""
                roomName = eligibleFloors.first?.rooms.first?.name ?? ""
            }
        }
        .confirmationDialog(
            "Replace this floor plan?",
            isPresented: $showingReplacementConfirmation,
            titleVisibility: .visible
        ) {
            Button("Replace after review", role: .destructive) {
                importDraft()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The scanned geometry replaces the current walls, room outline, openings, and background image. Stuga preserves the floor identity and refuses the change if linked records would be orphaned. Existing sensor and observation coordinates stay unchanged and may need realignment in the web editor.")
        }
        .sheet(item: $sharePayload, onDismiss: removeSharedFiles) { payload in
            RoomPlanActivityView(items: payload.urls.map { $0 as Any })
        }
    }

    private var setupView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !RoomCaptureSession.isSupported {
                    ContentUnavailableView {
                        Label("LiDAR is required", systemImage: "viewfinder")
                    } description: {
                        Text("Room scanning is available on supported iPhone and iPad models with a LiDAR Scanner.")
                    }
                } else if eligibleFloors.isEmpty {
                    ContentUnavailableView {
                        Label("No compatible floor", systemImage: "square.split.2x1")
                    } description: {
                        Text("Add an empty or single-room floor in Stuga first. Multi-room floors require alignment in the web editor.")
                    } actions: {
                        if let url = model.serverAddress?.webURL() {
                            Link("Open Stuga", destination: url)
                        }
                    }
                } else {
                    StugaCard {
                        VStack(alignment: .leading, spacing: 14) {
                            Label("Review before import", systemImage: "checkmark.shield")
                                .font(.headline)
                            Text("Walk slowly around one room. Stuga converts Apple RoomPlan surfaces into metre-scale walls and openings, then shows the result before anything changes.")
                                .foregroundStyle(StugaTheme.muted)

                            Text("Target floor")
                                .font(.subheadline.weight(.semibold))
                            Picker("Target floor", selection: $selectedFloorID) {
                                ForEach(eligibleFloors) { floor in
                                    Text(floor.name).tag(floor.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .onChange(of: selectedFloorID) { _, id in
                                roomName = eligibleFloors
                                    .first(where: { $0.id == id })?
                                    .rooms.first?.name ?? ""
                            }

                            if selectedFloor?.walls.isEmpty == false
                                || selectedFloor?.rooms.isEmpty == false {
                                Label(
                                    "This floor already has geometry. Import requires a second confirmation. Existing sensor and observation positions may need review afterward.",
                                    systemImage: "exclamationmark.triangle"
                                )
                                .font(.footnote)
                                .foregroundStyle(StugaTheme.warning)
                            }
                        }
                    }

                    Label(
                        "Camera and depth data stay on this device. Only the reviewed wall, room, and opening geometry is sent to your Stuga server.",
                        systemImage: "lock.shield"
                    )
                    .font(.footnote)
                    .foregroundStyle(StugaTheme.muted)

                    Button {
                        startCapture()
                    } label: {
                        Label("Start room scan", systemImage: "viewfinder")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(model.selectedHomeReadOnly || model.usingCachedData)
                }

                if model.selectedHomeReadOnly {
                    Label(
                        "This Home's floor plan is read-only.",
                        systemImage: "lock"
                    )
                    .font(.footnote)
                    .foregroundStyle(StugaTheme.muted)
                } else if model.usingCachedData {
                    Label(
                        "Reconnect before scanning so the floor cannot change underneath the review.",
                        systemImage: "wifi.slash"
                    )
                    .font(.footnote)
                    .foregroundStyle(StugaTheme.warning)
                }

                errorView
            }
            .padding(20)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(StugaTheme.canvas)
    }

    private var captureView: some View {
        ZStack(alignment: .top) {
            RoomCaptureContainer(
                shouldStop: $captureShouldStop,
                onComplete: finishCapture,
                onError: {
                    errorMessage = $0.localizedDescription
                    isCapturing = false
                }
            )
            .ignoresSafeArea(edges: .bottom)

            HStack {
                Button {
                    cancelledCapture = true
                    captureShouldStop = true
                    dismiss()
                } label: {
                    Label("Cancel", systemImage: "xmark")
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    captureShouldStop = true
                } label: {
                    if captureShouldStop {
                        ProgressView()
                    } else {
                        Label("Finish", systemImage: "checkmark")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(captureShouldStop)
            }
            .padding()
            .background(.ultraThinMaterial)
        }
    }

    private func reviewView(
        draft: StugaFloor,
        geometry: RoomScanGeometry
    ) -> some View {
        ScrollView {
            LazyVGrid(
                columns: reviewColumns,
                alignment: .leading,
                spacing: 24
            ) {
                reviewPreview(draft: draft, geometry: geometry)
                reviewControls(draft: draft)
            }
            .padding(20)
            .frame(maxWidth: 1000)
            .frame(maxWidth: .infinity)
        }
        .background(StugaTheme.canvas)
    }

    private var reviewColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible(), alignment: .top)]
        }
        return [
            GridItem(
                .adaptive(minimum: 300, maximum: 480),
                spacing: 24,
                alignment: .top
            ),
        ]
    }

    private func reviewPreview(
        draft: StugaFloor,
        geometry: RoomScanGeometry
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            RoomPlanPreview(floor: draft)
                .frame(height: horizontalSizeClass == .regular ? 320 : 260)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "Scanned floor plan with \(draft.walls.count) walls and \(draft.planElements?.count ?? 0) openings."
                )

            Label(
                "RoomPlan is an estimate. Check wall lengths, openings, and orientation in Stuga’s floor editor before using the plan for decisions.",
                systemImage: "ruler"
            )
            .font(.footnote)
            .foregroundStyle(StugaTheme.muted)

            Text("Captured \(geometry.capturedAt)")
                .font(.caption)
                .foregroundStyle(StugaTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func reviewControls(draft: StugaFloor) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            StugaCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Review the result")
                        .font(.headline)
                    TextField("Room name", text: $roomName)
                        .textInputAutocapitalization(.words)
                        .onChange(of: roomName) { _, value in
                            if value.count > 120 {
                                roomName = String(value.prefix(120))
                            }
                            rebuildDraft()
                        }
                        .padding(12)
                        .background(StugaTheme.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .overlay {
                            RoundedRectangle(cornerRadius: 5)
                                .stroke(StugaTheme.strongLine, lineWidth: 1)
                        }

                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                        GridRow {
                            Text("Floor").foregroundStyle(StugaTheme.muted)
                            Text(draft.name)
                        }
                        GridRow {
                            Text("Size").foregroundStyle(StugaTheme.muted)
                            Text(
                                "\(draft.width.formatted(.number.precision(.fractionLength(1)))) × \(draft.height.formatted(.number.precision(.fractionLength(1)))) m"
                            )
                        }
                        GridRow {
                            Text("Walls").foregroundStyle(StugaTheme.muted)
                            Text("\(draft.walls.count)")
                        }
                        GridRow {
                            Text("Openings").foregroundStyle(StugaTheme.muted)
                            Text("\(draft.planElements?.count ?? 0)")
                        }
                    }
                    .font(.subheadline)
                }
            }

            errorView

            Button {
                if selectedFloor?.walls.isEmpty == false
                    || selectedFloor?.rooms.isEmpty == false {
                    showingReplacementConfirmation = true
                } else {
                    importDraft()
                }
            } label: {
                if isImporting {
                    ProgressView()
                } else {
                    Label("Import reviewed geometry", systemImage: "square.and.arrow.down")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isImporting)

            Button {
                exportOriginalScan()
            } label: {
                Label("Export original scan", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(capturedRoom == nil)

            Button("Scan again") {
                capturedRoom = nil
                geometry = nil
                self.draft = nil
                errorMessage = nil
                startCapture()
            }
            .buttonStyle(SecondaryButtonStyle())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var errorView: some View {
        if let errorMessage {
            Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline)
                .foregroundStyle(StugaTheme.critical)
                .accessibilityLabel("Room scan error. \(errorMessage)")
        }
    }

    private func startCapture() {
        guard RoomCaptureSession.isSupported,
              let home = model.selectedHome,
              let floor = selectedFloor else {
            return
        }
        expectedHomeUpdatedAt = home.updatedAt
        selectedFloorID = floor.id
        if roomName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            roomName = floor.rooms.first?.name ?? "Scanned room"
        }
        cancelledCapture = false
        captureShouldStop = false
        errorMessage = nil
        isCapturing = true
    }

    private func finishCapture(_ room: CapturedRoom) {
        guard !cancelledCapture, let floor = selectedFloor else { return }
        do {
            let geometry = CapturedRoomAdapter.geometry(from: room)
            let draft = try RoomPlanDraftBuilder.replacing(
                floor,
                with: geometry,
                roomName: roomName
            )
            capturedRoom = room
            self.geometry = geometry
            self.draft = draft
            isCapturing = false
        } catch {
            errorMessage = error.localizedDescription
            isCapturing = false
        }
    }

    private func rebuildDraft() {
        guard let geometry, let floor = selectedFloor else { return }
        draft = try? RoomPlanDraftBuilder.replacing(
            floor,
            with: geometry,
            roomName: roomName
        )
    }

    private func importDraft() {
        guard let draft, let geometry else { return }
        isImporting = true
        errorMessage = nil
        Task {
            do {
                try await model.importRoomPlanFloor(
                    draft,
                    capturedAt: geometry.capturedAt,
                    expectedHouseUpdatedAt: expectedHomeUpdatedAt
                )
                removeSharedFiles()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isImporting = false
        }
    }

    private func exportOriginalScan() {
        guard let capturedRoom else { return }
        removeSharedFiles()
        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(
                    "Stuga-RoomPlan-\(UUID().uuidString.lowercased())",
                    isDirectory: true
                )
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            exportedDirectory = directory
            var protectedDirectory = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? protectedDirectory.setResourceValues(values)

            let modelURL = directory.appendingPathComponent("stuga-room.usdz")
            try capturedRoom.export(to: modelURL, exportOptions: .parametric)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: modelURL.path
            )
            let dataURL = directory.appendingPathComponent("stuga-room.json")
            let data = try JSONEncoder().encode(capturedRoom)
            try data.write(
                to: dataURL,
                options: [.atomic, .completeFileProtection]
            )
            sharePayload = RoomPlanSharePayload(
                directory: directory,
                urls: [modelURL, dataURL]
            )
        } catch {
            removeSharedFiles()
            errorMessage = "The original room scan could not be exported."
        }
    }

    private func removeSharedFiles() {
        guard let directory = sharePayload?.directory ?? exportedDirectory else {
            return
        }
        let temporary = FileManager.default.temporaryDirectory.standardizedFileURL
        let target = directory.standardizedFileURL
        if target.path.hasPrefix(temporary.path + "/"),
           target.lastPathComponent.hasPrefix("Stuga-RoomPlan-") {
            try? FileManager.default.removeItem(at: target)
        }
        sharePayload = nil
        exportedDirectory = nil
    }
}

private struct RoomCaptureContainer: UIViewRepresentable {
    @Binding var shouldStop: Bool
    let onComplete: (CapturedRoom) -> Void
    let onError: (Error) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> RoomCaptureView {
        let view = RoomCaptureView(frame: .zero)
        view.delegate = context.coordinator
        context.coordinator.started = true
        view.captureSession.run(configuration: RoomCaptureSession.Configuration())
        return view
    }

    func updateUIView(_ view: RoomCaptureView, context: Context) {
        context.coordinator.parent = self
        if shouldStop, context.coordinator.started, !context.coordinator.stopped {
            context.coordinator.stopped = true
            view.captureSession.stop()
        }
    }

    static func dismantleUIView(_ view: RoomCaptureView, coordinator: Coordinator) {
        if !coordinator.stopped {
            coordinator.stopped = true
            view.captureSession.stop()
        }
    }

    @objc(StugaRoomCaptureCoordinator)
    final class Coordinator: NSObject, RoomCaptureViewDelegate {
        var parent: RoomCaptureContainer
        var started = false
        var stopped = false

        init(parent: RoomCaptureContainer) {
            self.parent = parent
        }

        required init?(coder: NSCoder) {
            return nil
        }

        func encode(with coder: NSCoder) {}

        func captureView(
            shouldPresent roomDataForProcessing: CapturedRoomData,
            error: Error?
        ) -> Bool {
            if let error {
                parent.onError(error)
                return false
            }
            return true
        }

        func captureView(
            didPresent processedResult: CapturedRoom,
            error: Error?
        ) {
            if let error {
                parent.onError(error)
            } else {
                parent.onComplete(processedResult)
            }
        }
    }
}

private enum CapturedRoomAdapter {
    static func geometry(from room: CapturedRoom) -> RoomScanGeometry {
        let walls = room.walls.compactMap { surface -> RoomScanWall? in
            let center = surface.transform.columns.3
            let axis = SIMD2<Double>(
                Double(surface.transform.columns.0.x),
                Double(surface.transform.columns.0.z)
            )
            let length = hypot(axis.x, axis.y)
            let width = Double(surface.dimensions.x)
            guard length > 0.0001, width >= 0.1 else { return nil }
            let direction = axis / length
            let centerPoint = StugaPlanPoint(
                x: Double(center.x),
                y: Double(center.z)
            )
            return RoomScanWall(
                id: surface.identifier.uuidString.lowercased(),
                from: StugaPlanPoint(
                    x: centerPoint.x - direction.x * width / 2,
                    y: centerPoint.y - direction.y * width / 2
                ),
                to: StugaPlanPoint(
                    x: centerPoint.x + direction.x * width / 2,
                    y: centerPoint.y + direction.y * width / 2
                ),
                height: Double(surface.dimensions.y)
            )
        }

        var floorPolygon: [StugaPlanPoint] = []
        if let surface = room.floors.max(
            by: { polygonArea($0) < polygonArea($1) }
        ) {
            floorPolygon = surface.polygonCorners.map { corner in
                let world = simd_mul(
                    surface.transform,
                    SIMD4<Float>(corner.x, corner.y, corner.z, 1)
                )
                return StugaPlanPoint(
                    x: Double(world.x),
                    y: Double(world.z)
                )
            }
        }

        var openings = room.windows.map {
            opening($0, kind: .window, isOpen: nil)
        }
        openings += room.openings.map {
            opening($0, kind: .opening, isOpen: true)
        }
        openings += room.doors.map { surface in
            let isOpen: Bool?
            if case let .door(open) = surface.category {
                isOpen = open
            } else {
                isOpen = nil
            }
            return opening(surface, kind: .door, isOpen: isOpen)
        }

        return RoomScanGeometry(
            id: room.identifier.uuidString.lowercased(),
            capturedAt: ISO8601DateFormatter().string(from: Date()),
            walls: walls,
            floorPolygon: floorPolygon,
            openings: openings
        )
    }

    private static func opening(
        _ surface: CapturedRoom.Surface,
        kind: RoomScanOpening.Kind,
        isOpen: Bool?
    ) -> RoomScanOpening {
        let center = surface.transform.columns.3
        let height = Double(surface.dimensions.y)
        return RoomScanOpening(
            id: surface.identifier.uuidString.lowercased(),
            kind: kind,
            center: StugaPlanPoint(
                x: Double(center.x),
                y: Double(center.z)
            ),
            width: Double(surface.dimensions.x),
            height: height,
            bottomOffsetM: max(0, Double(center.y) - height / 2),
            parentWallId: surface.parentIdentifier?.uuidString.lowercased(),
            isOpen: isOpen
        )
    }

    private static func polygonArea(_ surface: CapturedRoom.Surface) -> Double {
        let points = surface.polygonCorners
        guard points.count >= 3 else { return 0 }
        let origin = points[0]
        var doubledArea = SIMD3<Float>(repeating: 0)
        for index in 1..<(points.count - 1) {
            doubledArea += simd_cross(
                points[index] - origin,
                points[index + 1] - origin
            )
        }
        return Double(simd_length(doubledArea)) / 2
    }
}

private struct RoomPlanPreview: View {
    let floor: StugaFloor

    var body: some View {
        Canvas { context, size in
            let scale = min(
                size.width / max(floor.width, 0.1),
                size.height / max(floor.height, 0.1)
            ) * 0.9
            let offsetX = (size.width - floor.width * scale) / 2
            let offsetY = (size.height - floor.height * scale) / 2
            let point: (StugaPlanPoint) -> CGPoint = {
                CGPoint(
                    x: offsetX + $0.x * scale,
                    y: offsetY + $0.y * scale
                )
            }

            if let room = floor.rooms.first, let first = room.points.first {
                var path = Path()
                path.move(to: point(first))
                for value in room.points.dropFirst() {
                    path.addLine(to: point(value))
                }
                path.closeSubpath()
                context.fill(path, with: .color(StugaTheme.action.opacity(0.12)))
            }
            for wall in floor.walls {
                var path = Path()
                path.move(to: point(wall.from))
                path.addLine(to: point(wall.to))
                context.stroke(
                    path,
                    with: .color(StugaTheme.ink),
                    lineWidth: 3
                )
            }
            for opening in floor.planElements ?? [] {
                let center = point(opening.position)
                let radius = max(3, (opening.width ?? 0.2) * scale / 3)
                context.fill(
                    Path(
                        ellipseIn: CGRect(
                            x: center.x - radius,
                            y: center.y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )
                    ),
                    with: .color(StugaTheme.action)
                )
            }
        }
        .padding(8)
        .background(StugaTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(StugaTheme.line, lineWidth: 1)
        }
    }
}

private struct RoomPlanSharePayload: Identifiable {
    let id = UUID()
    let directory: URL
    let urls: [URL]
}

private struct RoomPlanActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}
