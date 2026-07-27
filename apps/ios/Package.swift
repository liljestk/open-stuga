// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "StuguCore",
    platforms: [
        .iOS("26.0"),
        .macOS(.v14),
    ],
    products: [
        .library(name: "StuguCore", targets: ["StuguCore"]),
    ],
    targets: [
        .target(name: "StuguCore"),
        .testTarget(name: "StuguCoreTests", dependencies: ["StuguCore"]),
    ]
)
