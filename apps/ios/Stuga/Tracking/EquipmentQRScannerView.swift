import AVFoundation
import Foundation
import SwiftUI
import UIKit

struct EquipmentScannerSheet: View {
    let onScan: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var manualCode = ""
    @State private var cameraMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                ZStack {
                    EquipmentQRScannerView(
                        onCode: finish,
                        onFailure: { cameraMessage = $0 }
                    )
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(.white, style: StrokeStyle(lineWidth: 3, dash: [12]))
                        .frame(width: 250, height: 250)
                        .accessibilityHidden(true)
                    if let cameraMessage {
                        ContentUnavailableView {
                            Label("Camera unavailable", systemImage: "camera.fill")
                        } description: {
                            Text(cameraMessage)
                        }
                        .padding()
                        .background(.regularMaterial)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxHeight: 430)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or enter the code from the label")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(StugaTheme.muted)
                    HStack {
                        TextField("stuga://equipment?…", text: $manualCode)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.URL)
                        Button("Open") { finish(manualCode) }
                            .disabled(EquipmentQRCode.parse(manualCode) == nil)
                    }
                    .padding(12)
                    .background(StugaTheme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(StugaTheme.line)
                    }
                }
            }
            .padding(16)
            .background(StugaScreenBackground())
            .navigationTitle("Scan equipment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func finish(_ value: String) {
        guard EquipmentQRCode.parse(value) != nil else { return }
        dismiss()
        onScan(value)
    }
}

private struct EquipmentQRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> EquipmentQRScannerController {
        EquipmentQRScannerController(onCode: onCode, onFailure: onFailure)
    }

    func updateUIViewController(
        _ uiViewController: EquipmentQRScannerController,
        context: Context
    ) {}
}

private final class EquipmentQRScannerController:
    UIViewController,
    AVCaptureMetadataOutputObjectsDelegate
{
    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "net.nysta.stuga.equipment-qr-session")
    private let onCode: (String) -> Void
    private let onFailure: (String) -> Void
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var configured = false
    private var completed = false

    init(onCode: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
        self.onCode = onCode
        self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.configureAndStart()
                    } else {
                        self.onFailure(
                            "Camera access was not granted. You can enter the printed code instead."
                        )
                    }
                }
            }
        case .denied, .restricted:
            onFailure("Allow camera access in Settings, or enter the printed code instead.")
        @unknown default:
            onFailure("The camera is not available. Enter the printed code instead.")
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    // Session work stays off the main thread; only the preview layer is UIKit work.
    private func configureAndStart() {
        completed = false
        sessionQueue.async { [weak self] in
            guard let self, !self.captureSession.isRunning else { return }
            if !self.configured {
                guard let camera = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: camera) else {
                    self.reportFailure(
                        "No usable camera is available. Enter the printed code instead."
                    )
                    return
                }
                let output = AVCaptureMetadataOutput()
                guard self.captureSession.canAddInput(input),
                      self.captureSession.canAddOutput(output) else {
                    self.reportFailure("This camera cannot scan QR codes.")
                    return
                }
                self.captureSession.beginConfiguration()
                self.captureSession.addInput(input)
                self.captureSession.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
                self.captureSession.commitConfiguration()
                self.configured = true

                DispatchQueue.main.async { [weak self] in
                    guard let self, self.previewLayer == nil else { return }
                    let preview = AVCaptureVideoPreviewLayer(session: self.captureSession)
                    preview.videoGravity = .resizeAspectFill
                    preview.frame = self.view.bounds
                    self.view.layer.insertSublayer(preview, at: 0)
                    self.previewLayer = preview
                }
            }
            self.captureSession.startRunning()
        }
    }

    private func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self, self.captureSession.isRunning else { return }
            self.captureSession.stopRunning()
        }
    }

    private func reportFailure(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.onFailure(message)
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !completed,
              let code = metadataObjects
                .compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
                .first(where: { $0.type == .qr })?
                .stringValue,
              EquipmentQRCode.parse(code) != nil else {
            return
        }
        completed = true
        stopSession()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onCode(code)
    }
}
