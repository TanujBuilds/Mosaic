import AppKit
import WebKit
import Darwin

final class ViewerBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let runner: BridgeRunner
    private let chats = CodexChatReader()
    private let pasteboard: NSPasteboard

    init(resources: URL, pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
        runner = BridgeRunner(resources: resources)
    }

    func shutdown() {
        runner.shutdown()
        chats.shutdown()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "mosaic-app",
              message.frameInfo.securityOrigin.host == "ui", AssetPolicy.isPage(message.webView?.url),
              let request = try? Invocation(body: message.body) else {
            replyHandler(nil, "Mosaic rejected an unsupported request.")
            return
        }
        switch request.method {
        case "clipboard.copy":
            guard let text = request.payload["text"] as? String else {
                replyHandler(nil, "The follow-up could not be copied.")
                return
            }
            pasteboard.clearContents()
            if pasteboard.setString(text, forType: .string) {
                replyHandler(["copied": true], nil)
            } else {
                replyHandler(nil, "The follow-up could not be copied.")
            }
        case "host.open":
            openHost(request.payload, reply: replyHandler)
        default:
            runner.invoke(request) { result in
                switch result {
                case .success(let value): replyHandler(value, nil)
                case .failure(let error): replyHandler(nil, error.localizedDescription)
                }
            }
        }
    }

    private func openHost(_ payload: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let fallback = "The originating chat could not be verified. Copy the follow-up into your coding host."
        guard let detail = try? Invocation(body: ["method": "observer.detail", "payload": payload]) else {
            reply(nil, fallback)
            return
        }
        runner.invoke(detail) { [self] result in
            guard case .success(let value) = result, let record = value as? [String: Any],
                  let host = record["host"] as? String, host.lowercased() == "codex",
                  let id = record["sessionId"] as? String, CodexChatCodec.validID(id),
                  let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") else {
                reply(nil, fallback)
                return
            }
            chats.list { result in
                guard case .success = result, let link = self.chats.link(id) else {
                    reply(nil, fallback)
                    return
                }
                NSWorkspace.shared.open([link], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                    DispatchQueue.main.async {
                        if error == nil { reply(["opened": true], nil) } else { reply(nil, fallback) }
                    }
                }
            }
        }
    }
}

final class LocalAssets: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url else { throw MosaicError.invalidResource }
            let file = try AssetPolicy.file(for: url, root: root)
            let data = try Data(contentsOf: file)
            let type = ["html": "text/html", "css": "text/css", "js": "text/javascript", "svg": "image/svg+xml"][file.pathExtension]!
            let headers = ["Content-Type": type + "; charset=utf-8", "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"]
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
                throw MosaicError.invalidResource
            }
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        } catch {
            task.didFailWithError(NSError(domain: "MosaicResource", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "This bundled Mosaic resource is unavailable."]))
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    private lazy var bridge = ViewerBridge(resources: Bundle.main.resourceURL!)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        installMenus()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalAssets(root: Bundle.main.resourceURL!.appendingPathComponent("ui")), forURLScheme: "mosaic-app")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "mosaic")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let size = NSSize(width: min(1320, visible.width), height: min(830, visible.height - 28))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Mosaic Desktop"
        window.minSize = NSSize(width: min(700, size.width), height: min(480, size.height))
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MosaicDesktopWindow")
        webView.load(URLRequest(url: AssetPolicy.startPage))
        showWindow(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(nil)
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { bridge.shutdown() }
    func updateViewerVisibility(_ visible: Bool? = nil) {
        guard window != nil, webView != nil else { return }
        let active = visible ?? (window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible))
        webView.evaluateJavaScript("window.MosaicRuntime?.setHostVisible(" + (active ? "true" : "false") + ")", completionHandler: nil)
    }
    func windowWillClose(_ notification: Notification) { updateViewerVisibility(false) }
    func windowDidMiniaturize(_ notification: Notification) { updateViewerVisibility(false) }
    func windowDidDeminiaturize(_ notification: Notification) { updateViewerVisibility() }
    func windowDidChangeOcclusionState(_ notification: Notification) { updateViewerVisibility() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { updateViewerVisibility() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    @objc func showWindow(_ sender: Any?) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateViewerVisibility()
    }
    @objc func refresh(_ sender: Any?) {
        webView.evaluateJavaScript("window.MosaicRuntime?.refresh()", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.targetFrame?.isMainFrame == true && AssetPolicy.isPage(action.request.url) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func installMenus() {
        let main = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem(), menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        func item(_ menu: NSMenu, _ title: String, _ selector: Selector, _ key: String = "", _ target: AnyObject? = nil) {
            let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            item.target = target
            menu.addItem(item)
        }
        let app = menu("Mosaic Desktop")
        item(app, "About Mosaic Desktop", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        app.addItem(.separator())
        item(app, "Hide Mosaic Desktop", #selector(NSApplication.hide(_:)), "h")
        item(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
        app.addItem(.separator())
        item(app, "Quit Mosaic Desktop", #selector(NSApplication.terminate(_:)), "q")
        let file = menu("File")
        item(file, "Show Mosaic Desktop", #selector(showWindow(_:)), "0", self)
        item(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        let edit = menu("Edit")
        item(edit, "Undo", Selector(("undo:")), "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        item(edit, "Cut", #selector(NSText.cut(_:)), "x")
        item(edit, "Copy", #selector(NSText.copy(_:)), "c")
        item(edit, "Paste", #selector(NSText.paste(_:)), "v")
        item(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        item(menu("View"), "Refresh", #selector(refresh(_:)), "r", self)
        let windows = menu("Window")
        item(windows, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        item(windows, "Zoom", #selector(NSWindow.performZoom(_:)))
        item(windows, "Show Mosaic Desktop", #selector(showWindow(_:)), "", self)
        NSApp.windowsMenu = windows
        NSApp.mainMenu = main
    }
}

#if !MOSAIC_TESTING
@main struct MosaicApplication {
    static func main() {
        // A metadata helper may close stdin before consuming a request.
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared, delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
