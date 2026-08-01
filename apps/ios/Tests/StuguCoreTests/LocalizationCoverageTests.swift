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

    func testGeneralCatalogIsCompleteAndPreservesPlaceholders() throws {
        let strings = try catalogStrings(named: "Localizable.xcstrings")
        for (key, rawEntry) in strings {
            let entry = try XCTUnwrap(rawEntry as? [String: Any])
            for locale in ["fi", "sv"] {
                let value = try XCTUnwrap(
                    translatedValue(entry, locale: locale),
                    "General key \(key) is missing a reviewed \(locale) translation"
                )
                XCTAssertEqual(
                    placeholderSignature(key),
                    placeholderSignature(value),
                    "General key \(key) changes its placeholders in \(locale)"
                )
            }
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
        translatedValue(entry, locale: locale) != nil
    }

    private func translatedValue(
        _ entry: [String: Any],
        locale: String
    ) -> String? {
        guard let localizations = entry["localizations"] as? [String: Any],
              let localization = localizations[locale] as? [String: Any],
              let stringUnit = localization["stringUnit"] as? [String: Any],
              stringUnit["state"] as? String == "translated",
              let value = stringUnit["value"] as? String else {
            return nil
        }
        return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? nil
            : value
    }

    private func placeholderSignature(_ value: String) -> [String] {
        let pattern = #"%(?:(\d+)\$)?[-+0 #']*(?:\d+|\*)?(?:\.(?:\d+|\*))?(hh|h|ll|l|L|z|t|j)?([@diuoxXfFeEgGaAcCsSp%])"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("The placeholder expression must compile")
            return []
        }
        let range = NSRange(value.startIndex..., in: value)
        var implicitPosition = 1
        return expression.matches(in: value, range: range).compactMap { match in
            guard let typeRange = Range(match.range(at: 3), in: value) else {
                return nil
            }
            let type = String(value[typeRange])
            guard type != "%" else { return nil }

            let position: Int
            if let explicitRange = Range(match.range(at: 1), in: value),
               let explicit = Int(value[explicitRange]) {
                position = explicit
            } else {
                position = implicitPosition
                implicitPosition += 1
            }
            let length = Range(match.range(at: 2), in: value)
                .map { String(value[$0]) } ?? ""
            return "\(position):\(length)\(type)"
        }
        .sorted()
    }
}
