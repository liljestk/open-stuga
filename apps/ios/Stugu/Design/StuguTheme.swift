import SwiftUI
import UIKit

enum StuguTheme {
    static let canvas = adaptive(light: 0xF1EFE9, dark: 0x121411)
    static let surface = adaptive(light: 0xFCFBF7, dark: 0x1B1D19)
    static let surfaceRaised = adaptive(light: 0xFFFFFF, dark: 0x232620)
    static let ink = adaptive(light: 0x1B1D1A, dark: 0xF2F0E9)
    static let muted = adaptive(light: 0x60635D, dark: 0xB4B8AF)
    static let line = adaptive(light: 0xDEDBD2, dark: 0x464B43)
    static let strongLine = adaptive(light: 0x919088, dark: 0x666B61)
    static let action = adaptive(light: 0x0755C9, dark: 0x78A7FF)
    static let actionText = adaptive(light: 0xFFFFFF, dark: 0x111A2A)
    static let brand = adaptive(light: 0xB54122, dark: 0xE06B4C)
    static let success = adaptive(light: 0x007A5C, dark: 0x5DD6B2)
    static let warning = adaptive(light: 0x795000, dark: 0xF2C14E)
    static let critical = adaptive(light: 0xB42318, dark: 0xFF8A80)
    static let warningSurface = adaptive(light: 0xFFF1C7, dark: 0x352B13)
    static let criticalSurface = adaptive(light: 0xFDECEA, dark: 0x3B1C19)

    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
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
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(StuguTheme.line, lineWidth: 1)
            }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(StuguTheme.actionText)
            .background(configuration.isPressed ? StuguTheme.action.opacity(0.82) : StuguTheme.action)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 46)
            .foregroundStyle(StuguTheme.ink)
            .background(configuration.isPressed ? StuguTheme.line.opacity(0.55) : StuguTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
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
