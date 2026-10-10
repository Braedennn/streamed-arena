import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ArenaViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}

// MARK: - Ad shield
//
// The desktop app stops popup and redirect ads in Electron's main process.
// This is the iOS equivalent. Stream embeds run in third-party iframes; left
// alone, Capacitor hands every popup and every off-app redirect to Safari,
// which is exactly how those ads open. Here they are dropped instead:
//
//   - new windows (window.open, target="_blank")  -> PopupBlocker / AdShieldPlugin
//   - whole-page redirects away from the app       -> AdShieldPlugin
//
// Navigation *inside* an embed's own frame is untouched, so players keep working.

class ArenaViewController: CAPBridgeViewController {
    private var popupBlocker: PopupBlocker?

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AdShieldPlugin())
        if let webView = webView, let original = webView.uiDelegate as? NSObject {
            let blocker = PopupBlocker(original: original)
            popupBlocker = blocker // uiDelegate is weak
            webView.uiDelegate = blocker
        }
    }

    // Next.js exports every page as <route>/index.html. Capacitor's default
    // router answers any extension-less path with the root index.html, so a
    // reload on /watch/ (iOS restarts web content after backgrounding) would
    // come back as the home page.
    override func router() -> Router {
        return StaticExportRouter()
    }
}

struct StaticExportRouter: Router {
    var basePath: String = ""

    func route(for path: String) -> String {
        if !URL(fileURLWithPath: path).pathExtension.isEmpty {
            return basePath + path
        }
        let directory = path.hasSuffix("/") ? path : path + "/"
        let page = basePath + directory + "index.html"
        return FileManager.default.fileExists(atPath: page) ? page : basePath + "/index.html"
    }
}

@objc(AdShieldPlugin)
class AdShieldPlugin: CAPInstancePlugin, CAPBridgedPlugin {
    let identifier = "AdShieldPlugin"
    let jsName = "AdShield"
    let pluginMethods: [CAPPluginMethod] = []

    // true = cancel, nil = let Capacitor decide as usual.
    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, let config = bridge?.config else {
            return nil
        }
        // No target frame means a new window; a main-frame target is the app page itself.
        let topLevel = navigationAction.targetFrame?.isMainFrame ?? true
        let target = url.absoluteString
        let insideApp = target.hasPrefix(config.serverURL.absoluteString)
            || target.hasPrefix(config.localURL.absoluteString)
        if topLevel && !insideApp {
            return NSNumber(value: true)
        }
        return nil
    }
}

/// Sits in front of Capacitor's WKUIDelegate and refuses every new window.
/// Everything else (alert/confirm/prompt panels) is forwarded to the original.
final class PopupBlocker: NSObject {
    private let original: NSObject

    init(original: NSObject) {
        self.original = original
    }

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || original.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return original
    }
}

extension PopupBlocker: WKUIDelegate {
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        return nil
    }
}
