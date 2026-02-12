# Changelog

## [0.3.4](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.3...native-v0.3.4) (2026-02-12)


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))

## [0.3.3](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.2...native-v0.3.3) (2026-02-12)


### Bug Fixes

* replace unused prepublish script with create-npm-dir ([8f6801f](https://github.com/naporin0624/electron-texture-bridge/commit/8f6801f306b37105c3dc8fc54e045155d4cc72da))

## [0.3.2](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.1...native-v0.3.2) (2026-02-11)


### Bug Fixes

* use napi triples config and create-npm-dir for CI artifacts ([e39e8e2](https://github.com/naporin0624/electron-texture-bridge/commit/e39e8e23029c44df9cb42fcdec2e941cd69fd721))

## [0.3.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.0...native-v0.3.1) (2026-02-10)


### Bug Fixes

* align napi binaryName with .node filename for CI artifacts ([92756b1](https://github.com/naporin0624/electron-texture-bridge/commit/92756b18b606f914a28870ccd9f0e3ac04b2ed25))

## [0.3.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.2.0...native-v0.3.0) (2026-02-10)


### Features

* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))

## [0.2.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.1.0...native-v0.2.0) (2026-02-10)


### Features

* add release-please CI pipeline with prebuilt Syphon/Spout distribution ([2c638da](https://github.com/naporin0624/electron-texture-bridge/commit/2c638daee386e03889a8c90205ac938d0bdda1e8))
* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* convert to pnpm monorepo with scoped packages ([17a9e0a](https://github.com/naporin0624/electron-texture-bridge/commit/17a9e0a8b22627ee28077506edef990153b20fec))


### Bug Fixes

* preserve Spout2 SDK directory structure for relative includes ([3283aa8](https://github.com/naporin0624/electron-texture-bridge/commit/3283aa8b390730fa2f6b76aba30422bc3e366ee4))
* remove optionalDependencies from source to fix CI lockfile mismatch ([bcab69d](https://github.com/naporin0624/electron-texture-bridge/commit/bcab69ddbb0537ea80fe515ef7178765c5ee565d))
