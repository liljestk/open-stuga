import Foundation

public struct StugaPlanPoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct StugaWall: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let from: StugaPlanPoint
    public let to: StugaPlanPoint

    public init(id: String, from: StugaPlanPoint, to: StugaPlanPoint) {
        self.id = id
        self.from = from
        self.to = to
    }
}

public struct StugaRoom: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let points: [StugaPlanPoint]
    public let kind: String?

    public init(id: String, name: String, points: [StugaPlanPoint], kind: String? = nil) {
        self.id = id
        self.name = name
        self.points = points
        self.kind = kind
    }
}

public struct StugaOpeningStateBinding: Codable, Equatable, Sendable {
    public let provider: String
    public let externalId: String
    public let connectionId: String?
    public let invert: Bool?
    public let staleAfterSeconds: Int?
}

public struct StugaPlanElement: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let position: StugaPlanPoint
    public let rotationDegrees: Double
    public let width: Double?
    public let height: Double?
    public let label: String?
    public let wallId: String?
    public let variant: String?
    public let state: String?
    public let openFraction: Double?
    public let bottomOffsetM: Double?
    public let stateBinding: StugaOpeningStateBinding?
    public let nominalFlowM3h: Double?
    public let verticalExtent: String?
    public let chimneyHeightAboveRoof: Double?
    public let chimneyWidth: Double?
    public let chimneyDepth: Double?
    public let projection: Double?

    public init(
        id: String,
        kind: String,
        position: StugaPlanPoint,
        rotationDegrees: Double,
        width: Double? = nil,
        height: Double? = nil,
        label: String? = nil,
        wallId: String? = nil,
        variant: String? = nil,
        state: String? = nil,
        openFraction: Double? = nil,
        bottomOffsetM: Double? = nil,
        stateBinding: StugaOpeningStateBinding? = nil,
        nominalFlowM3h: Double? = nil,
        verticalExtent: String? = nil,
        chimneyHeightAboveRoof: Double? = nil,
        chimneyWidth: Double? = nil,
        chimneyDepth: Double? = nil,
        projection: Double? = nil
    ) {
        self.id = id
        self.kind = kind
        self.position = position
        self.rotationDegrees = rotationDegrees
        self.width = width
        self.height = height
        self.label = label
        self.wallId = wallId
        self.variant = variant
        self.state = state
        self.openFraction = openFraction
        self.bottomOffsetM = bottomOffsetM
        self.stateBinding = stateBinding
        self.nominalFlowM3h = nominalFlowM3h
        self.verticalExtent = verticalExtent
        self.chimneyHeightAboveRoof = chimneyHeightAboveRoof
        self.chimneyWidth = chimneyWidth
        self.chimneyDepth = chimneyDepth
        self.projection = projection
    }
}

public struct StugaRoofDesign: Codable, Equatable, Sendable {
    public let style: String
    public let pitchDegrees: Double
    public let ridgeAxis: String
    public let overhang: Double
    public let eavesHeight: Double
}

public struct StugaFloor: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let type: String?
    public let width: Double
    public let height: Double
    public let metersPerPlanUnit: Double?
    public let elevation: Double
    public let ceilingHeight: Double?
    public let wallHeight: Double?
    public let roof: StugaRoofDesign?
    public let walls: [StugaWall]
    public let rooms: [StugaRoom]
    public let planElements: [StugaPlanElement]?
    public let backgroundImage: String?

    public init(
        id: String,
        name: String,
        type: String? = nil,
        width: Double,
        height: Double,
        metersPerPlanUnit: Double? = nil,
        elevation: Double,
        ceilingHeight: Double? = nil,
        wallHeight: Double? = nil,
        roof: StugaRoofDesign? = nil,
        walls: [StugaWall],
        rooms: [StugaRoom],
        planElements: [StugaPlanElement]? = nil,
        backgroundImage: String? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.width = width
        self.height = height
        self.metersPerPlanUnit = metersPerPlanUnit
        self.elevation = elevation
        self.ceilingHeight = ceilingHeight
        self.wallHeight = wallHeight
        self.roof = roof
        self.walls = walls
        self.rooms = rooms
        self.planElements = planElements
        self.backgroundImage = backgroundImage
    }
}

