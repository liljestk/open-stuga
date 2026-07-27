import SwiftUI
import UIKit
@preconcurrency import WebKit

struct ReadyExperienceView: View {
    var body: some View {
        #if targetEnvironment(macCatalyst)
        LargeScreenExperienceView()
        #else
        if UIDevice.current.userInterfaceIdiom == .pad {
            LargeScreenExperienceView()
        } else {
            MainTabView()
        }
        #endif
    }
}

private struct LargeScreenWebRequest: Equatable {
    let id: UUID
    let url: URL
    let origin: URL
}

@MainActor
private final class LargeScreenWebState: ObservableObject {
    @Published private(set) var isLoading = true
    @Published private(set) var errorMessage: String?
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var currentURL: URL?

    weak var webView: WKWebView?

    func attach(_ webView: WKWebView?) {
        self.webView = webView
        updateNavigation()
    }

    func started() {
        isLoading = true
        errorMessage = nil
        updateNavigation()
    }

    func finished(url: URL?) {
        isLoading = false
        errorMessage = nil
        currentURL = url
        updateNavigation()
    }

    func failed(_ error: Error) {
        let failure = error as NSError
        guard failure.code != NSURLErrorCancelled else { return }
        isLoading = false
        errorMessage = failure.localizedDescription
        updateNavigation()
    }

    func goBack() {
        webView?.goBack()
    }

    func goForward() {
        webView?.goForward()
    }

    func reload() {
        errorMessage = nil
        isLoading = true
        webView?.reload()
    }

    func updateNavigation() {
        canGoBack = webView?.canGoBack ?? false
        canGoForward = webView?.canGoForward ?? false
        currentURL = webView?.url ?? currentURL
    }
}

struct LargeScreenExperienceView: View {
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var model: AppModel
    @StateObject private var webState = LargeScreenWebState()
    @State private var requestID = UUID()
    @State private var requestedURL: URL?
    @State private var showingCapture = false
    @State private var showingRoomScan = false
    @State private var showingDeviceSettings = false
    @State private var showingOfflineCompanion = false
    @State private var selectedEquipment: AreaEquipment?

