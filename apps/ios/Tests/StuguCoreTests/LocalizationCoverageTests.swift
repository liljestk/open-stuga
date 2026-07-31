import Foundation
import XCTest

final class LocalizationCoverageTests: XCTestCase {
    private let requiredCoreKeys = [
        "Alerts",
        "Home",
        "Inventory",
        "Mark as seen",
        "Quick capture",
        "Reconnect before scanning",
        "Reconnect to Stugu before changing inventory.",
        "Reconnect to Stugu before scanning a room.",
        "Room plan is read-only",
        "Room scanning requires an online session so Stugu can verify the target floor before capture.",
        "Room scan",
        "Saved securely on this iPhone. It will sync after reconnection.",
        "Scan a room",
        "Sensors",
        "Settings",
        "The connection was lost. Export the scan or reconnect before importing it.",
        "This Home is now read-only. The scan can still be exported, but it cannot be imported.",
        "This Home is read-only. Room scanning cannot replace its floor plan.",
        "This Home is read-only. Its owner controls shared edits.",
        "This Home's owner controls floor-plan changes.",
        "This Property is read-only. Inventory can be viewed but not changed.",
    ]

    func testCoreFinnishAndSwedishTranslationsArePresent() throws {
        let strings = try catalogStrings(named: "Localizable.xcstrings")
        for key in requiredCoreKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], "Missing key: \(key)")
            for locale in ["fi", "sv"] {
                XCTAssertTrue(
                    isTranslated(entry, locale: locale),
                    "\(key) must have a reviewed \(locale) translation"
                )
            }
        }
    }

    func testGeneralCatalogCoverageDoesNotRegress() throws {
        let strings = try catalogStrings(named: "Localizable.xcstrings")
        for locale in ["fi", "sv"] {
            let translated = strings.values.filter {
                guard let entry = $0 as? [String: Any] else { return false }
                return isTranslated(entry, locale: locale)
            }.count
            XCTAssertGreaterThanOrEqual(
                translated,
                76,
                "Do not remove reviewed \(locale) translations"
            )
            XCTAssertGreaterThanOrEqual(
                Double(translated) / Double(max(strings.count, 1)),
                0.20,
                "Keep at least the established 20% FI/SV catalog floor"
            )
        }
    }

    func testMonitoringCatalogRemainsComplete() throws {
        let strings = try catalogStrings(named: "Monitoring.xcstrings")
        for (key, rawEntry) in strings {
            let entry = try XCTUnwrap(rawEntry as? [String: Any])
            for locale in ["en", "fi", "sv"] {
                XCTAssertTrue(
                    isTranslated(entry, locale: locale),
                    "Monitoring key \(key) is missing \(locale)"
                )
            }
        }
    }

    private func catalogStrings(named name: String) throws -> [String: Any] {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = iosRoot
            .appendingPathComponent("Stugu", isDirectory: true)
            .appendingPathComponent("Resources", isDirectory: true)
            .appendingPathComponent(name, isDirectory: false)
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        return try XCTUnwrap(root["strings"] as? [String: Any])
    }

    private func isTranslated(_ entry: [String: Any], locale: String) -> Bool {
        guard let localizations = entry["localizations"] as? [String: Any],
              let localization = localizations[locale] as? [String: Any],
              let stringUnit = localization["stringUnit"] as? [String: Any],
              stringUnit["state"] as? String == "translated",
              let value = stringUnit["value"] as? String else {
            return false
        }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
