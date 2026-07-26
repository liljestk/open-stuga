// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "StugaCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "StugaCore", targets: ["StugaCore"]),
    ],
    targets: [
        .target(name: "StugaCore"),
        .testTarget(name: "StugaCoreTests", dependencies: ["StugaCore"]),
    ]
)
