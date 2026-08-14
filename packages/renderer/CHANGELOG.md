# Changelog

## [0.15.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.14.0...renderer-v0.15.0) (2026-08-14)


### Features

* **renderer:** report forwardFrames delivery state via forwardStatus ([89b37e2](https://github.com/naporin0624/electron-texture-bridge/commit/89b37e2fbf08edd05b7ca7096e813b7b737d2fad))
* **renderer:** report forwardFrames delivery state via forwardStatus ([4236e8d](https://github.com/naporin0624/electron-texture-bridge/commit/4236e8df396dfe449f8dc946a1cf80c3ddcfd3cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.15.0

## [0.14.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.13.1...renderer-v0.14.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **renderer:** TextureBridge.dispose() now destroys the offscreen window synchronously instead of close()ing it. Consequences: the render window's close event and the page's beforeunload/unload no longer fire (closed still fires); 'disposed' listeners must not touch bridge.renderWindow.webContents (already destroyed); a leftover external renderWindow.destroy() workaround called after dispose() can throw — remove it, or guard it with isDestroyed(), or call it before dispose().

### Features

* DI seam (createTextureBridgeWith) + synchronous dispose + package docs ([cca64cd](https://github.com/naporin0624/electron-texture-bridge/commit/cca64cdb12ececea59e31a7059de7853fcffef84))
* forwardSharedTexture / forwardFrames zero-copy monitors + Multi-Receiver Grid example ([7696926](https://github.com/naporin0624/electron-texture-bridge/commit/769692637d16a4b5867b876529c22d08a4f7ffd9))
* make silent paint drops observable (frameDropped) + guard ESM __dirname shim ([06677e1](https://github.com/naporin0624/electron-texture-bridge/commit/06677e1cf5a2ce495aea7543218ff66f4a9c16e3))
* **renderer:** add OSR scale policy resolvers for Electron 41+ deviceScaleFactor ([557a35f](https://github.com/naporin0624/electron-texture-bridge/commit/557a35f6f6328223fd15bfb008c3f7b08432732b))
* **renderer:** apply OSR scale policy to window sizing and resize ([a9d44db](https://github.com/naporin0624/electron-texture-bridge/commit/a9d44dbf0700a7126967edd38c59403f376c7863))
* **renderer:** emit frameDropped event for silently dropped paint frames ([9e74900](https://github.com/naporin0624/electron-texture-bridge/commit/9e74900f23f2dfe1226384742bbc6d8ab5691e19))
* **renderer:** expose createTextureBridgeWith dependency-injection seam ([770d223](https://github.com/naporin0624/electron-texture-bridge/commit/770d22317593426bc3932799e35ed7dcce94fbf0))
* **renderer:** expose droppedReason and harden frameDropped test coverage ([7187bb3](https://github.com/naporin0624/electron-texture-bridge/commit/7187bb321ceae0358bf7dc6232f4f19de73e4ace))
* **renderer:** pin offscreen.deviceScaleFactor=1 under unit-scale policy ([2ca1c92](https://github.com/naporin0624/electron-texture-bridge/commit/2ca1c922bcc80385603d3fecf7a8232890ae432f))
* **renderer:** re-export TextureSendError and document the new throw contract ([275124a](https://github.com/naporin0624/electron-texture-bridge/commit/275124a635aa1378bd9ed635df372b3afe32dfbf))
* **renderer:** TextureBridge.forwardFrames zero-copy monitor driver ([66c9d13](https://github.com/naporin0624/electron-texture-bridge/commit/66c9d13caa7797d65063ed09ddf88d255d382dbf))
* version-aware OSR scale policy (pin deviceScaleFactor on Electron 41+) ([04dfe8a](https://github.com/naporin0624/electron-texture-bridge/commit/04dfe8aec88c619040fa7c1efeac30398a9559b2))


### Bug Fixes

* **core:** harden electron-free guard, preserve error cause, dedupe deliver ([8f924cf](https://github.com/naporin0624/electron-texture-bridge/commit/8f924cf5b35c11a014d1ff05903281fdfc39f575))
* harden forwardFrames/forwardSharedTexture and the multiviewer example (code-review max findings) ([4880ea0](https://github.com/naporin0624/electron-texture-bridge/commit/4880ea03412f654eac8eb50cb02305d1aa6216bf))
* **renderer:** destroy the offscreen window synchronously in dispose() ([9403e2a](https://github.com/naporin0624/electron-texture-bridge/commit/9403e2a67bc56d08ccb645baacde46071ff2d8ef))
* **renderer:** guard forwardFrames against post-dispose registration and dead targets ([4440eed](https://github.com/naporin0624/electron-texture-bridge/commit/4440eed0d436ccabd165619e517d025d73d4067f))
* **renderer:** harden frameDropped edge cases from final review ([12cca63](https://github.com/naporin0624/electron-texture-bridge/commit/12cca63e8d21b124ee3406f391905eb8e77d8902))
* **renderer:** keep preview sendFrame best-effort and cover PreviewManager ([3f4fb50](https://github.com/naporin0624/electron-texture-bridge/commit/3f4fb5024aa4c4943d464858206ed1e707c56b23))
* **renderer:** make frame forwards independent of the native send path ([d0c7186](https://github.com/naporin0624/electron-texture-bridge/commit/d0c7186322cf2fe3d2285f87a179b1b7d862f586))
* **renderer:** surface dispose() teardown semantics in release notes ([e6fc292](https://github.com/naporin0624/electron-texture-bridge/commit/e6fc292afe05648fe7f2534a807fba01203cfb8e))
* **renderer:** unhook destroyed listeners on dispose and reject destroyed targets ([17e5fb4](https://github.com/naporin0624/electron-texture-bridge/commit/17e5fb42eaff74ed53175fccda2288de65ffbc7c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.14.0

## [0.13.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.13.0...renderer-v0.13.1) (2026-06-15)


### Bug Fixes

* **renderer:** ESM __dirname shim + docs feedback (EN/JA) ([8c06ba6](https://github.com/naporin0624/electron-texture-bridge/commit/8c06ba6095aae756ac165605139ab276bef20197))
* **renderer:** inject __dirname shim into ESM build for preview assets ([df76799](https://github.com/naporin0624/electron-texture-bridge/commit/df7679996b1a72d06d19f7ca9cb2124145872a22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.13.1

## [0.13.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.12.0...renderer-v0.13.0) (2026-05-22)


### Features

* **renderer:** pixelExact option for DPR-independent framebuffer ([8ba39af](https://github.com/naporin0624/electron-texture-bridge/commit/8ba39afe01b4c7febba941afe73070cb9eff4822))
* **renderer:** pixelExact option for DPR-independent framebuffer ([ee1a314](https://github.com/naporin0624/electron-texture-bridge/commit/ee1a3147852173d8f6405addfea0d1715b87e418))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.13.0

## [0.12.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.11.0...renderer-v0.12.0) (2026-04-29)


### Features

* **example:** add Flip Y checkbox + bridge.setFlipY live toggle ([7bc47ab](https://github.com/naporin0624/electron-texture-bridge/commit/7bc47ab36818b9d88fe316df81844f4a4352249c))
* **receiver:** make macOS Y-flip opt-out via flipY option ([5ac4e2b](https://github.com/naporin0624/electron-texture-bridge/commit/5ac4e2b74784a80488da7a2f3dd428081d2f1e5a))
* **receiver:** make macOS Y-flip opt-out via flipY option ([1849229](https://github.com/naporin0624/electron-texture-bridge/commit/1849229d65c6290ff6ebb1965ec337966ea22c8e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.12.0

## [0.11.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.10.0...renderer-v0.11.0) (2026-04-28)


### Features

* **renderer:** add includeAlpha option to forward alpha into shared texture ([a675d53](https://github.com/naporin0624/electron-texture-bridge/commit/a675d53b3ed60560704ee3c240029a879b6f30eb))
* **renderer:** add transparent mode to forward alpha into shared texture ([c7f98fe](https://github.com/naporin0624/electron-texture-bridge/commit/c7f98fe399a48997de078b767d3917aa483ff488))


### Bug Fixes

* **renderer:** defer imported.release() to avoid renderer tracker race ([a955fea](https://github.com/naporin0624/electron-texture-bridge/commit/a955feaa7bd82d8a534584b3a1dc7395db8c78f8))
* **renderer:** defer imported.release() to avoid renderer tracker race ([7242ec9](https://github.com/naporin0624/electron-texture-bridge/commit/7242ec965e13c12a2bcf0bb5040d1c98293dad8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.11.0

## [0.10.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.9.0...renderer-v0.10.0) (2026-04-21)


### Features

* add zero-copy GPU shared-texture receiver (Windows) ([2d1ad79](https://github.com/naporin0624/electron-texture-bridge/commit/2d1ad79d6ebdfadde48b740b9565d3903d8e8f3c))
* add zero-copy GPU shared-texture receiver (Windows) ([7909b5f](https://github.com/naporin0624/electron-texture-bridge/commit/7909b5f11f5a7de410a0c404886f8cb2af791853))


### Bug Fixes

* **consumer:** release handler closure on dispose to avoid GC retention ([8a65eeb](https://github.com/naporin0624/electron-texture-bridge/commit/8a65eeb4f24834f03a79b57740e45fa4c7ee88bc))
* **renderer:** address shared-texture-receiver review feedback ([8546105](https://github.com/naporin0624/electron-texture-bridge/commit/854610580529eb8be412b72148eed606d548e59c))
* **renderer:** close native handle leaks + harden consumer/dispatcher/bridge ([1b7b7ec](https://github.com/naporin0624/electron-texture-bridge/commit/1b7b7ecc195a137b074eaa5e337307c0be026407))
* **renderer:** count _send() errors toward circuit breaker ([82ad3c4](https://github.com/naporin0624/electron-texture-bridge/commit/82ad3c4080b514b1612df96d2bc685d7ad986a9c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.10.0

## [0.9.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.2...renderer-v0.9.0) (2026-04-17)


### ⚠ BREAKING CHANGES

* The native `TextureReceiver.startListening(callback)` API is removed. Frame reception now always goes through JS-driven `setInterval` polling via `receiveFrame()`, matching the semantics the macOS path already used.

### Features

* unify receiver to JS-driven polling, remove startListening ([4daa304](https://github.com/naporin0624/electron-texture-bridge/commit/4daa304231ca6b8b1358a547839f6392a605e911))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.9.0

## [0.8.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.1...renderer-v0.8.2) (2026-04-17)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.2

## [0.8.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.8.0...renderer-v0.8.1) (2026-04-17)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.1

## [0.8.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.7.1...renderer-v0.8.0) (2026-04-02)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.8.0

## [0.7.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.7.0...renderer-v0.7.1) (2026-04-02)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.7.1

## [0.7.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.6...renderer-v0.7.0) (2026-03-29)


### Features

* **spout:** event-driven receiver via native thread ([aa24f9e](https://github.com/naporin0624/electron-texture-bridge/commit/aa24f9ea3f638f8f91998c4b6472b8c5f6d17ee8))
* **spout:** event-driven receiver via native thread + ThreadsafeFunction ([70fbe9e](https://github.com/naporin0624/electron-texture-bridge/commit/70fbe9e775ce9b13e85ab9b879f112227b3882cb))
* **syphon:** event-driven receiver via native listener thread ([be34204](https://github.com/naporin0624/electron-texture-bridge/commit/be34204add6467df914c05a10b7fb0996d894171))
* **syphon:** event-driven receiver via native listener thread ([358fb41](https://github.com/naporin0624/electron-texture-bridge/commit/358fb41dcdc3615d6f92af96172c34ff2409e86d))


### Bug Fixes

* **ci:** use stub module for native package in vitest ([86eccfa](https://github.com/naporin0624/electron-texture-bridge/commit/86eccfacdf568940650eec9b350d2cb581fe89c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.7.0

## [0.6.6](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.5...renderer-v0.6.6) (2026-03-29)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.6

## [0.6.5](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.4...renderer-v0.6.5) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.5

## [0.6.4](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.3...renderer-v0.6.4) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.4

## [0.6.3](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.2...renderer-v0.6.3) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.3

## [0.6.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.1...renderer-v0.6.2) (2026-03-20)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.2

## [0.6.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.6.0...renderer-v0.6.1) (2026-03-20)


### Bug Fixes

* **spout:** fix receiver never delivering frames on Windows ([a595b43](https://github.com/naporin0624/electron-texture-bridge/commit/a595b437bd654d4eb4a27894cf1629d8bf8f7012))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.1

## [0.6.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.5.1...renderer-v0.6.0) (2026-03-18)


### Features

* explicit native disposal with Symbol.dispose support ([#18](https://github.com/naporin0624/electron-texture-bridge/issues/18)) ([e65509e](https://github.com/naporin0624/electron-texture-bridge/commit/e65509eb4b12175c6f4416d3f983f2cbf506ecc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.6.0

## [0.5.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.5.0...renderer-v0.5.1) (2026-03-18)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.5.1

## [0.5.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.4.1...renderer-v0.5.0) (2026-03-18)


### Features

* add TextureReceiver and listSenders API for Syphon/Spout ([#13](https://github.com/naporin0624/electron-texture-bridge/issues/13)) ([9bbfb54](https://github.com/naporin0624/electron-texture-bridge/commit/9bbfb54dd2b89f7fd621a45f4cd57ddbfb44c4e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.5.0

## [0.4.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.4.0...renderer-v0.4.1) (2026-02-14)


### Bug Fixes

* guard against undefined textureInfo in paint event ([#10](https://github.com/naporin0624/electron-texture-bridge/issues/10)) ([f9f20e4](https://github.com/naporin0624/electron-texture-bridge/commit/f9f20e49efb1857c42a895c52ccd2a6d8bc2c49e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.4.1

## [0.4.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.5...renderer-v0.4.0) (2026-02-14)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.4.0

## [0.3.5](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.4...renderer-v0.3.5) (2026-02-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.5

## [0.3.4](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.3...renderer-v0.3.4) (2026-02-12)


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.4

## [0.3.3](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.2...renderer-v0.3.3) (2026-02-12)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.3

## [0.3.2](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.1...renderer-v0.3.2) (2026-02-11)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.2

## [0.3.1](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.3.0...renderer-v0.3.1) (2026-02-10)


### Miscellaneous Chores

* **renderer:** Synchronize electron-texture-bridge versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.1

## [0.3.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.2.0...renderer-v0.3.0) (2026-02-10)


### Features

* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.3.0

## [0.2.0](https://github.com/naporin0624/electron-texture-bridge/compare/renderer-v0.1.0...renderer-v0.2.0) (2026-02-10)


### Features

* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @napolab/texture-bridge-core bumped to 0.2.0
