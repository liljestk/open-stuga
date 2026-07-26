import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            StugaScreenBackground()
            switch model.phase {
            case .starting:
                launchView
            case .serverSetup:
                ServerSetupView(initialAddress: model.suggestedServerAddress)
            case .signIn:
                SignInView()
            case .ownerSetupRequired:
                OwnerSetupRequiredView()
            case .ready:
                MainTabView()
            }
        }
        .foregroundStyle(StugaTheme.ink)
    }

    private var launchView: some View {
        VStack(spacing: 28) {
            StugaLockup()
            ProgressView("Connecting to your Home…")
                .tint(StugaTheme.action)
                .foregroundStyle(StugaTheme.muted)
        }
        .padding(32)
        .accessibilityElement(children: .contain)
    }
}

private struct ServerSetupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var address: String
    @State private var isConnecting = false
    @FocusState private var addressFocused: Bool

    init(initialAddress: String) {
        _address = State(initialValue: initialAddress)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                StugaLockup()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Connect to Stuga")
                        .font(.title.weight(.bold))
                    Text("Enter the address you use to open Stuga. Your readings and password go directly to that server.")
                        .foregroundStyle(StugaTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                StugaCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Server address")
                            .font(.subheadline.weight(.semibold))
                        TextField("https://stuga.example.com", text: $address)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($addressFocused)
                            .submitLabel(.go)
                            .onSubmit { connect() }
                            .padding(12)
                            .background(StugaTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                            .overlay {
                                RoundedRectangle(cornerRadius: 5)
                                    .stroke(StugaTheme.strongLine, lineWidth: 1)
                            }
                        Text("Use private HTTPS when available. Plain HTTP is accepted only for local addresses such as stuga.local or a private LAN IP.")
                            .font(.caption)
                            .foregroundStyle(StugaTheme.muted)
                    }
                }

                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(StugaTheme.critical)
                        .accessibilityLabel("Connection error. \(error)")
                }

                Button(action: connect) {
                    HStack {
                        if isConnecting { ProgressView().tint(StugaTheme.actionText) }
                        Text(isConnecting ? "Connecting…" : "Connect")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isConnecting || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Label("Stuga remains local-first. This app does not use an intermediary cloud service.", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(StugaTheme.muted)
            }
            .frame(maxWidth: 560)
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { addressFocused = address.isEmpty }
    }

    private func connect() {
        guard !isConnecting else { return }
        isConnecting = true
        Task {
            await model.connect(to: address)
            isConnecting = false
        }
    }
}

private struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                StugaLockup()
                VStack(alignment: .leading, spacing: 7) {
                    Text("Welcome home")
                        .font(.title.weight(.bold))
                    Text("Sign in to \(model.serverDisplayName).")
                        .foregroundStyle(StugaTheme.muted)
                }

                if !model.isEncryptedConnection {
                    Label(
                        "This local HTTP connection is not encrypted. Sign in only on a trusted home network.",
                        systemImage: "exclamationmark.shield.fill"
                    )
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.warning)
                    .padding(12)
                    .background(StugaTheme.warningSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                StugaCard {
                    VStack(alignment: .leading, spacing: 16) {
                        fieldLabel("Email")
                        TextField("you@example.com", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .password }
                            .stugaTextField()

                        fieldLabel("Password")
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .focused($focusedField, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { signIn() }
                            .stugaTextField()
                    }
                }

                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(StugaTheme.critical)
                        .accessibilityLabel("Sign-in error. \(error)")
                }

                Button(action: signIn) {
                    HStack {
                        if isSigningIn { ProgressView().tint(StugaTheme.actionText) }
                        Text(isSigningIn ? "Signing in…" : "Sign in")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSigningIn || email.isEmpty || password.isEmpty)

                Button("Use another server") {
                    Task { await model.disconnect() }
                }
                .buttonStyle(SecondaryButtonStyle())

                Text("Your password is used only for this sign-in request and is never saved by the app.")
                    .font(.footnote)
                    .foregroundStyle(StugaTheme.muted)
            }
            .frame(maxWidth: 560)
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { focusedField = .email }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.semibold))
    }

    private func signIn() {
        guard !isSigningIn, !email.isEmpty, !password.isEmpty else { return }
        isSigningIn = true
        Task {
            await model.signIn(email: email, password: password)
            password = ""
            isSigningIn = false
        }
    }
}

private struct OwnerSetupRequiredView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            StugaLockup()
            StugaCard {
                VStack(alignment: .leading, spacing: 14) {
                    Image(systemName: "person.badge.key")
                        .font(.title)
                        .foregroundStyle(StugaTheme.action)
                    Text("Create the first Owner")
                        .font(.title2.weight(.bold))
                    Text("This Stuga has not been set up yet. For security, create the first Owner from the Stuga computer, then return here to sign in.")
                        .foregroundStyle(StugaTheme.muted)
                    if let url = model.serverAddress?.webURL() {
                        Link("Open Stuga", destination: url)
                            .font(.body.weight(.semibold))
                    }
                }
            }
            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(StugaTheme.critical)
            }
            Button("Check again") {
                Task { await model.retryConnection() }
            }
            .buttonStyle(PrimaryButtonStyle())
            Button("Use another server") {
                Task { await model.disconnect() }
            }
            .buttonStyle(SecondaryButtonStyle())
        }
        .frame(maxWidth: 560)
        .padding(24)
    }
}

private extension View {
    func stugaTextField() -> some View {
        padding(12)
            .background(StugaTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .stroke(StugaTheme.strongLine, lineWidth: 1)
            }
    }
}
