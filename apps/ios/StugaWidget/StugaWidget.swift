import Foundation
import SwiftUI
import UIKit
import WidgetKit

private struct WidgetSnapshot: Codable, Equatable {
    let homeId: String
    let homeName: String
    let state: String
    let title: String
    let detail: String
    let activeAlertCount: Int
    let updatedAt: String

    static let appGroupIdentifier = "group.net.nysta.stuga"
    static let storageKey = "stuga.widget.snapshot.v1"
}

private struct StugaWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

private struct StugaWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> StugaWidgetEntry {
        StugaWidgetEntry(
            date: Date(),
            snapshot: WidgetSnapshot(
                homeId: "home",
                homeName: "Stuga",
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
        completion: @escaping (StugaWidgetEntry) -> Void
    ) {
        completion(StugaWidgetEntry(date: Date(), snapshot: loadSnapshot()))
    }

    func getTimeline(
        in context: Context,
        completion: @escaping (Timeline<StugaWidgetEntry>) -> Void
    ) {
        let entry = StugaWidgetEntry(date: Date(), snapshot: loadSnapshot())
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

private struct StugaWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StugaWidgetEntry

    var body: some View {
        Group {
            if let snapshot = entry.snapshot {
                content(snapshot)
                    .privacySensitive()
                    .widgetURL(URL(string: "stuga://home"))
            } else {
                emptyState
                    .widgetURL(URL(string: "stuga://home"))
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
            }
        } else {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Label(snapshot.homeName, systemImage: symbol(snapshot.state))
                        .font(.headline)
                        .foregroundStyle(color(snapshot.state))
                    Spacer()
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
            Label("Stuga", systemImage: "house")
                .font(.headline)
            Text("Open Stuga to save your Home status.")
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

private struct StugaStatusWidget: Widget {
    let kind = "StugaStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: kind,
            provider: StugaWidgetProvider()
        ) { entry in
            StugaWidgetView(entry: entry)
        }
        .configurationDisplayName("Home status")
        .description("The latest status saved by your Stuga app.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@main
struct StugaWidgetBundle: WidgetBundle {
    var body: some Widget {
        StugaStatusWidget()
    }
}
