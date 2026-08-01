import Foundation
import XCTest
@testable import StuguCore

final class WatchModelsTests: XCTestCase {
    func testCompanionPayloadKeysKeepActionsAndDurableReceiptsDistinct() {
        XCTAssertEqual(WatchCompanionPayload.actionDataKey, "stuguWatchAction")
        XCTAssertEqual(
            WatchCompanionPayload.actionReceiptIDKey,
            "stuguWatchActionReceiptID"
        )
        XCTAssertNotEqual(
            WatchCompanionPayload.actionDataKey,
            WatchCompanionPayload.actionReceiptIDKey
        )
    }

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

    func testActionDeliveryWindowRejectsExpiredAndFarFutureActions() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let formatter = ISO8601DateFormatter()
        let context = WatchActionContext(
            serverBinding: "server-binding",
            accountBinding: "account-binding",
            homeId: "home-1"
        )
        let current = WatchCompanionAction(
            alertId: "alert-current",
            createdAt: formatter.string(from: now),
            context: context
        )
        let expired = WatchCompanionAction(
            alertId: "alert-expired",
            createdAt: formatter.string(from: now.addingTimeInterval(
                -WatchCompanionAction.deliveryLifetime - 1
            )),
            context: context
        )
        let future = WatchCompanionAction(
            alertId: "alert-future",
            createdAt: formatter.string(from: now.addingTimeInterval(
                WatchCompanionAction.maximumFutureClockSkew + 1
            )),
            context: context
        )

        XCTAssertTrue(current.isWithinDeliveryWindow(at: now))
        XCTAssertFalse(expired.isWithinDeliveryWindow(at: now))
        XCTAssertFalse(future.isWithinDeliveryWindow(at: now))
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