    var body: some View {
        Group {
            if showingOfflineCompanion {
                VStack(spacing: 0) {
                    offlineBar
                    MainTabView()
                }
            } else {
                VStack(spacing: 0) {
                    appBar
                    ZStack {
                        StuguScreenBackground()
                        if let request = webRequest {
                            LargeScreenWebView(request: request, state: webState)
                            loadingOverlay
                            errorOverlay
                        } else {
                            ContentUnavailableView(
                                "No Stugu server",
                                systemImage: "network.slash",
                                description: Text("Choose a server to open the full app.")
                            )
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showingCapture) {
            QuickCaptureView()
                .environmentObject(model)
        }
        .fullScreenCover(isPresented: $showingRoomScan) {
            RoomPlanImportView()
                .environmentObject(model)
        }
        .sheet(isPresented: $showingDeviceSettings) {
            SettingsView(showsDismissButton: true)
                .environmentObject(model)
        }
        .sheet(item: $selectedEquipment) { equipment in
            EquipmentDetailView(
                asset: model.trackedState(for: equipment.id)
                    ?? TrackedEquipmentState(equipment: equipment),
                snapshot: model.trackingSnapshot,
                tracker: model.mobileTracking
            )
            .environmentObject(model)
        }
        .onChange(of: model.pendingDeepLink, initial: true) { _, link in
            handle(link)
        }
        .onChange(of: model.usingCachedData, initial: true) { _, cached in
            if cached {
                showingOfflineCompanion = true
            }
        }
    }

    private var appBar: some View {
        HStack(spacing: 4) {
            Button(action: webState.goBack) {
                Image(systemName: "chevron.left")
            }
            .disabled(!webState.canGoBack)
            .accessibilityLabel("Back")

            Button(action: webState.goForward) {
                Image(systemName: "chevron.right")
            }
            .disabled(!webState.canGoForward)
            .accessibilityLabel("Forward")

            Button(action: webState.reload) {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("Reload")

            Text(webState.currentURL?.host ?? model.serverDisplayName)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(StuguTheme.muted)
                .padding(.leading, 8)

            Spacer()

            Menu {
                Button {
                    showingCapture = true
                } label: {
                    Label("Quick capture", systemImage: "square.and.pencil")
                }

                #if !targetEnvironment(macCatalyst)
                Button {
                    showingRoomScan = true
                } label: {
                    Label("Scan a room", systemImage: "viewfinder")
                }
                #endif

                Button {
                    showingDeviceSettings = true
                } label: {
                    Label("Device settings", systemImage: "gearshape")
                }

                if let url = webState.currentURL ?? webRequest?.url {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open in browser", systemImage: "safari")
                    }
                }
            } label: {
                Label("App actions", systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
            }
            .accessibilityLabel("App actions")
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(StuguTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(StuguTheme.line)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    private var offlineBar: some View {
        HStack {
            Label("Offline companion", systemImage: "wifi.slash")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Button("Return to full app") {
                showingOfflineCompanion = false
                retry()
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(StuguTheme.surface)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(StuguTheme.line)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var loadingOverlay: some View {
        if webState.isLoading {
            ProgressView("Opening full Stugu…")
                .padding(18)
                .background(.regularMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Opening full Stugu")
        }
    }

    @ViewBuilder
    private var errorOverlay: some View {
        if let message = webState.errorMessage {
            StuguCard {
                VStack(alignment: .leading, spacing: 14) {
                    Label("The full app could not open", systemImage: "exclamationmark.triangle")
                        .font(.headline)
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(StuguTheme.muted)
                    HStack {
                        Button("Try again", action: retry)
                            .buttonStyle(PrimaryButtonStyle())
                        Button("Use offline view") {
                            showingOfflineCompanion = true
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        if let url = webRequest?.url {
                            Button("Open in browser") {
                                openURL(url)
                            }
                            .buttonStyle(SecondaryButtonStyle())
                        }
                    }
                }
            }
            .frame(maxWidth: 520)
            .padding(24)
        }
    }

    private var webRequest: LargeScreenWebRequest? {
        guard let origin = model.serverAddress?.webURL(),
              let url = requestedURL ?? defaultWebURL else {
            return nil
        }
        return LargeScreenWebRequest(id: requestID, url: url, origin: origin)
    }

    private var defaultWebURL: URL? {
        guard let origin = model.serverAddress?.webURL() else { return nil }
        if let home = model.selectedHome {
            return webURL(
                origin: origin,
                path: ["properties", home.propertyId, "homes", home.id]
            )
        }
        if let propertyID = model.selectedPropertyID {
            return webURL(origin: origin, path: ["properties", propertyID])
        }
        return webURL(origin: origin, path: ["overview"])
    }

    private func retry() {
        requestID = UUID()
    }

    private func navigate(to url: URL?) {
        guard let url else { return }
        requestedURL = url
        requestID = UUID()
    }

    private func handle(_ link: CompanionDeepLink?) {
        guard !showingOfflineCompanion,
              !model.usingCachedData,
              let link,
              let origin = model.serverAddress?.webURL() else {
            return
        }
        switch link {
        case .home:
            navigate(to: defaultWebURL)
        case .alerts:
            navigate(to: webURL(origin: origin, path: ["alerts"]))
        case .inventory:
            let path = model.selectedPropertyID.map { ["properties", $0] }
                ?? ["properties"]
            navigate(to: webURL(origin: origin, path: path))
        case .capture:
            showingCapture = true
        case .roomScan:
            showingRoomScan = true
        case let .equipment(code):
            Task {
                selectedEquipment = await model.resolveEquipmentCode(code)?.equipment
            }
        }
        model.consumeDeepLink()
    }

    private func webURL(origin: URL, path: [String]) -> URL {
        path.reduce(origin) { result, component in
            result.appendingPathComponent(component)
        }
    }
}

private struct LargeScreenWebView: UIViewRepresentable {
    let request: LargeScreenWebRequest
    @ObservedObject var state: LargeScreenWebState

    func makeCoordinator() -> Coordinator {
        Coordinator(state: state)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        context.coordinator.attach(to: webView)
        context.coordinator.load(request, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(request, in: webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.detach(from: webView)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate,
        WKDownloadDelegate, WKHTTPCookieStoreObserver {
        private let state: LargeScreenWebState
        private var loadedRequestID: UUID?
        private var loadGeneration = 0
        private var observedCookieStore: WKHTTPCookieStore?
        private var downloadURLs: [ObjectIdentifier: URL] = [:]
        private var backObservation: NSKeyValueObservation?
        private var forwardObservation: NSKeyValueObservation?

        init(state: LargeScreenWebState) {
            self.state = state
        }

        func attach(to webView: WKWebView) {
            state.attach(webView)
            backObservation = webView.observe(
                \.canGoBack,
                options: [.initial, .new]
            ) { [weak self] _, _ in
                MainActor.assumeIsolated {
                    self?.state.updateNavigation()
                }
            }
            forwardObservation = webView.observe(
                \.canGoForward,
                options: [.initial, .new]
            ) { [weak self] _, _ in
                MainActor.assumeIsolated {
                    self?.state.updateNavigation()
                }
            }
        }

        func load(_ request: LargeScreenWebRequest, in webView: WKWebView) {
            guard loadedRequestID != request.id else { return }
            loadedRequestID = request.id
            loadGeneration += 1
            let generation = loadGeneration
            state.started()

            let cookies = Self.cookies(matching: request.origin)
            install(
                cookies,
                at: 0,
                generation: generation,
                request: request,
                in: webView
            )
        }

        func detach(from webView: WKWebView) {
            loadGeneration += 1
            if let observedCookieStore {
                observedCookieStore.remove(self)
            }
            observedCookieStore = nil
            backObservation?.invalidate()
            forwardObservation?.invalidate()
            backObservation = nil
            forwardObservation = nil
            webView.navigationDelegate = nil
            webView.uiDelegate = nil
            state.attach(nil)
        }

        private func install(
            _ cookies: [HTTPCookie],
            at index: Int,
            generation: Int,
            request: LargeScreenWebRequest,
            in webView: WKWebView
        ) {
            guard generation == loadGeneration else { return }
            guard index < cookies.count else {
                observeCookies(in: webView.configuration.websiteDataStore.httpCookieStore)
                webView.load(URLRequest(url: request.url))
                return
            }
            webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookies[index]) {
                self.install(
                    cookies,
                    at: index + 1,
                    generation: generation,
                    request: request,
                    in: webView
                )
            }
        }

        private func observeCookies(in store: WKHTTPCookieStore) {
            guard observedCookieStore !== store else { return }
            if let observedCookieStore {
                observedCookieStore.remove(self)
            }
            observedCookieStore = store
            store.add(self)
        }

        func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            guard let origin = state.webView?.url else { return }
            cookieStore.getAllCookies { cookies in
                let webCookies = cookies.filter { Self.cookie($0, matches: origin) }
                let webKeys = Set(webCookies.map(Self.cookieKey))
                let shared = HTTPCookieStorage.shared
                for cookie in Self.cookies(matching: origin)
                    where !webKeys.contains(Self.cookieKey(cookie)) {
                    shared.deleteCookie(cookie)
                }
                for cookie in webCookies {
                    shared.setCookie(cookie)
                }
            }
        }

        private static func cookies(matching origin: URL) -> [HTTPCookie] {
            (HTTPCookieStorage.shared.cookies ?? []).filter {
                cookie($0, matches: origin)
            }
        }

        private static func cookie(_ cookie: HTTPCookie, matches origin: URL) -> Bool {
            guard let host = origin.host?.lowercased() else { return false }
            if cookie.isSecure && origin.scheme?.lowercased() != "https" {
                return false
            }
            let domain = cookie.domain
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                .lowercased()
            return host == domain || host.hasSuffix(".\(domain)")
        }

        private static func cookieKey(_ cookie: HTTPCookie) -> String {
            [cookie.name, cookie.domain.lowercased(), cookie.path]
                .joined(separator: "\u{1f}")
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation: WKNavigation!) {
            state.started()
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            state.updateNavigation()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.finished(url: webView.url)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            state.failed(error)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            state.failed(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            state.failed(
                NSError(
                    domain: "net.nysta.stugu.web",
                    code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "The web view stopped unexpectedly. Reload to continue.",
                    ]
                )
            )
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download)
                return
            }
            if let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               !["http", "https", "data", "blob"].contains(scheme) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
        }

        func webView(
            _ webView: WKWebView,
            navigationAction: WKNavigationAction,
            didBecome download: WKDownload
        ) {
            download.delegate = self
        }

        func webView(
            _ webView: WKWebView,
            navigationResponse: WKNavigationResponse,
            didBecome download: WKDownload
        ) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping (URL?) -> Void
        ) {
            let basename = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let filename = basename.isEmpty || basename == "." || basename == ".."
                ? "stugu-download"
                : basename
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("StuguWebDownloads", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                let destination = directory.appendingPathComponent(filename)
                downloadURLs[ObjectIdentifier(download)] = destination
                completionHandler(destination)
            } catch {
                state.failed(error)
                completionHandler(nil)
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = downloadURLs.removeValue(
                forKey: ObjectIdentifier(download)
            ) else { return }
            presentShare(for: url, from: download.webView)
        }

        func download(
            _ download: WKDownload,
            didFailWithError error: Error,
            resumeData: Data?
        ) {
            if let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) {
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
            state.failed(error)
        }

        private func presentShare(for url: URL, from webView: WKWebView?) {
            guard let webView,
                  let presenter = Self.presenter(from: webView.window?.rootViewController) else {
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                return
            }
            let activity = UIActivityViewController(
                activityItems: [url],
                applicationActivities: nil
            )
            activity.popoverPresentationController?.sourceView = webView
            activity.popoverPresentationController?.sourceRect = CGRect(
                x: webView.bounds.midX,
                y: webView.bounds.midY,
                width: 1,
                height: 1
            )
            activity.completionWithItemsHandler = { _, _, _, _ in
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
            presenter.present(activity, animated: true)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            guard let presenter = Self.presenter(from: webView.window?.rootViewController) else {
                completionHandler()
                return
            }
            let alert = UIAlertController(
                title: webView.title ?? "Stugu",
                message: message,
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler()
            })
            presenter.present(alert, animated: true)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            guard let presenter = Self.presenter(from: webView.window?.rootViewController) else {
                completionHandler(false)
                return
            }
            let alert = UIAlertController(
                title: webView.title ?? "Stugu",
                message: message,
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                completionHandler(false)
            })
            alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in
                completionHandler(true)
            })
            presenter.present(alert, animated: true)
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            guard let presenter = Self.presenter(from: webView.window?.rootViewController) else {
                completionHandler(nil)
                return
            }
            let alert = UIAlertController(
                title: webView.title ?? "Stugu",
                message: prompt,
                preferredStyle: .alert
            )
            alert.addTextField { field in
                field.text = defaultText
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                completionHandler(nil)
            })
            alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            presenter.present(alert, animated: true)
        }

        private static func presenter(from controller: UIViewController?) -> UIViewController? {
            if let presented = controller?.presentedViewController {
                return presenter(from: presented)
            }
            if let navigation = controller as? UINavigationController {
                return presenter(from: navigation.visibleViewController)
            }
            if let tabs = controller as? UITabBarController {
                return presenter(from: tabs.selectedViewController)
            }
            if let split = controller as? UISplitViewController {
                return presenter(from: split.viewControllers.last)
            }
            return controller
        }
    }
}
