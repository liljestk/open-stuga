import Foundation

public struct ServerEvent: Equatable, Sendable {
    public let id: String?
    public let type: String
    public let data: String

    public init(id: String?, type: String, data: String) {
        self.id = id
        self.type = type
        self.data = data
    }
}

public struct SSEParser: Sendable {
    private var id: String?
    private var type = "message"
    private var dataLines: [String] = []

    public init() {}

    public mutating func consume(line: String) -> ServerEvent? {
        if line.isEmpty {
            guard !dataLines.isEmpty else {
                reset()
                return nil
            }
            let event = ServerEvent(id: id, type: type, data: dataLines.joined(separator: "\n"))
            reset()
            return event
        }
        if line.hasPrefix(":") {
            return nil
        }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(parts[0])
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "id":
            id = value
        case "event":
            type = value.isEmpty ? "message" : value
        case "data":
            dataLines.append(value)
        default:
            break
        }
        return nil
    }

    private mutating func reset() {
        id = nil
        type = "message"
        dataLines.removeAll(keepingCapacity: true)
    }
}
