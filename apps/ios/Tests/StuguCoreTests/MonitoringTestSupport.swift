import Foundation
@testable import StuguCore

func monitoringResponse(
    pulseStatus: String = "attention",
    insightKind: String? = "humidity"
) throws -> HomeMonitoringDetailResponse {
    let insight: String
    if let insightKind {
        insight = #"""
        [{
          "id": "insight-1",
          "rank": 1,
          "kind": "\#(insightKind)",
          "severity": "warning",
          "priority": 78,
          "titleCode": "monitoring.insight.\#(insightKind).title",
          "summaryCode": "monitoring.insight.\#(insightKind).summary",
          "actionCode": "monitoring.insight.\#(insightKind).action",
          "parameters": { "room": "Kitchen" },
          "fallbackTitle": "Humidity is elevated in Kitchen",
          "fallbackSummary": "The latest relative humidity is 72%.",
          "fallbackAction": "Inspect the room and ventilate when appropriate.",
          "target": {
            "houseId": "home-1",
            "sensorId": "sensor-kitchen",
            "sensorName": "Kitchen T310",
            "floorId": "ground",
            "floorName": "Ground floor",
            "room": "Kitchen"
          },
          "evidence": [{
            "label": "Latest humidity",
            "value": 72,
            "unit": "%",
            "metric": "humidity",
            "sensorId": "sensor-kitchen",
            "observedAt": "2027-01-15T08:00:00Z"
          }],
          "freshness": {
            "state": "fresh",
            "evidenceAt": "2027-01-15T08:00:00Z",
            "ageMinutes": 1
          },
          "confidence": {
            "level": "high",
            "score": 0.92,
            "reasonCode": "monitoring.confidence.high",
            "fallbackReason": "Fresh evidence."
          },
          "safetyNote": null
        }]
        """#
    } else {
        insight = "[]"
    }
    let data = Data(#"""
    {
      "apiVersion": "1.0",
      "dataMode": "live",
      "algorithm": {
        "key": "home-monitoring",
        "version": "home-monitoring-v2.0.0"
      },
      "generatedAt": "2027-01-15T08:01:00Z",
      "evaluatedAt": "2027-01-15T08:01:00Z",
      "completeness": "complete",
      "warnings": [],
      "provenance": {
        "algorithmKey": "home-monitoring",
        "algorithmVersion": "home-monitoring-v2.0.0",
        "evaluatedAt": "2027-01-15T08:01:00Z",
        "sourceIds": ["sensor-kitchen"]
      },
      "house": {
        "houseId": "home-1",
        "generatedAt": "2027-01-15T08:01:00Z",
        "status": "inspection-recommended",
        "pulseStatus": "\#(pulseStatus)",
        "coverage": {
          "enabledSensors": 1,
          "freshSensors": 1,
          "estimatedSensors": 0,
          "agingSensors": 0,
          "staleSensors": 0,
          "sensorsWithoutData": 0
        },
        "activeAlertCount": 0,
        "blockers": []
      },
      "sensorCoverage": [{
        "sensorId": "sensor-kitchen",
        "freshness": {
          "state": "fresh",
          "evidenceAt": "2027-01-15T08:00:00Z",
          "ageMinutes": 1
        },
        "requiredMetrics": ["temperature", "humidity"]
      }],
      "insights": \#(insight),
      "advisoryCode": "monitoring.advisory",
      "fallbackAdvisory": "Monitoring advice."
    }
    """#.utf8)
    return try JSONDecoder().decode(HomeMonitoringDetailResponse.self, from: data)
}
