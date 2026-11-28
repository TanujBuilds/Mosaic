import Foundation

enum MosaicError: Error { case invalidCommand, invalidResource }

/// Renderer inputs are data only. Executables, file paths, URLs to open, and
/// credential-store locations are chosen by native code or the packaged bridge.
struct Invocation {
    let method: String
    let payload: [String: Any]
    let bytes: Data

    init(body: Any) throws {
        guard let envelope = body as? [String: Any], Set(envelope.keys) == ["method", "payload"],
              let method = envelope["method"] as? String,
              let payload = envelope["payload"] as? [String: Any] else { throw MosaicError.invalidCommand }

        switch method {
        case "settings.get", "worker.test", "host.connect":
            guard payload.isEmpty else { throw MosaicError.invalidCommand }
        case "observer.board":
            guard Set(payload.keys) == ["source"], Self.validSource(payload["source"]) else {
                throw MosaicError.invalidCommand
            }
        case "observer.detail", "host.open":
            guard Set(payload.keys) == ["source", "id"], Self.validSource(payload["source"]),
                  let id = payload["id"] as? String, id.utf8.count <= 128,
                  id.range(of: #"\A[A-Za-z0-9][A-Za-z0-9_-]*\z"#, options: .regularExpression) != nil else {
                throw MosaicError.invalidCommand
            }
        case "clipboard.copy":
            guard Set(payload.keys) == ["text"], let text = payload["text"] as? String,
                  !text.isEmpty, text.utf8.count <= 16384, !text.contains("\0") else {
                throw MosaicError.invalidCommand
            }
        case "settings.save":
            let fields: Set<String> = ["host", "provider", "model", "baseUrl", "reviewTarget",
                "reviewerModel", "reviewerBaseUrl", "revision", "key", "reviewerKey"]
            guard Set(payload.keys).isSubset(of: fields),
                  ["codex", "claude-code"].contains(payload["host"] as? String ?? ""),
                  ["host", "api"].contains(payload["reviewTarget"] as? String ?? ""),
                  payload["revision"] != nil else { throw MosaicError.invalidCommand }
            for (key, value) in payload {
                if key == "revision", value is NSNull || value is NSNumber { continue }
                guard let text = value as? String, text.utf8.count <= 8192,
                      !text.contains("\0") else { throw MosaicError.invalidCommand }
            }
        default:
            throw MosaicError.invalidCommand
        }
        guard JSONSerialization.isValidJSONObject(envelope) else { throw MosaicError.invalidCommand }
        let bytes = try JSONSerialization.data(withJSONObject: envelope)
        guard bytes.count <= 32768 else { throw MosaicError.invalidCommand }
        self.method = method
        self.payload = payload
        self.bytes = bytes
    }

    private static func validSource(_ input: Any?) -> Bool {
        ["installed", "preview", "legacy"].contains(input as? String ?? "")
    }
}

enum AssetPolicy {
    static let startPage = URL(string:"mosaic-app://ui/index.html")!

    static func isPage(_ url: URL?) -> Bool {
        guard let url = url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        components.fragment = nil
        return components.url == startPage
    }

    static func file(for url: URL, root: URL) throws -> URL {
        guard url.scheme == "mosaic-app", url.host == "ui", url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { throw MosaicError.invalidResource }
        // Explicit inventory, shared with the packager. No test, runtime, or
        // user files can be addressed through this WebKit scheme.
        let names = ["/index.html", "/app.js", "/styles.css", "/assets/mosaic.svg"]
        guard names.contains(url.path) else { throw MosaicError.invalidResource }
        let dir = root.resolvingSymlinksInPath().standardizedFileURL
        let result = dir.appendingPathComponent(String(url.path.dropFirst())).resolvingSymlinksInPath().standardizedFileURL
        guard result.path.hasPrefix(dir.path + "/"),
              (try? result.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            throw MosaicError.invalidResource
        }
        return result
    }
}
