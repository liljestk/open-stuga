import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct EquipmentOperationsView: View {
    @EnvironmentObject private var model: AppModel
    let equipment: AreaEquipment
    @State private var notes: [PropertyNote] = []
    @State private var issues: [MaintenanceTask] = []
    @State private var loans: [EquipmentLoan] = []
    @State private var loading = true
    @State private var localError: String?
    @State private var showingNote = false
    @State private var showingIssue = false
    @State private var showingBorrow = false
    @State private var showingReturn = false
    @State private var showingShareSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            borrowingSection
            notesSection
            issuesSection
            qrSection
        }
        .task(id: equipment.id) { await load() }
        .sheet(isPresented: $showingNote) {
            EquipmentNoteSheet(equipment: equipment) { note in
                notes.insert(note, at: 0)
            }
            .environmentObject(model)
        }
        .sheet(isPresented: $showingIssue) {
            EquipmentIssueSheet(equipment: equipment) { issue in
                issues.insert(issue, at: 0)
            }
            .environmentObject(model)
        }
        .sheet(isPresented: $showingBorrow) {
            EquipmentBorrowSheet(equipment: equipment) { loan in
                loans.insert(loan, at: 0)
            }
            .environmentObject(model)
        }
        .sheet(isPresented: $showingReturn) {
            if let activeLoan {
                EquipmentReturnSheet(loan: activeLoan) { returned in
                    replaceLoan(returned)
                }
                .environmentObject(model)
            }
        }
        .sheet(isPresented: $showingShareSheet) {
            if let sticker = QRCodeStickerRenderer.sticker(for: equipment) {
                ActivityShareSheet(items: [sticker])
            }
        }
        .alert("Equipment action failed", isPresented: Binding(
            get: { localError != nil },
            set: { if !$0 { localError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(localError ?? "")
        }
    }

    private var activeLoan: EquipmentLoan? {
        loans.first(where: \.isActive)
    }

    private var borrowingSection: some View {
        operationSection("Borrowing") {
            if loading {
                ProgressView("Loading activity")
            } else if let loan = activeLoan {
                Label("Borrowed by \(loan.borrowerLabel)", systemImage: "person.crop.circle")
                    .font(.subheadline.weight(.semibold))
                Text(borrowingDetail(loan))
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                if let note = loan.note {
                    Text(note).font(.subheadline)
                }
                Button {
                    showingReturn = true
                } label: {
                    Label("Mark as returned", systemImage: "arrow.uturn.backward.circle")
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(model.selectedPropertyReadOnly)
            } else {
                Text("Available to borrow")
                    .font(.subheadline.weight(.semibold))
                Text("Stugu records who checked out this item and when it is returned.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                Button {
                    showingBorrow = true
                } label: {
                    Label("Borrow equipment", systemImage: "person.badge.plus")
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(model.selectedPropertyReadOnly)
            }
        }
    }

    private var notesSection: some View {
        operationSection("Notes") {
            if let builtIn = equipment.notes, !builtIn.isEmpty {
                Text(builtIn).font(.subheadline)
            }
            if notes.isEmpty, equipment.notes?.isEmpty != false {
                Text("No notes yet.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                ForEach(notes.prefix(5)) { note in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(note.text)
                            .font(.subheadline)
                        if let created = StuguDateParser.date(from: note.createdAt) {
                            Text(StuguDateParser.dateTime(from: created))
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }
                    if note.id != notes.prefix(5).last?.id {
                        Divider().overlay(StuguTheme.line)
                    }
                }
            }
            Button {
                showingNote = true
            } label: {
                Label("Add note", systemImage: "square.and.pencil")
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(model.selectedPropertyReadOnly)
        }
    }

    private var issuesSection: some View {
        let openIssues = issues.filter {
            !["completed", "verified", "cancelled"].contains($0.status)
        }
        return operationSection("Reported issues") {
            if openIssues.isEmpty {
                Text("No open issues.")
                    .font(.subheadline)
                    .foregroundStyle(StuguTheme.muted)
            } else {
                ForEach(openIssues.prefix(5)) { issue in
                    HStack(alignment: .top) {
                        Image(systemName: issue.priority == "urgent"
                            ? "exclamationmark.triangle.fill"
                            : "wrench.adjustable")
                            .foregroundStyle(
                                issue.priority == "urgent" ? StuguTheme.warning : StuguTheme.action
                            )
                        VStack(alignment: .leading, spacing: 3) {
                            Text(issue.title).font(.subheadline.weight(.semibold))
                            Text("\(issue.priority.capitalized) · \(issue.status.capitalized)")
                                .font(.caption)
                                .foregroundStyle(StuguTheme.muted)
                        }
                    }
                }
            }
            Button {
                showingIssue = true
            } label: {
                Label("Report an issue", systemImage: "exclamationmark.bubble")
            }
            .buttonStyle(SecondaryButtonStyle())
            .disabled(model.selectedPropertyReadOnly)
        }
    }

    private var qrSection: some View {
        operationSection("Equipment QR tag") {
            if let sticker = QRCodeStickerRenderer.sticker(for: equipment) {
                Image(uiImage: sticker)
                    .resizable()
                    .interpolation(.none)
                    .scaledToFit()
                    .frame(maxWidth: 280)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("QR tag for \(equipment.name)")
                Text("Print or share this label, then attach it to the equipment. The code contains only Property and equipment identifiers; Stugu checks access after every scan.")
                    .font(.caption)
                    .foregroundStyle(StuguTheme.muted)
                Button {
                    showingShareSheet = true
                } label: {
                    Label("Share or print QR tag", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(SecondaryButtonStyle())
            } else {
                Text("The QR tag could not be generated.")
                    .foregroundStyle(StuguTheme.muted)
            }
        }
    }

    private func operationSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            StuguCard {
                VStack(alignment: .leading, spacing: 12) {
                    content()
                }
            }
        }
    }

    private func borrowingDetail(_ loan: EquipmentLoan) -> String {
        var parts: [String] = []
        if let borrowed = StuguDateParser.date(from: loan.borrowedAt) {
            parts.append("Since \(borrowed.formatted(date: .abbreviated, time: .omitted))")
        }
        if let value = loan.expectedReturnAt,
           let expected = StuguDateParser.date(from: value) {
            parts.append("Expected back \(StuguDateParser.dateTime(from: expected))")
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let activity = try await model.equipmentActivity(
                equipmentID: equipment.id,
                propertyID: equipment.propertyId
            )
            notes = activity.notes
            issues = activity.issues
            loans = activity.loans
            localError = nil
        } catch {
            localError = error.localizedDescription
        }
    }

    private func replaceLoan(_ loan: EquipmentLoan) {
        if let index = loans.firstIndex(where: { $0.id == loan.id }) {
            loans[index] = loan
        } else {
            loans.insert(loan, at: 0)
        }
    }
}

private struct EquipmentNoteSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment
    let onSaved: (PropertyNote) -> Void
    @State private var text = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        actionForm(title: "Add note") {
            Section("Note") {
                TextEditor(text: $text)
                    .frame(minHeight: 140)
                    .accessibilityLabel("Equipment note")
            }
        } save: {
            let note = try await model.addEquipmentNote(
                equipment: equipment,
                text: text.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            onSaved(note)
        }
    }

    private func actionForm<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content,
        save: @escaping () async throws -> Void
    ) -> some View {
        EquipmentActionForm(
            title: title,
            saveDisabled: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            saving: $saving,
            errorMessage: $errorMessage,
            onSave: save,
            onComplete: { dismiss() },
            content: content
        )
    }
}

private struct EquipmentIssueSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment
    let onSaved: (MaintenanceTask) -> Void
    @State private var title = ""
    @State private var detail = ""
    @State private var priority = "normal"
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        EquipmentActionForm(
            title: "Report issue",
            saveDisabled: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            saving: $saving,
            errorMessage: $errorMessage,
            onSave: {
                let issue = try await model.reportEquipmentIssue(
                    equipment: equipment,
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: detail.trimmingCharacters(in: .whitespacesAndNewlines)
                        .nilIfEmpty,
                    priority: priority
                )
                onSaved(issue)
            },
            onComplete: { dismiss() }
        ) {
            Section("Issue") {
                TextField("Short title", text: $title)
                TextEditor(text: $detail)
                    .frame(minHeight: 120)
                    .accessibilityLabel("Issue details")
                Picker("Priority", selection: $priority) {
                    Text("Low").tag("low")
                    Text("Normal").tag("normal")
                    Text("High").tag("high")
                    Text("Urgent").tag("urgent")
                }
            }
        }
    }
}

