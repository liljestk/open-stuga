import Foundation

public actor TrackingObservationQueue {
    private struct Envelope: Codable {
        var observations: [TrackingObservationInput]
        var droppedCount: Int
    }

    public struct Status: Equatable, Sendable {
        public let queuedCount: Int
        public let droppedCount: Int
    }

    private let storageURL: URL
    private let maximumCount: Int
    private let maximumAge: TimeInterval
    private var envelope: Envelope

    public init(
        storageURL: URL,
        maximumCount: Int = 10_000,
        maximumAge: TimeInterval = 7 * 24 * 60 * 60
    ) {
        self.storageURL = storageURL
        self.maximumCount = max(100, maximumCount)
        self.maximumAge = max(60, maximumAge)
        if let data = try? Data(contentsOf: storageURL),
           let decoded = try? JSONDecoder().decode(Envelope.self, from: data) {
            envelope = decoded
        } else {
            envelope = Envelope(observations: [], droppedCount: 0)
        }
    }

    @discardableResult
    public func enqueue(_ observation: TrackingObservationInput) throws -> Status {
        pruneExpired(referenceDate: Date())
        if !envelope.observations.contains(where: { $0.id == observation.id }) {
            envelope.observations.append(observation)
        }
        if envelope.observations.count > maximumCount {
            let overflow = envelope.observations.count - maximumCount
            envelope.observations.removeFirst(overflow)
            envelope.droppedCount += overflow
        }
        try persist()
        return status
    }

    public func nextBatch(limit: Int, referenceDate: Date = Date()) throws
        -> [TrackingObservationInput] {
        if pruneExpired(referenceDate: referenceDate) {
            try persist()
        }
        return Array(envelope.observations.prefix(max(1, limit)))
    }

    @discardableResult
    public func acknowledge(observationIDs: Set<String>) throws -> Status {
        envelope.observations.removeAll { observationIDs.contains($0.id) }
        try persist()
        return status
    }

    public func removeAll() throws {
        envelope.observations.removeAll()
        try persist()
    }

    public var status: Status {
        Status(
            queuedCount: envelope.observations.count,
            droppedCount: envelope.droppedCount
        )
    }

    @discardableResult
    private func pruneExpired(referenceDate: Date) -> Bool {
        let count = envelope.observations.count
        envelope.observations.removeAll { observation in
            guard let observedAt = StuguDateParser.date(from: observation.observedAt) else {
                return true
            }
            return referenceDate.timeIntervalSince(observedAt) > maximumAge
        }
        return envelope.observations.count != count
    }

    private func persist() throws {
        try FileManager.default.createDirectory(
            at: storageURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(envelope)
        try data.write(to: storageURL, options: [.atomic])
        #if os(iOS)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: storageURL.path
        )
        #endif
    }
}