public struct RoomScanWall: Equatable, Sendable {
    public let id: String
    public let from: StugaPlanPoint
    public let to: StugaPlanPoint
    public let height: Double

    public init(
        id: String,
        from: StugaPlanPoint,
        to: StugaPlanPoint,
        height: Double
    ) {
        self.id = id
        self.from = from
        self.to = to
        self.height = height
    }
}

public struct RoomScanOpening: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case door
        case window
        case opening
    }

    public let id: String
    public let kind: Kind
    public let center: StugaPlanPoint
    public let width: Double
    public let height: Double
    public let bottomOffsetM: Double
    public let parentWallId: String?
    public let isOpen: Bool?

    public init(
        id: String,
        kind: Kind,
        center: StugaPlanPoint,
        width: Double,
        height: Double,
        bottomOffsetM: Double,
        parentWallId: String? = nil,
        isOpen: Bool? = nil
    ) {
        self.id = id
        self.kind = kind
        self.center = center
        self.width = width
        self.height = height
        self.bottomOffsetM = bottomOffsetM
        self.parentWallId = parentWallId
        self.isOpen = isOpen
    }
}

public struct RoomScanGeometry: Equatable, Sendable {
    public let id: String
    public let capturedAt: String
    public let walls: [RoomScanWall]
    public let floorPolygon: [StugaPlanPoint]
    public let openings: [RoomScanOpening]

    public init(
        id: String,
        capturedAt: String,
        walls: [RoomScanWall],
        floorPolygon: [StugaPlanPoint],
        openings: [RoomScanOpening]
    ) {
        self.id = id
        self.capturedAt = capturedAt
        self.walls = walls
        self.floorPolygon = floorPolygon
        self.openings = openings
    }
}

public enum RoomPlanDraftError: LocalizedError, Equatable {
    case notEnoughGeometry
    case multipleExistingRooms

    public var errorDescription: String? {
        switch self {
        case .notEnoughGeometry:
            return "The scan did not contain enough reliable floor geometry."
        case .multipleExistingRooms:
            return "This floor contains several rooms. Import into an empty or single-room floor to avoid overwriting unrelated rooms."
        }
    }
}

public enum RoomPlanDraftBuilder {
    private static let margin = 0.25

