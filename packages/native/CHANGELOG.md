# Changelog

## [0.15.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.14.0...native-v0.15.0) (2026-08-14)


### Miscellaneous Chores

* **native:** Synchronize electron-texture-bridge versions

## [0.14.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.13.1...native-v0.14.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **renderer:** TextureBridge.dispose() now destroys the offscreen window synchronously instead of close()ing it. Consequences: the render window's close event and the page's beforeunload/unload no longer fire (closed still fires); 'disposed' listeners must not touch bridge.renderWindow.webContents (already destroyed); a leftover external renderWindow.destroy() workaround called after dispose() can throw — remove it, or guard it with isDestroyed(), or call it before dispose().

### Bug Fixes

* **renderer:** surface dispose() teardown semantics in release notes ([e6fc292](https://github.com/naporin0624/electron-texture-bridge/commit/e6fc292afe05648fe7f2534a807fba01203cfb8e))

## [0.13.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.13.0...native-v0.13.1) (2026-06-15)


### Miscellaneous Chores

* **native:** Synchronize electron-texture-bridge versions

## [0.13.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.12.0...native-v0.13.0) (2026-05-22)


### Miscellaneous Chores

* **native:** Synchronize electron-texture-bridge versions

## [0.12.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.11.0...native-v0.12.0) (2026-04-29)


### Features

* **receiver:** make macOS Y-flip opt-out via flipY option ([5ac4e2b](https://github.com/naporin0624/electron-texture-bridge/commit/5ac4e2b74784a80488da7a2f3dd428081d2f1e5a))
* **receiver:** make macOS Y-flip opt-out via flipY option ([1849229](https://github.com/naporin0624/electron-texture-bridge/commit/1849229d65c6290ff6ebb1965ec337966ea22c8e))

## [0.11.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.10.0...native-v0.11.0) (2026-04-28)


### Features

* add zero-copy GPU shared-texture receiver (macOS) ([1f37662](https://github.com/naporin0624/electron-texture-bridge/commit/1f37662ae39ba24db605789af3be996f52ce7fcd))
* add zero-copy GPU shared-texture receiver (macOS) ([f5d60aa](https://github.com/naporin0624/electron-texture-bridge/commit/f5d60aaff87f8806adf47a45c504e23c8a7e6759))

## [0.10.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.9.0...native-v0.10.0) (2026-04-21)


### Features

* add zero-copy GPU shared-texture receiver (Windows) ([2d1ad79](https://github.com/naporin0624/electron-texture-bridge/commit/2d1ad79d6ebdfadde48b740b9565d3903d8e8f3c))
* add zero-copy GPU shared-texture receiver (Windows) ([7909b5f](https://github.com/naporin0624/electron-texture-bridge/commit/7909b5f11f5a7de410a0c404886f8cb2af791853))
* **example:** receiver window uses zero-copy GPU path ([e1a29fa](https://github.com/naporin0624/electron-texture-bridge/commit/e1a29fa43c439fca3e12fecc89a59553ca63ed49))
* **native:** add closeNativeHandle + fix disconnected/pixelFormat/metal leaks ([f4b0ef8](https://github.com/naporin0624/electron-texture-bridge/commit/f4b0ef8be8b98804a3de2629dcaf7279512650e9))
* **native:** implement macOS IOSurface path for receiveSharedTexture ([8cf7e1a](https://github.com/naporin0624/electron-texture-bridge/commit/8cf7e1a2a4b4a226e0a65dd96d79d463f2e1e98b))


### Bug Fixes

* **native:** address receiver review feedback ([71fbfe4](https://github.com/naporin0624/electron-texture-bridge/commit/71fbfe4628bb42368024e53d0f599ef00559c08e))
* **native:** rewrite Windows receiver without SpoutDX ([e1a29fa](https://github.com/naporin0624/electron-texture-bridge/commit/e1a29fa43c439fca3e12fecc89a59553ca63ed49))


### Performance Improvements

* **native:** cache shared NT handle, use DuplicateHandle per frame (win) ([bf1ea0e](https://github.com/naporin0624/electron-texture-bridge/commit/bf1ea0efd45407e0a1c1bda518f5ec0be3e30412))

## [0.9.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.8.2...native-v0.9.0) (2026-04-17)


### ⚠ BREAKING CHANGES

* The native `TextureReceiver.startListening(callback)` API is removed. Frame reception now always goes through JS-driven `setInterval` polling via `receiveFrame()`, matching the semantics the macOS path already used.

### Features

* unify receiver to JS-driven polling, remove startListening ([4daa304](https://github.com/naporin0624/electron-texture-bridge/commit/4daa304231ca6b8b1358a547839f6392a605e911))

## [0.8.2](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.8.1...native-v0.8.2) (2026-04-17)


### Bug Fixes

* **native:** document drop-latest backpressure in start_listening ([180d244](https://github.com/naporin0624/electron-texture-bridge/commit/180d244b9c2dd79691e8277cb0968f37f8a8f225))
* **native:** document drop-latest backpressure in start_listening ([961caf9](https://github.com/naporin0624/electron-texture-bridge/commit/961caf9f343fd6832d119e0f052d087e2758f94a))

## [0.8.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.8.0...native-v0.8.1) (2026-04-17)


### Bug Fixes

* **spout:** use bounded tsfn queue for drop-latest semantics ([aee9271](https://github.com/naporin0624/electron-texture-bridge/commit/aee9271ea9396c8a8a14917ac060ed13fa836d1b))
* **spout:** use bounded tsfn queue for drop-latest semantics ([a442111](https://github.com/naporin0624/electron-texture-bridge/commit/a442111d6992a51e0341c60ce7c44225fe40b6e0))

## [0.8.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.7.1...native-v0.8.0) (2026-04-02)


### Features

* **syphon:** event-driven receiver with vertical flip fix ([2d62f02](https://github.com/naporin0624/electron-texture-bridge/commit/2d62f0251ffefc735654ef1ba77223cfc59a41e9))


### Bug Fixes

* **syphon:** set flipped:YES for correct vertical orientation in Syphon output ([83cf3f6](https://github.com/naporin0624/electron-texture-bridge/commit/83cf3f63f8fb61b95730e0bc7a3666ba3c9bbf27))

## [0.7.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.7.0...native-v0.7.1) (2026-04-02)


### Bug Fixes

* **syphon:** correct color and orientation in sender/receiver ([882c87d](https://github.com/naporin0624/electron-texture-bridge/commit/882c87d483d7ae745790ee5c34d149ac14f7af62))
* **syphon:** correct pixel format detection, color swap, and vertical flip in sender/receiver ([041de0c](https://github.com/naporin0624/electron-texture-bridge/commit/041de0ce8db36bff550db73033510d422b148875))

## [0.7.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.6...native-v0.7.0) (2026-03-29)


### Features

* **spout:** event-driven receiver via native thread ([aa24f9e](https://github.com/naporin0624/electron-texture-bridge/commit/aa24f9ea3f638f8f91998c4b6472b8c5f6d17ee8))
* **spout:** event-driven receiver via native thread + ThreadsafeFunction ([70fbe9e](https://github.com/naporin0624/electron-texture-bridge/commit/70fbe9e775ce9b13e85ab9b879f112227b3882cb))
* **syphon:** event-driven receiver via native listener thread ([be34204](https://github.com/naporin0624/electron-texture-bridge/commit/be34204add6467df914c05a10b7fb0996d894171))
* **syphon:** event-driven receiver via native listener thread ([358fb41](https://github.com/naporin0624/electron-texture-bridge/commit/358fb41dcdc3615d6f92af96172c34ff2409e86d))


### Bug Fixes

* **ci:** use stub module for native package in vitest ([86eccfa](https://github.com/naporin0624/electron-texture-bridge/commit/86eccfacdf568940650eec9b350d2cb581fe89c6))
* **spout:** remove duplicate return code comments in receiver bridge ([919c6f1](https://github.com/naporin0624/electron-texture-bridge/commit/919c6f1c7c2ae0f7166d02c41a9d5454b8434c8b))

## [0.6.6](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.5...native-v0.6.6) (2026-03-29)


### Bug Fixes

* **spout:** fix ReceiveImage API misuse and cache receiver buffer ([a0efd77](https://github.com/naporin0624/electron-texture-bridge/commit/a0efd779e4c381b95e3bdbd08290ceec97ece7e4))
* **spout:** format Rust code with cargo fmt ([3f3af54](https://github.com/naporin0624/electron-texture-bridge/commit/3f3af5413e9240bcad0df6adb848a324d5d2734f))
* **spout:** format Rust code with cargo fmt ([0f31e66](https://github.com/naporin0624/electron-texture-bridge/commit/0f31e667e1e6f76bcfeba7bc2f09f5389a71a43c))

## [0.6.5](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.4...native-v0.6.5) (2026-03-20)


### Bug Fixes

* **spout:** use DXGI_FORMAT for ReceiveImage instead of GL_RGBA ([0a91a4a](https://github.com/naporin0624/electron-texture-bridge/commit/0a91a4adc18d44311698d70391222674c1330e28))

## [0.6.4](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.3...native-v0.6.4) (2026-03-20)


### Performance Improvements

* **syphon:** skip redundant GPU readback + reuse staging buffer ([e405761](https://github.com/naporin0624/electron-texture-bridge/commit/e405761e6e631b1ce9d34a891c6bb5417a2eb784))

## [0.6.3](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.2...native-v0.6.3) (2026-03-20)


### Bug Fixes

* **spout:** use ReceiveImage() for CPU pixel readback ([d290981](https://github.com/naporin0624/electron-texture-bridge/commit/d290981507610d124683b2bc89f01979e2428342))

## [0.6.2](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.1...native-v0.6.2) (2026-03-20)


### Bug Fixes

* **spout:** use ReceiveTexture() + GetSenderTexture() pattern ([5ed3382](https://github.com/naporin0624/electron-texture-bridge/commit/5ed338299ad39c56245d27ddc6361f32cdb04cd2))

## [0.6.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.6.0...native-v0.6.1) (2026-03-20)


### Bug Fixes

* **spout:** fix receiver never delivering frames on Windows ([a595b43](https://github.com/naporin0624/electron-texture-bridge/commit/a595b437bd654d4eb4a27894cf1629d8bf8f7012))

## [0.6.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.5.1...native-v0.6.0) (2026-03-18)


### Features

* explicit native disposal with Symbol.dispose support ([#18](https://github.com/naporin0624/electron-texture-bridge/issues/18)) ([e65509e](https://github.com/naporin0624/electron-texture-bridge/commit/e65509eb4b12175c6f4416d3f983f2cbf506ecc4))

## [0.5.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.5.0...native-v0.5.1) (2026-03-18)


### Bug Fixes

* **native:** add rpath for CARGO_BUILD_TARGET cross-compile test binaries ([#16](https://github.com/naporin0624/electron-texture-bridge/issues/16)) ([571498c](https://github.com/naporin0624/electron-texture-bridge/commit/571498c9d5659dd6002612dbd300a64a4dbff0cf))

## [0.5.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.4.1...native-v0.5.0) (2026-03-18)


### Features

* add TextureReceiver and listSenders API for Syphon/Spout ([#13](https://github.com/naporin0624/electron-texture-bridge/issues/13)) ([9bbfb54](https://github.com/naporin0624/electron-texture-bridge/commit/9bbfb54dd2b89f7fd621a45f4cd57ddbfb44c4e6))

## [0.4.1](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.4.0...native-v0.4.1) (2026-02-14)


### Bug Fixes

* guard against undefined textureInfo in paint event ([#10](https://github.com/naporin0624/electron-texture-bridge/issues/10)) ([f9f20e4](https://github.com/naporin0624/electron-texture-bridge/commit/f9f20e49efb1857c42a895c52ccd2a6d8bc2c49e))

## [0.4.0](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.5...native-v0.4.0) (2026-02-14)


### Features

* add release-please CI pipeline with prebuilt Syphon/Spout distribution ([2c638da](https://github.com/naporin0624/electron-texture-bridge/commit/2c638daee386e03889a8c90205ac938d0bdda1e8))
* add renderer package with high-level createTextureBridge API ([8d44863](https://github.com/naporin0624/electron-texture-bridge/commit/8d44863610d74ace40d9b0568674ca326702be6e))
* convert to pnpm monorepo with scoped packages ([17a9e0a](https://github.com/naporin0624/electron-texture-bridge/commit/17a9e0a8b22627ee28077506edef990153b20fec))
* migrate to @napolab/texture-bridge package scope ([2f5d3e4](https://github.com/naporin0624/electron-texture-bridge/commit/2f5d3e4c6a6af61a00ae05dc05e25cdc45ff116a))


### Bug Fixes

* add repository field for npm provenance verification ([32da705](https://github.com/naporin0624/electron-texture-bridge/commit/32da705c2d22796c3db80b8284b083c44279eb88))
* align napi binaryName with .node filename for CI artifacts ([92756b1](https://github.com/naporin0624/electron-texture-bridge/commit/92756b18b606f914a28870ccd9f0e3ac04b2ed25))
* preserve Spout2 SDK directory structure for relative includes ([3283aa8](https://github.com/naporin0624/electron-texture-bridge/commit/3283aa8b390730fa2f6b76aba30422bc3e366ee4))
* remove optionalDependencies from source to fix CI lockfile mismatch ([bcab69d](https://github.com/naporin0624/electron-texture-bridge/commit/bcab69ddbb0537ea80fe515ef7178765c5ee565d))
* replace unused prepublish script with create-npm-dir ([8f6801f](https://github.com/naporin0624/electron-texture-bridge/commit/8f6801f306b37105c3dc8fc54e045155d4cc72da))
* use napi triples config and create-npm-dir for CI artifacts ([e39e8e2](https://github.com/naporin0624/electron-texture-bridge/commit/e39e8e23029c44df9cb42fcdec2e941cd69fd721))

## [0.3.5](https://github.com/naporin0624/electron-texture-bridge/compare/native-v0.3.4...native-v0.3.5) (2026-02-14)


### Bug Fixes

* include napi-rs loader files (index.js, index.d.ts) in publish ([8f6f697](https://github.com/naporin0624/electron-texture-bridge/commit/8f6f697))

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
