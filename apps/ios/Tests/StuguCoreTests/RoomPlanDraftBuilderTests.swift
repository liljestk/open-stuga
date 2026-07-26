import XCTest
@testable import StuguCore

final class RoomPlanDraftBuilderTests: XCTestCase {
    func testBuildsMetreScaleFloorAndKeepsExistingRoomIdentity() throws {
        let floor = StuguFloor(
            id: "floor-1",
            name: "Ground floor",
            width: 8,
            height: 8,
            elevation: 0,
            walls: [],
            rooms: [
                StuguRoom(
                    id: "room-1",
                    name: "Old room",
                    points: [
                        .init(x: 0, y: 0),
                        .init(x: 1, y: 0),
                        .init(x: 1, y: 1),
                    ]
                ),
            ]
        )
        let geometry = RoomScanGeometry(
            id: "capture-1",
            capturedAt: "2027-01-15T08:00:00Z",
            walls: [
                .init(
                    id: "wall-1",
                    from: .init(x: -2, y: -1.5),
                    to: .init(x: 2, y: -1.5),
                    height: 2.45
                ),
                .init(
                    id: "wall-2",
                    from: .init(x: 2, y: -1.5),
                    to: .init(x: 2, y: 1.5),
                    height: 2.5
                ),
                .init(
                    id: "wall-3",
                    from: .init(x: 2, y: 1.5),
                    to: .init(x: -2, y: 1.5),
                    height: 2.48
                ),
                .init(
                    id: "wall-4",
                    from: .init(x: -2, y: 1.5),
                    to: .init(x: -2, y: -1.5),
                    height: 2.47
                ),
            ],
            floorPolygon: [
                .init(x: -2, y: -1.5),
                .init(x: 2, y: -1.5),
                .init(x: 2, y: 1.5),
                .init(x: -2, y: 1.5),
            ],
            openings: [
                .init(
                    id: "door-1",
                    kind: .door,
                    center: .init(x: 0, y: -1.47),
                    width: 0.9,
                    height: 2.05,
                    bottomOffsetM: 0,
                    parentWallId: "wall-1",
                    isOpen: false
                ),
            ]
        )

        let result = try RoomPlanDraftBuilder.replacing(
            floor,
            with: geometry,
            roomName: "Living room"
        )

        XCTAssertEqual(result.metersPerPlanUnit, 1)
        XCTAssertEqual(result.rooms.first?.id, "room-1")
        XCTAssertEqual(result.rooms.first?.name, "Living room")
        XCTAssertEqual(result.walls.count, 4)
        XCTAssertEqual(result.planElements?.first?.wallId, "roomplan-wall-wall-1")
        XCTAssertEqual(
            result.planElements?.first?.position.y ?? .nan,
            0.25,
            accuracy: 0.000_001
        )
        XCTAssertEqual(result.backgroundImage, nil)
        XCTAssertTrue(result.rooms[0].points.allSatisfy { $0.x >= 0 && $0.y >= 0 })
    }

    func testRefusesToFlattenAMultiRoomFloor() {
        let rooms = ["one", "two"].map {
            StuguRoom(
                id: $0,
                name: $0,
                points: [
                    .init(x: 0, y: 0),
                    .init(x: 1, y: 0),
                    .init(x: 1, y: 1),
                ]
            )
        }
        let floor = StuguFloor(
            id: "floor-1",
            name: "Ground floor",
            width: 2,
            height: 2,
            elevation: 0,
            walls: [],
            rooms: rooms
        )
        let geometry = RoomScanGeometry(
            id: "capture-1",
            capturedAt: "2027-01-15T08:00:00Z",
            walls: [],
            floorPolygon: [],
            openings: []
        )

        XCTAssertThrowsError(
            try RoomPlanDraftBuilder.replacing(
                floor,
                with: geometry,
                roomName: "Room"
            )
        ) {
            XCTAssertEqual($0 as? RoomPlanDraftError, .multipleExistingRooms)
        }
    }

    func testPreservesAConcaveScannedRoomOutline() throws {
        let floor = StuguFloor(
            id: "floor-1",
            name: "Ground floor",
            width: 5,
            height: 4,
            elevation: 0,
            walls: [],
            rooms: []
        )
        let geometry = RoomScanGeometry(
            id: "capture-1",
            capturedAt: "2027-01-15T08:00:00Z",
            walls: [
                .init(
                    id: "wall-1",
                    from: .init(x: 0, y: 0),
                    to: .init(x: 4, y: 0),
                    height: 2.4
                ),
                .init(
                    id: "wall-2",
                    from: .init(x: 4, y: 0),
                    to: .init(x: 4, y: 3),
                    height: 2.4
                ),
            ],
            floorPolygon: [
                .init(x: 0, y: 0),
                .init(x: 4, y: 0),
                .init(x: 4, y: 3),
                .init(x: 2, y: 3),
                .init(x: 2, y: 1),
                .init(x: 0, y: 1),
            ],
            openings: []
        )

        let result = try RoomPlanDraftBuilder.replacing(
            floor,
            with: geometry,
            roomName: "L-shaped room"
        )

        XCTAssertEqual(result.rooms.first?.points.count, 6)
        XCTAssertTrue(
            result.rooms.first?.points.contains(.init(x: 2.25, y: 1.25))
                == true
        )
    }

    func testFallsBackToWallBoundsWhenFloorPolygonIsMisaligned() throws {
        let floor = StuguFloor(
            id: "floor-1",
            name: "Ground floor",
            width: 5,
            height: 4,
            elevation: 0,
            walls: [],
            rooms: []
        )
        let geometry = RoomScanGeometry(
            id: "capture-1",
            capturedAt: "2027-01-15T08:00:00Z",
            walls: [
                .init(
                    id: "wall-1",
                    from: .init(x: 0, y: 0),
                    to: .init(x: 4, y: 0),
                    height: 2.4
                ),
                .init(
                    id: "wall-2",
                    from: .init(x: 4, y: 0),
                    to: .init(x: 4, y: 3),
                    height: 2.4
                ),
                .init(
                    id: "wall-3",
                    from: .init(x: 4, y: 3),
                    to: .init(x: 0, y: 3),
                    height: 2.4
                ),
                .init(
                    id: "wall-4",
                    from: .init(x: 0, y: 3),
                    to: .init(x: 0, y: 0),
                    height: 2.4
                ),
            ],
            floorPolygon: [
                .init(x: 20, y: 20),
                .init(x: 24, y: 20),
                .init(x: 24, y: 23),
                .init(x: 20, y: 23),
            ],
            openings: []
        )

        let result = try RoomPlanDraftBuilder.replacing(
            floor,
            with: geometry,
            roomName: "Room"
        )

        XCTAssertEqual(result.width, 4.5, accuracy: 0.000_001)
        XCTAssertEqual(result.height, 3.5, accuracy: 0.000_001)
        XCTAssertTrue(result.rooms[0].points.allSatisfy { $0.x < 5 && $0.y < 4 })
    }
}