private struct EquipmentBorrowSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let equipment: AreaEquipment
    let onSaved: (EquipmentLoan) -> Void
    @State private var hasExpectedReturn = true
    @State private var expectedReturn = Date().addingTimeInterval(24 * 60 * 60)
    @State private var note = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        EquipmentActionForm(
            title: "Borrow equipment",
            saveDisabled: false,
            saving: $saving,
            errorMessage: $errorMessage,
            onSave: {
                let loan = try await model.borrowEquipment(
                    equipment: equipment,
                    expectedReturnAt: hasExpectedReturn
                        ? ISO8601DateFormatter.stuguAction.string(from: expectedReturn)
                        : nil,
                    note: note.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                )
                onSaved(loan)
            },
            onComplete: { dismiss() }
        ) {
            Section("Return plan") {
                Toggle("Set an expected return", isOn: $hasExpectedReturn)
                if hasExpectedReturn {
                    DatePicker(
                        "Expected back",
                        selection: $expectedReturn,
                        in: Date().addingTimeInterval(60)...,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                }
                TextField("Optional note", text: $note, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
    }
}

private struct EquipmentReturnSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let loan: EquipmentLoan
    let onSaved: (EquipmentLoan) -> Void
    @State private var note = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        EquipmentActionForm(
            title: "Return equipment",
            saveDisabled: false,
            saving: $saving,
            errorMessage: $errorMessage,
            onSave: {
                let returned = try await model.returnEquipment(
                    loan: loan,
                    note: note.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                )
                onSaved(returned)
            },
            onComplete: { dismiss() }
        ) {
            Section("Return") {
                Text("Confirm that the equipment is back on the Property.")
                TextField("Optional return note", text: $note, axis: .vertical)
                    .lineLimit(2...5)
            }
        }
    }
}