    public static func replacing(
        _ existing: StugaFloor,
        with geometry: RoomScanGeometry,
        roomName: String
    ) throws -> StugaFloor {
        guard existing.rooms.count <= 1 else {
            throw RoomPlanDraftError.multipleExistingRooms
        }
        let validWalls = geometry.walls.filter {
            finite($0.from) && finite($0.to) && $0.height.isFinite
                && distance($0.from, $0.to) >= 0.1
        }
        let wallPoints = validWalls.flatMap { [$0.from, $0.to] }
        let polygonSource = geometry.floorPolygon.filter(finite)
        let scannedOutline = normalizedOutline(polygonSource)
        let outline = scannedOutline.count >= 3
            && outlineFitsWalls(scannedOutline, wallPoints: wallPoints)
            ? scannedOutline
            : convexHull(wallPoints)
        guard validWalls.count >= 2, outline.count >= 3 else {
            throw RoomPlanDraftError.notEnoughGeometry
        }

        let allPoints = validWalls.flatMap { [$0.from, $0.to] } + outline
        guard let minimumX = allPoints.map(\.x).min(),
              let maximumX = allPoints.map(\.x).max(),
              let minimumY = allPoints.map(\.y).min(),
              let maximumY = allPoints.map(\.y).max() else {
            throw RoomPlanDraftError.notEnoughGeometry
        }
        let shiftX = Self.margin - minimumX
        let shiftY = Self.margin - minimumY
        let shift: (StugaPlanPoint) -> StugaPlanPoint = {
            StugaPlanPoint(x: $0.x + shiftX, y: $0.y + shiftY)
        }
        let walls = validWalls.map {
            StugaWall(
                id: normalizedID("roomplan-wall", $0.id),
                from: shift($0.from),
                to: shift($0.to)
            )
        }
        let wallIDByScanID = Dictionary(
            uniqueKeysWithValues: zip(
                validWalls.map(\.id),
                walls.map(\.id)
            )
        )
        let elements = geometry.openings.compactMap { opening -> StugaPlanElement? in
            guard opening.width.isFinite, opening.width >= 0.1,
                  opening.height.isFinite, opening.height >= 0.1,
                  finite(opening.center) else {
                return nil
            }
            let preferredWallID = opening.parentWallId.flatMap {
                wallIDByScanID[$0]
            }
            guard let wall = preferredWallID.flatMap({ id in
                walls.first { $0.id == id }
            }) ?? walls.min(by: {
                distanceFromPoint(shift(opening.center), to: $0)
                    < distanceFromPoint(shift(opening.center), to: $1)
            }),
            let position = openingPosition(
                near: shift(opening.center),
                width: opening.width,
                on: wall
            ) else {
                return nil
            }
            let kind = opening.kind == .window ? "window" : "door"
            let variant = opening.kind == .opening ? "open-passage" : nil
            let state: String? = opening.isOpen.map { $0 ? "open" : "closed" }
            return StugaPlanElement(
                id: normalizedID("roomplan-\(kind)", opening.id),
                kind: kind,
                position: position,
                rotationDegrees: wallRotation(wall),
                width: opening.width,
                height: opening.height,
                label: opening.kind == .opening ? "Open passage" : nil,
                wallId: wall.id,
                variant: variant,
                state: state,
                openFraction: opening.isOpen == true ? 1 : nil,
                bottomOffsetM: max(0, opening.bottomOffsetM)
            )
        }
        let wallHeights = validWalls.map(\.height).filter { $0 > 1 && $0 < 20 }.sorted()
        let scannedWallHeight = wallHeights.isEmpty
            ? nil
            : wallHeights[wallHeights.count / 2]
        let safeName = String(
            roomName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)
        )
        let roomID = existing.rooms.first?.id
            ?? normalizedID("roomplan-room", geometry.id)

