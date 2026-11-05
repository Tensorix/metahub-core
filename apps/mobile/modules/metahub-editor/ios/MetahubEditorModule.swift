import ExpoModulesCore
import WebKit

// WebKit retains installed message handlers. Keep the receiver weak so a popped
// route can detach without retaining its document surface.
private final class EditorMessages: NSObject, WKScriptMessageHandler {
  weak var surface: EditorSurface?
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let packet = message.body as? [String: Any],
      let session = packet["session"] as? String, let text = packet["data"] as? String else { return }
    surface?.receive(text, sessionID: session, web: message.webView)
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
    let bridge = "window.ReactNativeWebView={sessionProtocol:2,postMessage:(data,session)=>window.webkit.messageHandlers.editor.postMessage({data,session})}"
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
    web.evaluateJavaScript("window.__metahubOpenSession(\(bootstrap));true;") { [weak self] _, error in
      if let error { self?.fail(error.localizedDescription) }
    }
  }

  private func fail(_ reason: String) {
    failure = reason
    messages.surface?.onFailure(["message": reason])
  }

  func retire() {
    messages.surface = nil
    web.stopLoading()
    web.removeFromSuperview()
    web.navigationDelegate = nil
    web.uiDelegate = nil
    web.loadHTMLString("", baseURL: nil)
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
    guard UIApplication.shared.applicationState == .active, active == nil, idle?.usable != true, let template else { return }
    idle = EditorPage(html: template)
  }
  private weak var active: EditorPage?
  private var workspace: String?
  private var incarnation: String?
  func take(workspace id: String, incarnation instance: String) -> EditorPage? {
    if let workspace, workspace != id || incarnation != instance {
      active?.retire()
      active = nil
      idle = nil
    }
    guard active?.usable != true else { return nil }
    workspace = id
    incarnation = instance
    let page = idle.flatMap { $0.usable ? $0 : nil } ?? template.map { EditorPage(html: $0) }
    idle = nil
    active = page
    return page
  }
  func release(_ page: EditorPage, clean: Bool) {
    guard active === page else { return }
    active = nil
    if clean && page.usable && UIApplication.shared.applicationState == .active { idle = page }
  }
  func invalidate(_ id: String, incarnation instance: String) {
    guard workspace == nil || (workspace == id && incarnation == instance) else { return }
    incarnation = nil
    workspace = nil
    active?.retire()
    active = nil
    idle = nil
  }
}

private final class EditorSurface: ExpoView {
  let onMessage = EventDispatcher()
  let onFailure = EventDispatcher()
  private var page: EditorPage?
  private var session: String?
  private weak var pool: EditorPool?
  func close(_ id: String, promise: Promise) {
    guard session == id else { promise.reject("STALE_SESSION", "文档会话已变更"); return }
    guard let page else { promise.resolve(nil); return }
    var completed = false
    let finish: (Bool, Any?) -> Void = { clean, position in
      guard !completed else { return }
      completed = true
      page.messages.surface = nil
      page.web.removeFromSuperview()
      self.pool?.release(page, clean: clean)
      self.page = nil
      promise.resolve(position)
    }
    let quoted = (try? JSONEncoder().encode(id)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    page.web.evaluateJavaScript("window.__metahubCloseSession(\(quoted))") { result, error in
      guard !completed else { return }
      if let value = result as? NSDictionary, value["blocked"] as? Bool == true {
        completed = true
        promise.reject("EDITOR_BUSY", "文档仍有输入待保存")
        return
      }
      finish(error == nil && result is NSDictionary, result as? NSDictionary)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish(false, nil) }
  }
  func bind(pool: EditorPool, bootstrap: String) {
    guard page == nil else { return }
    guard let config = try? JSONSerialization.jsonObject(with: Data(bootstrap.utf8)) as? [String: Any],
      let workspace = config["workspace"] as? String, let id = config["session"] as? String,
      let instance = config["instance"] as? String, let next = pool.take(workspace: workspace, incarnation: instance) else {
      onFailure(["message": "编辑器尚未初始化"])
      return
    }
    self.pool = pool
    session = id
    page = next
    next.web.frame = bounds
    addSubview(next.web)
    next.claim(self, bootstrap: bootstrap)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    page?.web.frame = bounds
  }
  func receive(_ text: String, sessionID: String, web: WKWebView?) {
    guard session == sessionID, let page, web === page.web else { return }
    onMessage(["data": text])
  }
  func inject(_ script: String) { page?.web.evaluateJavaScript(script, completionHandler: nil) }
}

public final class MetahubEditorModule: Module {
  private let pool = EditorPool()
  public func definition() -> ModuleDefinition {
    Name("MetahubEditor")
    Constant("sessionProtocol") { 2 }
    AsyncFunction("invalidate") { (workspace: String, instance: String) in self.pool.invalidate(workspace, incarnation: instance) }.runOnQueue(.main)
    AsyncFunction("prepare") { (html: String) in self.pool.prepare(html) }.runOnQueue(.main)
    AsyncFunction("warm") { self.pool.warm() }.runOnQueue(.main)
    View(EditorSurface.self) {
      Events("onMessage", "onFailure")
      Prop("bootstrap") { (view: EditorSurface, bootstrap: String) in
        view.bind(pool: self.pool, bootstrap: bootstrap)
      }
      AsyncFunction("closeSession") { (view: EditorSurface, id: String, promise: Promise) in view.close(id, promise: promise) }
      AsyncFunction("injectJavaScript") { (view: EditorSurface, script: String) in view.inject(script) }
    }
  }
}