private struct EquipmentActionForm<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let saveDisabled: Bool
    @Binding var saving: Bool
    @Binding var errorMessage: String?
    let onSave: () async throws -> Void
    let onComplete: () -> Void
    let content: Content

    init(
        title: String,
        saveDisabled: Bool,
        saving: Binding<Bool>,
        errorMessage: Binding<String?>,
        onSave: @escaping () async throws -> Void,
        onComplete: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.saveDisabled = saveDisabled
        _saving = saving
        _errorMessage = errorMessage
        self.onSave = onSave
        self.onComplete = onComplete
        self.content = content()
    }

    var body: some View {
        NavigationStack {
            Form { content }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(saving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") {
                            Task {
                                saving = true
                                defer { saving = false }
                                do {
                                    try await onSave()
                                    onComplete()
                                } catch {
                                    errorMessage = error.localizedDescription
                                }
                            }
                        }
                        .disabled(saveDisabled || saving)
                    }
                }
                .alert("Could not save", isPresented: Binding(
                    get: { errorMessage != nil },
                    set: { if !$0 { errorMessage = nil } }
                )) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(errorMessage ?? "")
                }
        }
    }
}

private enum QRCodeStickerRenderer {
    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    static func sticker(for equipment: AreaEquipment) -> UIImage? {
        let code = EquipmentQRCode(
            propertyId: equipment.propertyId,
            equipmentId: equipment.id
        )
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(code.payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgCode = context.createCGImage(output, from: output.extent) else {
            return nil
        }

        let size = CGSize(width: 620, height: 760)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { rendererContext in
            UIColor.white.setFill()
            rendererContext.cgContext.fill(CGRect(origin: .zero, size: size))
            rendererContext.cgContext.interpolationQuality = .none
            UIImage(cgImage: cgCode).draw(in: CGRect(x: 50, y: 42, width: 520, height: 520))
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            paragraph.lineBreakMode = .byTruncatingTail
            (equipment.name as NSString).draw(
                in: CGRect(x: 36, y: 590, width: 548, height: 64),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 32, weight: .bold),
                    .foregroundColor: UIColor.black,
                    .paragraphStyle: paragraph,
                ]
            )
            ("Scan with Stugu" as NSString).draw(
                in: CGRect(x: 36, y: 666, width: 548, height: 44),
                withAttributes: [
                    .font: UIFont.systemFont(ofSize: 23, weight: .medium),
                    .foregroundColor: UIColor.darkGray,
                    .paragraphStyle: paragraph,
                ]
            )
        }
    }
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(
        _ uiViewController: UIActivityViewController,
        context: Context
    ) {}
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

private extension ISO8601DateFormatter {
    static let stuguAction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
