import SwiftUI

// The mark keeps the same colours in both appearances (DESIGN.md §3).
struct StuguMark: View {
    private static let tile = StuguTheme.fixed(0x22303D)
    private static let house = StuguTheme.fixed(0xE9EFF3)
    private static let door = StuguTheme.fixed(0x141E28)

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.075, style: .continuous)
                    .fill(Self.tile)
                CottageShape()
                    .fill(Self.house)
                Circle()
                    .fill(StuguTheme.lantern)
                    .frame(width: size * 0.2, height: size * 0.2)
                    .offset(y: -size * 0.0375)
                Rectangle()
                    .fill(Self.door)
                    .frame(width: size * 0.15, height: size * 0.225)
                    .offset(y: size * 0.2375)
            }
            .frame(width: size, height: size)
            .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private struct CottageShape: Shape {
        func path(in rect: CGRect) -> Path {
            let point: (CGFloat, CGFloat) -> CGPoint = {
                CGPoint(x: rect.minX + rect.width * $0, y: rect.minY + rect.height * $1)
            }
            var path = Path()
            path.move(to: point(0.15, 0.4625))
            path.addLine(to: point(0.5, 0.15))
            path.addLine(to: point(0.85, 0.4625))
            path.addLine(to: point(0.85, 0.85))
            path.addLine(to: point(0.15, 0.85))
            path.closeSubpath()
            return path
        }
    }
}

struct StuguLockup: View {
    let compact: Bool

    init(compact: Bool = false) {
        self.compact = compact
    }

    var body: some View {
        HStack(spacing: compact ? 10 : 14) {
            StuguMark()
                .frame(width: compact ? 36 : 52, height: compact ? 36 : 52)
            VStack(alignment: .leading, spacing: 1) {
                Text("Stugu")
                    .font(compact ? .title2.weight(.bold) : .largeTitle.weight(.bold))
                    .tracking(-1)
                    .foregroundStyle(StuguTheme.ink)
                if !compact {
                    Text("Your home, in balance.")
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
