import Foundation
import Darwin

enum HelperError: LocalizedError {
    case unavailable, timeout, malformedReply, busy, message(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: return "The bundled Mosaic helper is unavailable. Reopen Mosaic Desktop from Applications."
        case .timeout: return "The coordinator took too long to respond. Refresh to check its latest state."
        case .malformedReply: return "The coordinator returned an unreadable response."
        case .busy: return "Mosaic is finishing another request. Try again in a moment."
        case .message(let text): return text
        }
    }
}

final class BridgeRunner {
    private let operations = OperationQueue()
    private let lock = NSLock()
    private var children: [ObjectIdentifier: Process] = [:]
    private var stopped = false
    let runtime: URL

    init(resources: URL) {
        runtime = resources.appendingPathComponent("runtime", isDirectory: true)
        operations.maxConcurrentOperationCount = 4
        operations.qualityOfService = .userInitiated
    }

    func shutdown() {
        operations.cancelAllOperations()
        lock.lock()
        stopped = true
        for child in children.values where child.isRunning { kill(child.processIdentifier, SIGKILL) }
        lock.unlock()
    }

    func invoke(_ request: Invocation, completion: @escaping (Result<Any, Error>) -> Void) {
        guard operations.operationCount < 12 else { completion(.failure(HelperError.busy)); return }
        operations.addOperation { [self] in
            let result = Result { try execute(request) }
            OperationQueue.main.addOperation { completion(result) }
        }
    }

    // Restrict settings replies to the public status fields even if a future
    // helper accidentally includes its private credential record in a result.
    static let publicSettings = Set(["configured", "host", "provider", "model", "baseUrl", "hasKey",
        "reviewTarget", "reviewerModel", "reviewerBaseUrl", "reviewerHasKey", "firstCallAt",
        "registration", "installedAvailable", "legacyAvailable", "revision", "serviceReady", "serviceMessage", "readOnlyReason"])

    private func execute(_ request: Invocation) throws -> Any {
        let child = Process()
        let input = Pipe(), output = Pipe()
        child.executableURL = runtime.appendingPathComponent("bin/node")
        child.arguments = ["--disable-warning=ExperimentalWarning", runtime.appendingPathComponent("desktop/macos/bridge.mjs").path]
        child.currentDirectoryURL = runtime
        let inherited = ProcessInfo.processInfo.environment
        let safeKeys = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "PATH", "XPC_SERVICE_NAME", "SSH_AUTH_SOCK"]
        child.environment = inherited.filter { safeKeys.contains($0.key) }
        child.standardInput = input
        child.standardOutput = output
        child.standardError = FileHandle.nullDevice
        let identity = ObjectIdentifier(child)
        lock.lock()
        guard !stopped else { lock.unlock(); throw HelperError.unavailable }
        do { try child.run() } catch { lock.unlock(); throw HelperError.unavailable }
        // Saving can install the shared runtime. Its own network, transaction and
        // service operations have deadlines. Let a running save finish even if
        // the window closes or the GUI quits, with its stdin already delivered.
        let saving = request.method == "settings.save"
        if !saving { children[identity] = child }
        lock.unlock()

        let budget = request.method == "host.connect" ? 65 : 20
        let timeout = DispatchSource.makeTimerSource()
        timeout.schedule(deadline: .now() + .seconds(budget))
        timeout.setEventHandler { [weak self, weak child] in
            guard let self = self, let child = child else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            if self.children[identity] === child, child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
        timeout.resume()
        defer {
            timeout.cancel()
            try? input.fileHandleForWriting.close()
            try? output.fileHandleForReading.close()
            // Parsing errors and cancellation also retire only this helper.
            if !saving && child.isRunning { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
            lock.lock(); children.removeValue(forKey: identity); lock.unlock()
        }
        do {
            try input.fileHandleForWriting.write(contentsOf: request.bytes)
            try input.fileHandleForWriting.close()
        } catch { throw HelperError.unavailable }
        var reply = Data()
        while let chunk = try output.fileHandleForReading.read(upToCount: 64 * 1024), !chunk.isEmpty {
            guard reply.count + chunk.count <= 8 * 1024 * 1024 else { throw HelperError.malformedReply }
            reply.append(chunk)
        }
        child.waitUntilExit()
        if child.terminationReason == .uncaughtSignal { throw HelperError.timeout }
        guard let object = (try? JSONSerialization.jsonObject(with: reply)) as? [String: Any],
              let ok = object["ok"] as? Bool else { throw HelperError.malformedReply }
        if !ok {
            // Bridge errors are sanitized before serialization; never surface
            // diagnostics from stderr, stack traces or the input envelope.
            guard let message = object["error"] as? String, !message.isEmpty, message.utf8.count <= 1200,
                  !message.contains("\n"),
                  !["key","reviewerKey"].compactMap({request.payload[$0] as? String})
                      .contains(where:{ !$0.isEmpty && message.contains($0) }) else { throw HelperError.malformedReply }
            throw HelperError.message(message)
        }
        guard child.terminationStatus == 0, let value = object["value"] else { throw HelperError.malformedReply }
        if request.method == "settings.get" || request.method == "settings.save" {
            guard let settings = value as? [String: Any] else { throw HelperError.malformedReply }
            return settings.filter { key, field in
                Self.publicSettings.contains(key) && (field is NSNull || field is String || field is NSNumber)
            }
        }
        if request.method == "worker.test" || request.method == "host.connect" {
            guard let status = value as? [String: Any], let ok = status["ok"] as? Bool,
                  let message = status["message"] as? String else { throw HelperError.malformedReply }
            return ["ok": ok, "message": message]
        }
        return value
    }
}
