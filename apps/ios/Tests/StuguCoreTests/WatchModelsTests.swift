import Foundation
import XCTest
@testable import StuguCore

final class WatchModelsTests: XCTestCase {
    func testVersionOneSnapshotDecodesReadOnlyWithoutActionContext() throws {
        let data = Data(
            #"{"schemaVersion":1,"available":true,"homeId":"home-1","homeName":"Forest cottage","state":"attention","title":"Check the utility room","detail":"One alert needs attention","updatedAt":"2027-01-15T08:00:00Z","cached":false,"readOnly":false,"alerts":[]}"#.utf8
        )

        let snapshot = try JSONDecoder().decode(WatchHomeSnapshot.self, from: data)

        XCTAssertEqual(snapshot.schemaVersion, WatchHomeSnapshot.currentSchemaVersion)
        XCTAssertFalse(snapshot.readOnly)
        XCTAssertNil(snapshot.actionContext)
    }

    func testActionOnlyMatchesItsServerAccountAndHomeContext() throws {
        let context = WatchActionContext(
            serverBinding: "server-binding",
            accountBinding: "account-binding",
            homeId: "home-1"
        )
        let action = WatchCompanionAction(
            alertId: "alert-1",
            createdAt: "2027-01-15T08:00:00Z",
            context: context
        )

        XCTAssertTrue(action.isBound(to: context))
        XCTAssertFalse(action.isBound(to: WatchActionContext(
            serverBinding: "other-server",
            accountBinding: context.accountBinding,
            homeId: context.homeId
        )))
        XCTAssertFalse(action.isBound(to: WatchActionContext(
            serverBinding: context.serverBinding,
            accountBinding: "other-account",
            homeId: context.homeId
        )))
        XCTAssertFalse(action.isBound(to: WatchActionContext(
            serverBinding: context.serverBinding,
            accountBinding: context.accountBinding,
            homeId: "home-2"
        )))
    }

    func testLegacyUnboundActionCannotMatchCurrentContext() throws {
        let data = Data(
            #"{"id":"action-1","kind":"acknowledgeAlert","alertId":"alert-1","createdAt":"2027-01-15T08:00:00Z"}"#.utf8
        )
        let action = try JSONDecoder().decode(WatchCompanionAction.self, from: data)
        let context = WatchActionContext(
            serverBinding: "server-binding",
            accountBinding: "account-binding",
            homeId: "home-1"
        )

        XCTAssertNil(action.context)
        XCTAssertFalse(action.isBound(to: context))
    }
}
