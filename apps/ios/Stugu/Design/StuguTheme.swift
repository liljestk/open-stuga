import SwiftUI
import UIKit

// Kaamos palette from DESIGN.md §4: snow in light, polar night in dark.
enum StuguTheme {
    static let canvas = adaptive(light: 0xEEF2F5, dark: 0x141E28)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x1B2733)
    static let surfaceRaised = adaptive(light: 0xFFFFFF, dark: 0x22303D)
    static let ink = adaptive(light: 0x15212C, dark: 0xE9EFF3)
    static let muted = adaptive(light: 0x566573, dark: 0xA2B1BD)
    static let line = adaptive(light: 0xD6DEE5, dark: 0x2C3B49)
    static let strongLine = adaptive(light: 0x8796A3, dark: 0x667A8D)
    static let action = adaptive(light: 0x1F5F92, dark: 0x8CC8F0)
    static let actionPressed = adaptive(light: 0x164A73, dark: 0xB0DAF5)
    static let actionText = adaptive(light: 0xFFFFFF, dark: 0x0C1A26)
    static let warm = adaptive(light: 0xB4461F, dark: 0xFF9A6E)
    static let success = adaptive(light: 0x1D6B55, dark: 0x7ED6B0)
    static let warning = adaptive(light: 0x7A5100, dark: 0xE5CF62)
    static let critical = adaptive(light: 0xB3261E, dark: 0xFF8F86)
    static let warningSurface = adaptive(light: 0xFBEFCF, dark: 0x36321B)
    static let criticalSurface = adaptive(light: 0xFBE7E5, dark: 0x482426)
    /// The lit window. Reserved for the mark and a current-place marker; never a status colour.
    static let lantern = fixed(0xF2B33D)

    enum Radius {
        /// Small tools and chips.
        static let small: CGFloat = 4
        /// Controls, fields, icon tiles and thumbnails.
        static let control: CGFloat = 8
        /// Cards and panels.
        static let card: CGFloat = 12
        /// Dialogs and large media frames.
        static let large: CGFloat = 16
    }

    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    static func fixed(_ hex: UInt32) -> Color {
        Color(uiColor: UIColor(hex: hex))
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

struct StuguScreenBackground: View {
    var body: some View {
        StuguTheme.canvas.ignoresSafeArea()
    }
}

struct StuguCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StuguTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: StuguTheme.Radius.card, style: .continuous)
                    .stroke(StuguTheme.line, lineWidth: 1)
            }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(StuguTheme.actionText)
            .background(configuration.isPressed ? StuguTheme.actionPressed : StuguTheme.action)
            .clipShape(Capsule())
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, minHeight: 46)
            .foregroundStyle(StuguTheme.ink)
            .background(configuration.isPressed ? StuguTheme.line.opacity(0.55) : StuguTheme.surface)
            .clipShape(Capsule())
            .overlay {
                Capsule()
                    .stroke(StuguTheme.strongLine, lineWidth: 1)
            }
    }
}

struct StatusPill: View {
    let label: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
            .overlay { Capsule().stroke(color.opacity(0.5), lineWidth: 1) }
    }
}
