import Foundation
import Security

struct TrackingObserverIdentity: Codable, Equatable {
    let serverOrigin: String
    let propertyId: String
    let observerId: String
    let credential: String
    let installationId: String
}

final class TrackingCredentialStore {
    enum StoreError: LocalizedError {
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case let .keychain(status):
                "The tracking credential could not be stored securely (Keychain \(status))."
            }
        }
    }

    private let service = "net.nysta.stuga.tracking-observer"
    private let installationAccount = "installation-id"

    func installationID() throws -> String {
        if let data = read(account: installationAccount),
           let value = String(data: data, encoding: .utf8),
           !value.isEmpty {
            return value
        }
        let value = UUID().uuidString.lowercased()
        try write(Data(value.utf8), account: installationAccount)
        return value
    }

    func identity(serverOrigin: String, propertyID: String) -> TrackingObserverIdentity? {
        guard let data = read(account: account(serverOrigin: serverOrigin, propertyID: propertyID)) else {
            return nil
        }
        return try? JSONDecoder().decode(TrackingObserverIdentity.self, from: data)
    }

    func save(_ identity: TrackingObserverIdentity) throws {
        let data = try JSONEncoder().encode(identity)
        try write(
            data,
            account: account(serverOrigin: identity.serverOrigin, propertyID: identity.propertyId)
        )
    }

    func remove(serverOrigin: String, propertyID: String) throws {
        let status = SecItemDelete(query(
            account: account(serverOrigin: serverOrigin, propertyID: propertyID)
        ) as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            throw StoreError.keychain(status)
        }
    }

    private func account(serverOrigin: String, propertyID: String) -> String {
        "\(serverOrigin)|\(propertyID)"
    }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func read(account: String) -> Data? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    private func write(_ data: Data, account: String) throws {
        let base = query(account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw StoreError.keychain(updateStatus)
        }
        var insertion = base
        attributes.forEach { insertion[$0.key] = $0.value }
        let insertStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw StoreError.keychain(insertStatus)
        }
    }
}
