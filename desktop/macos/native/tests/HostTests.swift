import AppKit
import WebKit
import Darwin

enum TestFailure: Error { case failed(String) }

@main struct HostTests {
    static func check(_ value: Bool, _ label: String) throws {
        if !value { throw TestFailure.failed(label) }
    }

    static func main() throws {
        signal(SIGPIPE, SIG_IGN)
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let resources = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let ui = resources.appendingPathComponent("ui")
        let settings: [String: Any] = ["host": "codex", "provider": "local", "model": "test", "baseUrl": "http://127.0.0.1:8000/v1",
            "reviewTarget": "host", "reviewerModel": "", "reviewerBaseUrl": "", "revision": NSNull()]
        let allowed: [(String, [String: Any])] = [("settings.get", [:]), ("settings.save", settings), ("worker.test", [:]), ("host.connect", [:]),
            ("observer.board", ["source": "installed"]), ("observer.board", ["source": "legacy"]), ("observer.detail", ["source": "preview", "id": "goal-A_1"]),
            ("host.open", ["source": "installed", "id": "goal-A_1"]), ("clipboard.copy", ["text": "Follow up"])]
        for (name, payload) in allowed {
            let invocation = try Invocation(body: ["method": name, "payload": payload])
            try check(invocation.method == name && !invocation.bytes.isEmpty, name)
        }
        let rejected: [(String, [String: Any])] = [("shell", ["command": "anything"]), ("settings.get", ["key": "secret"]),
            ("observer.board", ["source": "other"]), ("observer.detail", ["source":"installed", "id":"/file"]),
            ("host.connect", ["host":"arbitrary"]), ("host.open", ["url":"https://example.invalid"]), ("clipboard.copy", ["text":""])]
        for (name, payload) in rejected {
            try check((try? Invocation(body: ["method": name, "payload": payload])) == nil, name)
        }
        try check((try? AssetPolicy.file(for: AssetPolicy.startPage, root: ui)) != nil, "UI index")
        for value in ["https://example.invalid", "mosaic-app://ui/../runtime/bin/node", "mosaic-app://ui/tests/x.mjs",
                    "mosaic-app://wrong/index.html", "mosaic-app://ui/index.html?file=x"] {
            try check((try? AssetPolicy.file(for: URL(string: value)!, root: ui)) == nil, "Asset boundary")
        }
        // A Quit during a first save must allow the launched setup to finish.
        let runner = BridgeRunner(resources: resources)
        var saving = settings
        saving["revision"] = "save-in-progress"
        let request = try Invocation(body: ["method":"settings.save", "payload":saving])
        runner.invoke(request) { _ in }
        let waitFor = { (name: String) -> Bool in
            let file = resources.appendingPathComponent("runtime/" + name).path
            let limit = Date().addingTimeInterval(5)
            while !FileManager.default.fileExists(atPath: file) && Date() < limit {
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            }
            return FileManager.default.fileExists(atPath: file)
        }
        try check(waitFor("saving"), "Shared save started")
        runner.shutdown()
        try check(waitFor("saved"), "Shared save survived shutdown")
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let bridge = ViewerBridge(resources: resources, pasteboard: pasteboard)
        defer { bridge.shutdown() }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(LocalAssets(root: ui), forURLScheme: "mosaic-app")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "mosaic")
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        view.load(URLRequest(url: AssetPolicy.startPage))
        let deadline = Date().addingTimeInterval(20)
        var result: [String: Any]?, polling = false
        while result == nil && Date() < deadline {
            if !view.isLoading && !polling {
                polling = true
                view.evaluateJavaScript("window.testResult ?? null") { value, _ in
                    result = value as? [String: Any]
                    polling = false
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        try check(result?["result"] as? String == "passed", "WebKit bridge: " + (result?["failure"] as? String ?? "timed out"))
        try check(pasteboard.string(forType: .string) == "fixture follow-up", "Isolated native clipboard")
        print("Native schemas, asset restrictions, WKWebView JSON replies, secret redaction, clipboard and host fallback passed.")
    }
}
