import ExpoModulesCore
import WebKit

// WebKit retains installed message handlers. Keep the receiver weak so a popped
// document releases its native view, JS heap, and any decrypted document data.
private final class EditorMessages: NSObject, WKScriptMessageHandler {
  weak var surface: EditorSurface?
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let text = message.body as? String else { return }
    surface?.onMessage(["data": text])
  }
}

private final class EditorPage: NSObject, WKNavigationDelegate, WKUIDelegate {
  let web: WKWebView
  let messages = EditorMessages()
  private var loaded = false
  private var failure: String?
  private var bootstrap: String?

  init(html: String) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.allowsInlineMediaPlayback = true
    config.userContentController.add(messages, name: "editor")
    let bridge = "window.ReactNativeWebView={postMessage:s=>window.webkit.messageHandlers.editor.postMessage(s)}"
    config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web = WKWebView(frame: .zero, configuration: config)
    super.init()
    web.uiDelegate = self
    web.navigationDelegate = self
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.isOpaque = false
    web.backgroundColor = .clear
    web.loadHTMLString(html, baseURL: nil)
  }

  func claim(_ surface: EditorSurface, bootstrap: String) {
    messages.surface = surface
    self.bootstrap = bootstrap
    startIfReady()
  }

  private func startIfReady() {
    if let failure {
      messages.surface?.onFailure(["message": failure])
      return
    }
    guard loaded, let bootstrap else { return }
    self.bootstrap = nil
    web.evaluateJavaScript("window.__metahubStartEditor(\(bootstrap));true;") { [weak self] _, error in
      if let error { self?.fail(error.localizedDescription) }
    }
  }

  private func fail(_ reason: String) {
    failure = reason
    messages.surface?.onFailure(["message": reason])
  }

  var usable: Bool { failure == nil }

  // Keep the editor's explicit conflict-overwrite confirmation on the owning scene.
  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    guard frame.isMainFrame, var presenter = webView.window?.rootViewController,
      UIApplication.shared.applicationState == .active else { completionHandler(false); return }
    while let presented = presenter.presentedViewController { presenter = presented }
    guard !presenter.isBeingDismissed, !(presenter is UIAlertController) else {
      completionHandler(false)
      return
    }
    let dialog = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    dialog.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
    dialog.addAction(UIAlertAction(title: "确定", style: .destructive) { _ in completionHandler(true) })
    presenter.present(dialog, animated: true)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let local = navigationAction.request.url?.absoluteString == "about:blank"
    decisionHandler(local && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loaded = true
    startIfReady()
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    fail(error.localizedDescription)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    fail(error.localizedDescription)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    fail("编辑器进程已停止，请恢复草稿继续编辑")
  }
}

private final class EditorPool {
  private var template: String?
  private var idle: EditorPage?
  private var observers: [NSObjectProtocol] = []
  init() {
    for name in [UIApplication.didReceiveMemoryWarningNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.idle = nil
      })
    }
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  func prepare(_ html: String) {
    if template != html {
      idle = nil
      template = html
    }
    warm()
  }
  func warm() {
    guard UIApplication.shared.applicationState == .active, idle?.usable != true, let template else { return }
    idle = EditorPage(html: template)
  }
  func take() -> EditorPage? {
    defer { idle = nil }
    if let idle, idle.usable { return idle }
    return template.map { EditorPage(html: $0) }
  }
}

private final class EditorSurface: ExpoView {
  let onMessage = EventDispatcher()
  let onFailure = EventDispatcher()
  private var page: EditorPage?
  func bind(pool: EditorPool, bootstrap: String) {
    guard page == nil else { return }
    guard let next = pool.take() else {
      onFailure(["message": "编辑器尚未初始化"])
      return
    }
    page = next
    next.web.frame = bounds
    addSubview(next.web)
    next.claim(self, bootstrap: bootstrap)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    page?.web.frame = bounds
  }
  func inject(_ script: String) { page?.web.evaluateJavaScript(script, completionHandler: nil) }
}

public final class MetahubEditorModule: Module {
  private let pool = EditorPool()
  public func definition() -> ModuleDefinition {
    Name("MetahubEditor")
    AsyncFunction("prepare") { (html: String) in self.pool.prepare(html) }.runOnQueue(.main)
    AsyncFunction("warm") { self.pool.warm() }.runOnQueue(.main)
    View(EditorSurface.self) {
      Events("onMessage", "onFailure")
      Prop("bootstrap") { (view: EditorSurface, bootstrap: String) in
        view.bind(pool: self.pool, bootstrap: bootstrap)
      }
      AsyncFunction("injectJavaScript") { (view: EditorSurface, script: String) in view.inject(script) }
    }
  }
}
