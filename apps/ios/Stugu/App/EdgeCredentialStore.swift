import Foundation
import Security

/// Keeps Cloudflare Access service tokens in the Keychain, keyed by server
/// origin so switching servers never sends one origin's token to another.
final class EdgeCredentialStore {
    private let service = "net.nysta.stuga.edge-access"

    func credential(serverOrigin: String) -> EdgeCredential? {
        guard let data = read(account: serverOrigin) else { return nil }
        return try? JSONDecoder().decode(EdgeCredential.self, from: data)
    }

    func save(_ credential: EdgeCredential, serverOrigin: String) throws {
        try write(try JSONEncoder().encode(credential), account: serverOrigin)
    }

    func remove(serverOrigin: String) {
        SecItemDelete(query(account: serverOrigin) as CFDictionary)
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
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
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
            throw StuguAPIError(
                status: 0,
                code: "KEYCHAIN",
                message: "The Access token could not be stored securely (Keychain \(updateStatus))."
            )
        }
        var insertion = base
        attributes.forEach { insertion[$0.key] = $0.value }
        let insertStatus = SecItemAdd(insertion as CFDictionary, nil)
        guard insertStatus == errSecSuccess else {
            throw StuguAPIError(
                status: 0,
                code: "KEYCHAIN",
                message: "The Access token could not be stored securely (Keychain \(insertStatus))."
            )
        }
    }
}
