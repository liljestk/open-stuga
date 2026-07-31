import Foundation
import SwiftUI
import UIKit
import WidgetKit

private struct WidgetSnapshot: Codable, Equatable {
    static let currentSchemaVersion = 2
    static let minimumSupportedSchemaVersion = 1

    let schemaVersion: Int
    let homeId: String
    let homeName: String
    let homeOrigin: String?
    let state: String
    let title: String
    let detail: String
    let activeAlertCount: Int
    let updatedAt: String

    static let appGroupIdentifier = "group.net.nysta.stuga"
    static let storageKey = "stugu.widget.snapshot.v1"

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case homeId
        case homeName
        case homeOrigin
        case state
        case title
        case detail
        case activeAlertCount
        case updatedAt
    }

    init(
        homeId: String,
        homeName: String,
        homeOrigin: String?,
        state: String,
        title: String,
        detail: String,
        activeAlertCount: Int,
        updatedAt: String
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.homeId = homeId
        self.homeName = homeName
        self.homeOrigin = homeOrigin
        self.state = state
        self.title = title
        self.detail = detail
        self.activeAlertCount = activeAlertCount
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let storedSchemaVersion = try values.decodeIfPresent(
            Int.self,
            forKey: .schemaVersion
        ) ?? Self.minimumSupportedSchemaVersion
        guard (Self.minimumSupportedSchemaVersion...Self.currentSchemaVersion)
            .contains(storedSchemaVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: values,
                debugDescription: "Unsupported widget snapshot schema \(storedSchemaVersion)."
            )
        }
        schemaVersion = Self.currentSchemaVersion
        homeId = try values.decode(String.self, forKey: .homeId)
        homeName = try values.decode(String.self, forKey: .homeName)
        homeOrigin = try values.decodeIfPresent(String.self, forKey: .homeOrigin)
        state = try values.decode(String.self, forKey: .state)
        title = try values.decode(String.self, forKey: .title)
        detail = try values.decode(String.self, forKey: .detail)
        activeAlertCount = try values.decodeIfPresent(
            Int.self,
            forKey: .activeAlertCount
        ) ?? 0
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
    }
}

private struct StuguWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

private struct StuguWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> StuguWidgetEntry {
        StuguWidgetEntry(
            date: Date(),
            snapshot: WidgetSnapshot(
                homeId: "home",
                homeName: "Stugu",
                homeOrigin: "own",
                state: "balanced",
                title: "Home looks balanced",
                detail: "No current exception needs attention.",
                activeAlertCount: 0,
                updatedAt: Date().ISO8601Format()
            )
        )
    }

    func getSnapshot(
        in context: Context,
        completion: @escaping (StuguWidgetEntry) -> Void
    ) {
        completion(StuguWidgetEntry(date: Date(), snapshot: loadSnapshot()))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<StuguWidgetEntry>) -> Void
    ) {
        let entry = StuguWidgetEntry(date: Date(), snapshot: loadSnapshot())
        completion(
            Timeline(
                entries: [entry],
                policy: .after(Date().addingTimeInterval(15 * 60))
            )
        )
    }

    private func loadSnapshot() -> WidgetSnapshot? {
        guard let defaults = UserDefaults(
            suiteName: WidgetSnapshot.appGroupIdentifier
        ),
        let data = defaults.data(forKey: WidgetSnapshot.storageKey) else {
            return nil
        }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

private struct StuguWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StuguWidgetEntry

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot)
                    .privacySensitive()
                    .widgetURL(URL(string: "stugu://home"))
            } else {
                emptyState
                    .widgetURL(URL(string: "stugu://home"))
            }
        }
        .containerBackground(for: .widget) {
            Color(uiColor: .secondarySystemBackground)
        }
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        if family == .accessoryRectangular {
            VStack(alignment: .leading, spacing: 2) {
                Label(snapshot.homeName, systemImage: symbol(snapshot.state))
                    .font(.headline)
                Text(snapshot.title)
                    .font(.caption)
                    .lineLimit(2)
                    .privacySensitive()
                if snapshot.homeOrigin == "remote" {
                    Text("Remote Home")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Label(snapshot.homeName, systemImage: symbol(snapshot.state))
                        .font(.headline)
                        .foregroundStyle(color(snapshot.state))
                    Spacer()
                    if snapshot.homeOrigin == "remote" {
                        Image(systemName: "person.2.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Remote Home")
                    }
                    if snapshot.activeAlertCount > 0 {
                        Text("\(snapshot.activeAlertCount)")
                            .font(.caption.bold())
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.red.opacity(0.15), in: Capsule())
                    }
                }
                Text(snapshot.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .privacySensitive()
                if family == .systemMedium {
                    Text(snapshot.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .privacySensitive()
                }
                Spacer(minLength: 0)
                Text("Saved \(updatedDate(snapshot.updatedAt), style: .relative)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Stugu", systemImage: "house")
                .font(.headline)
            Text("Open Stugu to save your Home status.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func symbol(_ state: String) -> String {
        switch state {
        case "critical": "exclamationmark.octagon.fill"
        case "attention": "exclamationmark.triangle.fill"
        case "balanced": "checkmark.circle.fill"
        default: "circle.dashed"
        }
    }

    private func color(_ state: String) -> Color {
        switch state {
        case "critical": .red
        case "attention": .orange
        case "balanced": .green
        default: .secondary
        }
    }

    private func updatedDate(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
            ?? ISO8601DateFormatter().date(from: value)
            ?? entry.date
    }
}

private struct StuguStatusWidget: Widget {
    let kind = "StuguStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: kind,
            provider: StuguWidgetProvider()
        ) { entry in
            StuguWidgetView(entry: entry)
        }
        .configurationDisplayName("Home status")
        .description("The latest status saved by your Stugu app.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@main
struct StuguWidgetBundle: WidgetBundle {
    var body: some Widget {
        StuguStatusWidget()
    }
}
