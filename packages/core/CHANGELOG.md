# Changelog

## [0.15.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.14.0...core-v0.15.0) (2026-08-14)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.15.0

## [0.14.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.13.1...core-v0.14.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **renderer:** TextureBridge.dispose() now destroys the offscreen window synchronously instead of close()ing it. Consequences: the render window's close event and the page's beforeunload/unload no longer fire (closed still fires); 'disposed' listeners must not touch bridge.renderWindow.webContents (already destroyed); a leftover external renderWindow.destroy() workaround called after dispose() can throw — remove it, or guard it with isDestroyed(), or call it before dispose().

### Features

* **core:** forwardSharedTexture primitive on a new electron subpath ([bb8a172](https://github.com/naporin0624/electron-texture-bridge/commit/bb8a172f8167ef6608116c8e1c2b81cc6b410b0b))
* **core:** return PaintDefect from sendTextureFromPaintEvent instead of silent drop ([f89fd74](https://github.com/naporin0624/electron-texture-bridge/commit/f89fd74e63bde48ec34a7b45ec71345b53026246))
* **core:** wrap native send failures in TextureSendError ([c4eef46](https://github.com/naporin0624/electron-texture-bridge/commit/c4eef46a479aab12772c77584d9045efcfd4df29))
* DI seam (createTextureBridgeWith) + synchronous dispose + package docs ([cca64cd](https://github.com/naporin0624/electron-texture-bridge/commit/cca64cdb12ececea59e31a7059de7853fcffef84))
* forwardSharedTexture / forwardFrames zero-copy monitors + Multi-Receiver Grid example ([7696926](https://github.com/naporin0624/electron-texture-bridge/commit/769692637d16a4b5867b876529c22d08a4f7ffd9))
* make silent paint drops observable (frameDropped) + guard ESM __dirname shim ([06677e1](https://github.com/naporin0624/electron-texture-bridge/commit/06677e1cf5a2ce495aea7543218ff66f4a9c16e3))


### Bug Fixes

* **core:** harden electron-free guard against subpath specifiers and chunk splitting ([6cba3f3](https://github.com/naporin0624/electron-texture-bridge/commit/6cba3f3b707773b3bde57ec3a1edf9a5d5382e78))
* **core:** harden electron-free guard, preserve error cause, dedupe deliver ([8f924cf](https://github.com/naporin0624/electron-texture-bridge/commit/8f924cf5b35c11a014d1ff05903281fdfc39f575))
* **core:** require both subpath artifacts, document sendImportedTexture, pin regex negatives ([1f0560d](https://github.com/naporin0624/electron-texture-bridge/commit/1f0560dc3c34368a6e800a47251c6706cccd2c1c))
* harden forwardFrames/forwardSharedTexture and the multiviewer example (code-review max findings) ([4880ea0](https://github.com/naporin0624/electron-texture-bridge/commit/4880ea03412f654eac8eb50cb02305d1aa6216bf))
* **renderer:** harden frameDropped edge cases from final review ([12cca63](https://github.com/naporin0624/electron-texture-bridge/commit/12cca63e8d21b124ee3406f391905eb8e77d8902))
* **renderer:** surface dispose() teardown semantics in release notes ([e6fc292](https://github.com/naporin0624/electron-texture-bridge/commit/e6fc292afe05648fe7f2534a807fba01203cfb8e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.14.0

## [0.13.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.13.0...core-v0.13.1) (2026-06-15)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.13.1

## [0.13.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.12.0...core-v0.13.0) (2026-05-22)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.13.0

## [0.12.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.11.0...core-v0.12.0) (2026-04-29)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.12.0

## [0.11.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.10.0...core-v0.11.0) (2026-04-28)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.11.0

## [0.10.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.9.0...core-v0.10.0) (2026-04-21)


### Features

* add zero-copy GPU shared-texture receiver (Windows) ([2d1ad79](https://github.com/naporin0624/electron-texture-bridge/commit/2d1ad79d6ebdfadde48b740b9565d3903d8e8f3c))
* add zero-copy GPU shared-texture receiver (Windows) ([7909b5f](https://github.com/naporin0624/electron-texture-bridge/commit/7909b5f11f5a7de410a0c404886f8cb2af791853))
* **core:** re-export closeNativeHandle from native ([5bf928d](https://github.com/naporin0624/electron-texture-bridge/commit/5bf928d062afed1a265a3ba39300c419eadd1d05))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.10.0

## [0.9.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.8.2...core-v0.9.0) (2026-04-17)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.9.0

## [0.8.2](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.8.1...core-v0.8.2) (2026-04-17)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.8.2

## [0.8.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.8.0...core-v0.8.1) (2026-04-17)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.8.1

## [0.8.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.7.1...core-v0.8.0) (2026-04-02)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.8.0

## [0.7.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.7.0...core-v0.7.1) (2026-04-02)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.7.1

## [0.7.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.6...core-v0.7.0) (2026-03-29)


### Features

* **spout:** event-driven receiver via native thread ([aa24f9e](https://github.com/naporin0624/electron-texture-bridge/commit/aa24f9ea3f638f8f91998c4b6472b8c5f6d17ee8))


### Bug Fixes

* **ci:** use stub module for native package in vitest ([86eccfa](https://github.com/naporin0624/electron-texture-bridge/commit/86eccfacdf568940650eec9b350d2cb581fe89c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.7.0

## [0.6.6](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.5...core-v0.6.6) (2026-03-29)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.6

## [0.6.5](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.4...core-v0.6.5) (2026-03-20)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.5

## [0.6.4](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.3...core-v0.6.4) (2026-03-20)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.4

## [0.6.3](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.2...core-v0.6.3) (2026-03-20)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.3

## [0.6.2](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.1...core-v0.6.2) (2026-03-20)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.2

## [0.6.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.6.0...core-v0.6.1) (2026-03-20)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.1

## [0.6.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.5.1...core-v0.6.0) (2026-03-18)


### Features

* explicit native disposal with Symbol.dispose support ([#18](https://github.com/naporin0624/electron-texture-bridge/issues/18)) ([e65509e](https://github.com/naporin0624/electron-texture-bridge/commit/e65509eb4b12175c6f4416d3f983f2cbf506ecc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.6.0

## [0.5.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.5.0...core-v0.5.1) (2026-03-18)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.5.1

## [0.5.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.4.1...core-v0.5.0) (2026-03-18)


### Features

* add TextureReceiver and listSenders API for Syphon/Spout ([#13](https://github.com/naporin0624/electron-texture-bridge/issues/13)) ([9bbfb54](https://github.com/naporin0624/electron-texture-bridge/commit/9bbfb54dd2b89f7fd621a45f4cd57ddbfb44c4e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.5.0

## [0.4.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.4.0...core-v0.4.1) (2026-02-14)


### Bug Fixes

* guard against undefined textureInfo in paint event ([#10](https://github.com/naporin0624/electron-texture-bridge/issues/10)) ([f9f20e4](https://github.com/naporin0624/electron-texture-bridge/commit/f9f20e49efb1857c42a895c52ccd2a6d8bc2c49e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.4.1

## [0.4.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.5...core-v0.4.0) (2026-02-14)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* convert to pnpm monorepo with scoped packages ([17a9e0a](https://github.com/naporin0624/electron-texture-bridge/commit/17a9e0a8b22627ee28077506edef990153b20fec))
* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.4.0

## [0.3.5](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.4...core-v0.3.5) (2026-02-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.5

## [0.3.4](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.3...core-v0.3.4) (2026-02-12)


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.4

## [0.3.3](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.2...core-v0.3.3) (2026-02-12)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.3

## [0.3.2](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.1...core-v0.3.2) (2026-02-11)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.2

## [0.3.1](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.3.0...core-v0.3.1) (2026-02-10)


### Miscellaneous Chores

* **core:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.1

## [0.3.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.2.0...core-v0.3.0) (2026-02-10)


### Features

* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.3.0

## [0.2.0](https://github.com/naporin0624/electron-texture-bridge/compare/core-v0.1.0...core-v0.2.0) (2026-02-10)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* convert to pnpm monorepo with scoped packages ([17a9e0a](https://github.com/naporin0624/electron-texture-bridge/commit/17a9e0a8b22627ee28077506edef990153b20fec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge bumped to 0.2.0