        return StugaFloor(
            id: existing.id,
            name: existing.name,
            type: existing.type,
            width: max(0.5, maximumX - minimumX + 2 * Self.margin),
            height: max(0.5, maximumY - minimumY + 2 * Self.margin),
            metersPerPlanUnit: 1,
            elevation: existing.elevation,
            ceilingHeight: scannedWallHeight ?? existing.ceilingHeight,
            wallHeight: scannedWallHeight ?? existing.wallHeight,
            roof: existing.roof,
            walls: walls,
            rooms: [
                StugaRoom(
                    id: roomID,
                    name: safeName.isEmpty ? "Scanned room" : safeName,
                    points: outline.map(shift)
                ),
            ],
            planElements: elements,
            backgroundImage: nil
        )
    }

    private static func finite(_ point: StugaPlanPoint) -> Bool {
        point.x.isFinite && point.y.isFinite
    }

    private static func distance(_ left: StugaPlanPoint, _ right: StugaPlanPoint) -> Double {
        hypot(right.x - left.x, right.y - left.y)
    }

    private static func normalizedID(_ prefix: String, _ value: String) -> String {
        let safe = value.lowercased().unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0)
                || "-".unicodeScalars.contains($0)
                ? Character(String($0))
                : "-"
        }
        return String("\(prefix)-\(String(safe))".prefix(200))
    }

    private static func cross(
        _ origin: StugaPlanPoint,
        _ left: StugaPlanPoint,
        _ right: StugaPlanPoint
    ) -> Double {
        (left.x - origin.x) * (right.y - origin.y)
            - (left.y - origin.y) * (right.x - origin.x)
    }

    private static func convexHull(_ values: [StugaPlanPoint]) -> [StugaPlanPoint] {
        let grouped: [String: [StugaPlanPoint]] = Dictionary(grouping: values) { point in
            let x = Int((point.x * 10_000).rounded())
            let y = Int((point.y * 10_000).rounded())
            return "\(x):\(y)"
        }
        let points = grouped.values
            .compactMap { $0.first }
            .sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard points.count > 2 else { return points }

        var lower: [StugaPlanPoint] = []
        for point in points {
            while lower.count >= 2,
                  cross(lower[lower.count - 2], lower[lower.count - 1], point) <= 0 {
                lower.removeLast()
            }
            lower.append(point)
        }
        var upper: [StugaPlanPoint] = []
        for point in points.reversed() {
            while upper.count >= 2,
                  cross(upper[upper.count - 2], upper[upper.count - 1], point) <= 0 {
                upper.removeLast()
            }
            upper.append(point)
        }
        lower.removeLast()
        upper.removeLast()
        return lower + upper
    }

    private static func normalizedOutline(
        _ values: [StugaPlanPoint]
    ) -> [StugaPlanPoint] {
        var points: [StugaPlanPoint] = []
        for point in values where !points.contains(where: {
            distance($0, point) < 0.01
        }) {
            points.append(point)
        }
        if points.count >= 3,
           abs(signedArea(points)) >= 0.01 {
            return points
        }
        return []
    }

    private static func signedArea(_ points: [StugaPlanPoint]) -> Double {
        guard points.count >= 3 else { return 0 }
        return points.indices.reduce(into: 0) { area, index in
            let next = points[(index + 1) % points.count]
            area += points[index].x * next.y - next.x * points[index].y
        } / 2
    }

    private static func outlineFitsWalls(
        _ outline: [StugaPlanPoint],
        wallPoints: [StugaPlanPoint]
    ) -> Bool {
        guard outline.count >= 3, wallPoints.count >= 3 else { return false }
        let closePoints = wallPoints.filter { point in
            outline.indices.contains { index in
                distance(
                    point,
                    toSegmentFrom: outline[index],
                    to: outline[(index + 1) % outline.count]
                ) <= 0.5
            }
        }
        let requiredCount = max(
            3,
            Int(ceil(Double(wallPoints.count) * 0.6))
        )
        return closePoints.count >= requiredCount
    }

    private static func distance(
        _ point: StugaPlanPoint,
        toSegmentFrom start: StugaPlanPoint,
        to end: StugaPlanPoint
    ) -> Double {
        let dx = end.x - start.x
        let dy = end.y - start.y
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0 else { return distance(point, start) }
        let position = max(
            0,
            min(
                1,
                ((point.x - start.x) * dx + (point.y - start.y) * dy)
                    / lengthSquared
            )
        )
        return distance(
            point,
            StugaPlanPoint(
                x: start.x + position * dx,
                y: start.y + position * dy
            )
        )
    }

    private static func wallRotation(_ wall: StugaWall) -> Double {
        let degrees = atan2(wall.to.y - wall.from.y, wall.to.x - wall.from.x)
            * 180 / .pi
        return degrees >= 0 ? degrees : degrees + 360
    }

    private static func distanceFromPoint(
        _ point: StugaPlanPoint,
        to wall: StugaWall
    ) -> Double {
        let dx = wall.to.x - wall.from.x
        let dy = wall.to.y - wall.from.y
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0 else { return distance(point, wall.from) }
        let t = max(
            0,
            min(
                1,
                ((point.x - wall.from.x) * dx + (point.y - wall.from.y) * dy)
                    / lengthSquared
            )
        )
        return distance(
            point,
            StugaPlanPoint(
                x: wall.from.x + t * dx,
                y: wall.from.y + t * dy
            )
        )
    }

    private static func openingPosition(
        near point: StugaPlanPoint,
        width: Double,
        on wall: StugaWall
    ) -> StugaPlanPoint? {
        let dx = wall.to.x - wall.from.x
        let dy = wall.to.y - wall.from.y
        let length = hypot(dx, dy)
        guard length >= width, length > 0 else { return nil }
        let distanceAlong = (
            (point.x - wall.from.x) * dx + (point.y - wall.from.y) * dy
        ) / length
        let halfWidth = width / 2
        let fittedDistance = min(
            length - halfWidth,
            max(halfWidth, distanceAlong)
        )
        return StugaPlanPoint(
            x: wall.from.x + dx / length * fittedDistance,
            y: wall.from.y + dy / length * fittedDistance
        )
    }
}
