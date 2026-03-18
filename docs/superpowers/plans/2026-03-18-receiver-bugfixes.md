# Receiver API Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 bugs in the receiver API across Windows C++ bridge, Rust FFI, and TypeScript layers.

**Architecture:** Fixes span multiple files across 3 layers (C++ bridge, Rust wrapper, TypeScript). Windows receiver rewritten from `ReceiveImage(GL_RGBA)` to D3D11 staging texture readback using spoutDX's `ReceiveTexture(&pTexture)` double-pointer API. Consolidated discovery uses single spoutDX instance with C++ JSON escaping. `TextureReceiver.stop()` made functional. `SenderDiscovery` gets error handling. TypeScript discovery only emits on changes.

**Tech Stack:** C++/D3D11, Rust/napi-rs, TypeScript/EventEmitter

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/native/cpp/win/spout_bridge.cpp` | Modify | Fix 1+4: D3D11 staging readback; Fix 6: consolidated discovery with JSON escaping |
| `packages/native/src/win/ffi.rs` | Modify | Add `spout_discovery_list_senders` and `spout_discovery_free_string` FFI declarations |
| `packages/native/src/win/receiver.rs` | Modify | Fix 2+3+5+6: probe-first allocation, buffer retry, new discovery FFI |
| `packages/native/src/mac/receiver.rs` | Modify | Fix 5: probe-first allocation |
| `packages/native/src/lib.rs` | Modify | Add test for escaped JSON; implement `stop()` with `Option<Receiver>` |
| `packages/native/src/win/receiver.rs` | Modify | Add `destroy()` method to Receiver |
| `packages/native/src/mac/receiver.rs` | Modify | Add `destroy()` method to Receiver |
| `packages/renderer/src/discovery.ts` | Modify | Fix 7: gate `updated` event; Fix 9: error handling in `_refresh()` |
| `packages/renderer/src/__tests__/discovery.test.ts` | Modify | Fix 7+9: update test expectations |

---

### Task 1: Fix Windows receiver — D3D11 staging readback (Fix 1+4)

**Files:**
- Modify: `packages/native/cpp/win/spout_bridge.cpp:132-248`

- [ ] **Step 1: Rewrite `spout_receiver_receive_rgba` to use D3D11 staging texture**

Replace the `ReceiveTexture()` + `ReceiveImage(GL_RGBA)` double-call. The correct spoutDX pattern is:
1. Call `ReceiveTexture()` (no args) once to trigger connection/update and get dimensions
2. Call `ReceiveTexture(&pTexture)` (double-pointer) to get spoutDX's internal shared texture pointer
3. `CopyResource` from that texture to a staging texture
4. `Map`/`Unmap` the staging texture for CPU readback

No `renderTarget` field is needed — spoutDX manages the shared texture internally.

**Remove** the `renderTarget` field from `SpoutReceiverBridge` (it was unused dead code). The struct stays as:

```cpp
struct SpoutReceiverBridge {
    spoutDX receiver;
    ID3D11Device* device;
    ID3D11DeviceContext* context;
    ID3D11Texture2D* staging;
    unsigned int width;
    unsigned int height;
    bool connected;
    char senderName[256];
};
```

Update the existing `ensure_staging` helper to check texture desc instead of `bridge->width/height` (avoids stale dimension bugs):

```cpp
static bool ensure_staging(SpoutReceiverBridge* bridge, uint32_t w, uint32_t h) {
    if (bridge->staging) {
        D3D11_TEXTURE2D_DESC existing = {};
        bridge->staging->GetDesc(&existing);
        if (existing.Width == w && existing.Height == h) {
            return true;
        }
        bridge->staging->Release();
        bridge->staging = nullptr;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = w;
    desc.Height = h;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

    HRESULT hr = bridge->device->CreateTexture2D(&desc, nullptr, &bridge->staging);
    return SUCCEEDED(hr) && bridge->staging;
}
```

Rewrite `spout_receiver_receive_rgba`:

```cpp
int32_t spout_receiver_receive_rgba(void* handle,
                                     uint8_t* out_buffer, uint32_t buffer_size,
                                     uint32_t* out_width, uint32_t* out_height) {
    if (!handle || !out_buffer || !out_width || !out_height) return -1;

    SpoutReceiverBridge* bridge = static_cast<SpoutReceiverBridge*>(handle);

    // Single ReceiveTexture() call to update connection state and dimensions.
    // Do NOT call ReceiveTexture() twice — it has frame-consume semantics.
    if (!bridge->receiver.ReceiveTexture()) {
        return -1;
    }

    unsigned int w = bridge->receiver.GetSenderWidth();
    unsigned int h = bridge->receiver.GetSenderHeight();
    if (w == 0 || h == 0) return -1;

    bridge->connected = true;
    bridge->width = w;
    bridge->height = h;

    // Must set out dimensions BEFORE the buffer size check —
    // caller uses these to allocate the correct buffer on retry.
    *out_width = w;
    *out_height = h;

    uint32_t requiredSize = w * h * 4;
    if (buffer_size < requiredSize) {
        return -1;
    }

    // Ensure staging texture matches current dimensions
    if (!ensure_staging(bridge, w, h)) {
        return -1;
    }

    // Get spoutDX's internal shared texture via double-pointer API.
    // ReceiveTexture(&pTexture) provides access to the already-received frame.
    ID3D11Texture2D* sharedTexture = nullptr;
    if (!bridge->receiver.ReceiveTexture(&sharedTexture) || !sharedTexture) {
        return -1;
    }

    // Copy shared texture to staging texture (GPU → GPU)
    bridge->context->CopyResource(bridge->staging, sharedTexture);

    // Map staging texture for CPU read (GPU → CPU readback)
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = bridge->context->Map(bridge->staging, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        return -1;
    }

    // Copy row by row (mapped pitch may differ from w*4)
    const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
    uint32_t dstPitch = w * 4;
    for (unsigned int y = 0; y < h; y++) {
        memcpy(out_buffer + y * dstPitch, src + y * mapped.RowPitch, dstPitch);
    }

    bridge->context->Unmap(bridge->staging, 0);
    return 0;
}
```

**Important note on `ReceiveTexture` overloads:** spoutDX has two overloads:
- `ReceiveTexture()` — no-args, updates connection state and dimensions
- `ReceiveTexture(ID3D11Texture2D**)` — double-pointer, provides access to spoutDX's internal shared texture

We call the no-args version first for connection/dimension updates, then the double-pointer version to get the texture pointer. The double-pointer version does NOT advance the frame counter — it just provides access to the current frame's texture.

- [ ] **Step 2: Commit**

```bash
git add packages/native/cpp/win/spout_bridge.cpp
git commit -m "fix(native): replace ReceiveImage(GL_RGBA) with D3D11 staging readback

Removes ReceiveImage(GL_RGBA) and the double-receive pattern.
Uses ReceiveTexture() for connection + ReceiveTexture(&pTexture) for
the shared texture pointer, then CopyResource + Map/Unmap for proper
D3D11 CPU readback. Format is BGRA matching sender's
DXGI_FORMAT_B8G8R8A8_UNORM. Returns dimensions on buffer-too-small
(matching macOS contract). ensure_staging now checks texture desc
instead of cached bridge dimensions."
```

---

### Task 2: Fix Windows Rust receiver — probe-first + retry + new discovery FFI (Fix 2+3+5+6)

**Files:**
- Modify: `packages/native/cpp/win/spout_bridge.cpp:268-295` (add consolidated discovery)
- Modify: `packages/native/src/win/ffi.rs`
- Modify: `packages/native/src/win/receiver.rs`
- Modify: `packages/native/src/lib.rs` (test)

- [ ] **Step 1: Add test for JSON special character parsing**

Add to `packages/native/src/lib.rs` tests section:

```rust
#[test]
fn parse_senders_json_with_special_characters_in_name() {
    let json = r#"[{"name":"My \"VJ\" App"}]"#;
    let result = parse_senders_json(json).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].name, r#"My "VJ" App"#);
}
```

- [ ] **Step 2: Run test to verify it passes** (tests the parser, not the producer)

Run: `cargo test --manifest-path packages/native/Cargo.toml parse_senders_json_with_special`
Expected: PASS (serde_json handles escaped JSON)

- [ ] **Step 3: Add consolidated `spout_discovery_list_senders` C++ function**

Add `#include <string>` and `#include <cstdio>` at the top of `spout_bridge.cpp` if not already present.

Add to `spout_bridge.cpp` after the existing discovery functions, inside `extern "C"`:

```cpp
// Consolidated discovery: single spoutDX instance for all queries.
// Returns a JSON string: [{"name":"..."},{"name":"..."}]
// Caller must free the returned string with spout_discovery_free_string().
char* spout_discovery_list_senders(void) {
    spoutDX spout;
    int count = spout.GetSenderCount();

    std::string json = "[";
    bool first = true;
    for (int i = 0; i < count; i++) {
        char name[256];
        memset(name, 0, sizeof(name));
        if (!spout.GetSenderName(i, name)) continue;

        if (!first) json += ",";
        first = false;
        json += "{\"name\":\"";
        // Escape JSON special characters (including all control chars per JSON spec)
        for (const char* p = name; *p; p++) {
            unsigned char c = static_cast<unsigned char>(*p);
            if (c == '"') {
                json += "\\\"";
            } else if (c == '\\') {
                json += "\\\\";
            } else if (c == '\n') {
                json += "\\n";
            } else if (c == '\r') {
                json += "\\r";
            } else if (c == '\t') {
                json += "\\t";
            } else if (c < 0x20) {
                // All other control characters must be \uXXXX escaped per JSON spec
                char buf[8];
                snprintf(buf, sizeof(buf), "\\u%04x", c);
                json += buf;
            } else {
                json += *p;
            }
        }
        json += "\"}";
    }
    json += "]";

    return _strdup(json.c_str());
}

void spout_discovery_free_string(char* str) {
    if (str) free(str);
}
```

- [ ] **Step 4: Add FFI declarations in Rust**

Add to `packages/native/src/win/ffi.rs` inside the `extern "C"` block:

```rust
    // ---- Consolidated Discovery ----
    pub fn spout_discovery_list_senders() -> *mut c_char;
    pub fn spout_discovery_free_string(str: *mut c_char);
```

- [ ] **Step 5: Rewrite `packages/native/src/win/receiver.rs` completely**

Replace the entire file. Key changes:
- `receive_rgba`: probe-first (no 64MB allocation) + retry on buffer-too-small
- `list_senders_json`: use new consolidated FFI with safe free (always free even on UTF-8 error)
- Probe dead branch simplified (no incoherent `ret==0` with `width=0`)

```rust
use super::ffi;
use std::ffi::CString;

pub struct Receiver {
    handle: ffi::SpoutReceiverHandle,
}

unsafe impl Send for Receiver {}

impl Receiver {
    pub fn new(sender_name: &str) -> Result<Self, String> {
        let c_name = CString::new(sender_name).map_err(|e| e.to_string())?;
        let handle = unsafe { ffi::spout_receiver_create(c_name.as_ptr()) };
        if handle.is_null() {
            return Err("Failed to create Spout receiver".into());
        }
        Ok(Self { handle })
    }

    pub fn has_new_frame(&self) -> bool {
        unsafe { ffi::spout_receiver_has_new_frame(self.handle) != 0 }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let mut width: u32 = 0;
        let mut height: u32 = 0;

        let estimated_size = self.width() as usize * self.height() as usize * 4;

        if estimated_size == 0 {
            // First call: probe for dimensions with a minimal buffer.
            // The C API sets out_width/out_height even on buffer-too-small (-1).
            let mut probe = vec![0u8; 4];
            unsafe {
                ffi::spout_receiver_receive_rgba(
                    self.handle,
                    probe.as_mut_ptr(),
                    4,
                    &mut width,
                    &mut height,
                );
            }
            if width == 0 || height == 0 {
                // No sender connected yet
                return Ok(None);
            }
            // Fall through to retry with correct size
        } else {
            // Have cached dimensions — allocate exact size
            let mut buffer: Vec<u8> = vec![0u8; estimated_size];
            let ret = unsafe {
                ffi::spout_receiver_receive_rgba(
                    self.handle,
                    buffer.as_mut_ptr(),
                    estimated_size as u32,
                    &mut width,
                    &mut height,
                )
            };

            if ret == 0 {
                let actual_size = (width as usize) * (height as usize) * 4;
                buffer.truncate(actual_size);
                return Ok(Some((buffer, width, height)));
            }

            // Dimensions changed — width/height updated by C API
            if width == 0 || height == 0 {
                return Ok(None);
            }
            // Fall through to retry with new dimensions
        }

        // Allocate with actual dimensions and retry
        let correct_size = (width as usize) * (height as usize) * 4;
        let mut buffer = vec![0u8; correct_size];
        let ret = unsafe {
            ffi::spout_receiver_receive_rgba(
                self.handle,
                buffer.as_mut_ptr(),
                correct_size as u32,
                &mut width,
                &mut height,
            )
        };
        if ret != 0 {
            return Ok(None);
        }
        let actual_size = (width as usize) * (height as usize) * 4;
        buffer.truncate(actual_size);
        Ok(Some((buffer, width, height)))
    }

    pub fn is_connected(&self) -> bool {
        unsafe { ffi::spout_receiver_is_connected(self.handle) != 0 }
    }

    pub fn width(&self) -> u32 {
        unsafe { ffi::spout_receiver_get_width(self.handle) }
    }

    pub fn height(&self) -> u32 {
        unsafe { ffi::spout_receiver_get_height(self.handle) }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        unsafe {
            ffi::spout_receiver_destroy(self.handle);
        }
    }
}

/// List available Spout senders.
pub fn list_senders_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::spout_discovery_list_senders();
        if ptr.is_null() {
            return Err("Failed to list Spout senders".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::spout_discovery_free_string(ptr);
        result
    }
}
```

- [ ] **Step 6: Run tests**

Run: `cargo test --manifest-path packages/native/Cargo.toml`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/native/cpp/win/spout_bridge.cpp packages/native/src/win/ffi.rs packages/native/src/win/receiver.rs packages/native/src/lib.rs
git commit -m "fix(native): fix Windows receiver JSON escaping, buffer retry, and discovery

- Consolidated discovery into single spoutDX instance with C++ JSON escaping
  (including all control chars 0x00-0x1F per JSON spec)
- Probe-first allocation replaces 64MB speculative allocation
- Buffer-too-small retry matches macOS pattern
- list_senders_json always frees C string even on UTF-8 error
- Mirrors macOS discovery pattern (list_senders + free_string FFI)"
```

---

### Task 3: Fix macOS receiver — probe-first allocation + safe free (Fix 5)

**Files:**
- Modify: `packages/native/src/mac/receiver.rs:45-127`

- [ ] **Step 1: Replace 64MB fallback with probe-first approach and fix list_servers_json leak**

Replace `receive_rgba` in `packages/native/src/mac/receiver.rs`:

```rust
pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
    let mut width: u32 = 0;
    let mut height: u32 = 0;

    let estimated_size = self.width() as usize * self.height() as usize * 4;

    if estimated_size == 0 {
        // First call: probe for dimensions with a minimal buffer.
        // The C API sets out_width/out_height even on buffer-too-small (-1).
        let mut probe = vec![0u8; 4];
        unsafe {
            ffi::syphon_receiver_receive_rgba(
                self.handle,
                probe.as_mut_ptr(),
                4,
                &mut width,
                &mut height,
            );
        }
        if width == 0 || height == 0 {
            // No server connected yet
            return Ok(None);
        }
        // Fall through to allocate correct size below
    } else {
        // Have cached dimensions — allocate exact size
        let mut buffer: Vec<u8> = vec![0u8; estimated_size];
        let ret = unsafe {
            ffi::syphon_receiver_receive_rgba(
                self.handle,
                buffer.as_mut_ptr(),
                estimated_size as u32,
                &mut width,
                &mut height,
            )
        };

        if ret == 0 {
            let actual_size = (width as usize) * (height as usize) * 4;
            buffer.truncate(actual_size);
            return Ok(Some((buffer, width, height)));
        }

        // Dimensions changed — width/height updated by C API
        if width == 0 || height == 0 {
            return Ok(None);
        }
        // Fall through to retry with new dimensions
    }

    // Allocate with actual dimensions and retry
    let correct_size = (width as usize) * (height as usize) * 4;
    let mut buffer = vec![0u8; correct_size];
    let ret = unsafe {
        ffi::syphon_receiver_receive_rgba(
            self.handle,
            buffer.as_mut_ptr(),
            correct_size as u32,
            &mut width,
            &mut height,
        )
    };
    if ret != 0 {
        return Ok(None);
    }
    let actual_size = (width as usize) * (height as usize) * 4;
    buffer.truncate(actual_size);
    Ok(Some((buffer, width, height)))
}
```

Also fix `list_servers_json` to always free the C string (same leak bug as Windows):

```rust
/// List available Syphon servers as a JSON string.
pub fn list_servers_json() -> Result<String, String> {
    unsafe {
        let ptr = ffi::syphon_discovery_list_servers();
        if ptr.is_null() {
            return Err("Failed to list Syphon servers".into());
        }
        // Always free the C string, even if UTF-8 conversion fails
        let result = std::ffi::CStr::from_ptr(ptr)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string());
        ffi::syphon_discovery_free_string(ptr);
        result
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/native/src/mac/receiver.rs
git commit -m "fix(native): replace 64MB speculative allocation with probe-first on macOS

On first receive_rgba call (when dimensions are unknown), use a minimal
4-byte buffer to probe for dimensions, then allocate the exact size needed.
Also fixes memory leak in list_servers_json where the C string was not
freed on UTF-8 conversion error."
```

---

### Task 4: Fix `updated` event unconditional emission (Fix 7)

**Files:**
- Modify: `packages/renderer/src/discovery.ts:43-66`
- Modify: `packages/renderer/src/__tests__/discovery.test.ts:28-35,87-97`

- [ ] **Step 1: Replace the `"emits 'updated' event when started"` test and update `dispose()` test**

In `packages/renderer/src/__tests__/discovery.test.ts`:

**Replace** the existing `"emits 'updated' event when started"` test (lines 28–35) with:

```typescript
it("does not emit 'updated' when sender list is unchanged", () => {
  const handler = vi.fn();
  discovery.on("updated", handler);
  discovery.start(100);

  // First poll: empty → empty, no change
  vi.advanceTimersByTime(100);
  expect(handler).toHaveBeenCalledTimes(0);

  // Second poll: still empty, still no change
  vi.advanceTimersByTime(100);
  expect(handler).toHaveBeenCalledTimes(0);

  // Third poll: sender appears — this IS a change
  mockListSenders.mockReturnValue([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
  vi.advanceTimersByTime(100);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith([{ name: "VJ", appName: "Resolume", uuid: "abc" }]);
});
```

**Replace** the existing `"dispose() cleans up and removes listeners"` test (lines 87–97) with:

```typescript
it("dispose() cleans up and removes listeners", () => {
  const addedHandler = vi.fn();
  discovery.on("added", addedHandler);
  discovery.start(100);

  // First tick with a sender
  mockListSenders.mockReturnValue([{ name: "VJ" }]);
  vi.advanceTimersByTime(100);
  expect(addedHandler).toHaveBeenCalledTimes(1);

  discovery.dispose();
  mockListSenders.mockReturnValue([{ name: "VJ" }, { name: "VJ2" }]);
  vi.advanceTimersByTime(300);
  // Should have been called only once (before dispose)
  expect(addedHandler).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/renderer && pnpm vitest run src/__tests__/discovery.test.ts`
Expected: FAIL (currently `updated` fires every tick)

- [ ] **Step 3: Gate `updated` emission on actual changes**

In `packages/renderer/src/discovery.ts`, change line 65 from:

```typescript
this.emit("updated", current);
```

to:

```typescript
if (added.length > 0 || removed.length > 0) {
  this.emit("updated", current);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/renderer && pnpm vitest run src/__tests__/discovery.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/discovery.ts packages/renderer/src/__tests__/discovery.test.ts
git commit -m "fix(renderer): only emit 'updated' when sender list actually changes

Previously emitted on every poll tick regardless of changes, causing
unnecessary work in consumers. Now gated on added.length > 0 || removed.length > 0."
```

---

### Task 5: Make `TextureReceiver.stop()` actually release native resources (Fix 8)

**Files:**
- Modify: `packages/native/src/mac/receiver.rs` (add `destroy()` method)
- Modify: `packages/native/src/win/receiver.rs` (add `destroy()` method)
- Modify: `packages/native/src/lib.rs:238-331` (use `Option<Receiver>` for eager cleanup)

**Problem:** `TextureReceiver.stop()` is a no-op. `TextureReceiverBridge.dispose()` calls `this.receiver.stop()` as its only native teardown, so the Syphon/Spout connection stays alive until JS GC runs `Drop`. This leaks native resources and makes the documented cleanup path misleading.

**Approach:** Wrap `inner` in `Option<Receiver>`, and have `stop()` take the receiver out with `.take()`, which drops it immediately and calls the FFI destroy function. Subsequent calls to `has_new_frame`, `receive_frame`, etc. return safe defaults when `inner` is `None`.

- [ ] **Step 1: Add `destroy()` to both platform Receivers**

In `packages/native/src/mac/receiver.rs`, change `handle` to `Option` and add `destroy()`:

```rust
pub struct Receiver {
    handle: Option<ffi::SyphonReceiverHandle>,
}
```

Update all methods to use `self.handle?` or check for `None`:

```rust
impl Receiver {
    // ... new() sets handle: Some(handle) ...

    pub fn destroy(&mut self) {
        if let Some(h) = self.handle.take() {
            unsafe { ffi::syphon_receiver_destroy(h); }
        }
    }

    pub fn has_new_frame(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_has_new_frame(h) != 0 },
            None => false,
        }
    }

    pub fn receive_rgba(&self) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
        let handle = match self.handle {
            Some(h) => h,
            None => return Ok(None),
        };
        // ... rest uses `handle` instead of `self.handle` ...
    }

    pub fn is_valid(&self) -> bool {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_is_valid(h) != 0 },
            None => false,
        }
    }

    pub fn width(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_width(h) },
            None => 0,
        }
    }

    pub fn height(&self) -> u32 {
        match self.handle {
            Some(h) => unsafe { ffi::syphon_receiver_get_height(h) },
            None => 0,
        }
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.destroy();
    }
}
```

Apply the same pattern to `packages/native/src/win/receiver.rs` (using `spout_receiver_destroy`, `spout_receiver_has_new_frame`, etc.).

- [ ] **Step 2: Make `TextureReceiver.stop()` call `destroy()`**

In `packages/native/src/lib.rs`, change `TextureReceiver` to use `Option`:

```rust
#[napi]
pub struct TextureReceiver {
    #[cfg(target_os = "macos")]
    inner: Option<mac::receiver::Receiver>,
    #[cfg(target_os = "windows")]
    inner: Option<win::receiver::Receiver>,
}
```

Update the constructor to wrap in `Some(inner)`.

Update all methods to delegate to the inner receiver or return safe defaults:

```rust
#[napi]
impl TextureReceiver {
    #[napi(constructor)]
    pub fn new(sender_name: String, app_name: Option<String>, server_uuid: Option<String>) -> Result<Self> {
        // ... existing creation logic ...
        Ok(Self { inner: Some(inner) })
    }

    #[napi]
    pub fn has_new_frame(&self) -> bool {
        self.inner.as_ref().map_or(false, |r| r.has_new_frame())
    }

    #[napi]
    pub fn receive_frame(&self) -> Result<Option<ReceivedFrame>> {
        let inner = match &self.inner {
            Some(r) => r,
            None => return Ok(None),
        };
        match inner.receive_rgba() {
            Ok(Some((data, width, height))) => Ok(Some(ReceivedFrame {
                data: data.into(),
                width,
                height,
            })),
            Ok(None) => Ok(None),
            Err(e) => Err(Error::from_reason(e)),
        }
    }

    #[napi]
    pub fn is_connected(&self) -> bool {
        match &self.inner {
            Some(r) => {
                #[cfg(target_os = "macos")]
                return r.is_valid();
                #[cfg(target_os = "windows")]
                return r.is_connected();
            }
            None => false,
        }
    }

    #[napi]
    pub fn get_width(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.width())
    }

    #[napi]
    pub fn get_height(&self) -> u32 {
        self.inner.as_ref().map_or(0, |r| r.height())
    }

    /// Stop the receiver and release native resources immediately.
    /// After calling this, has_new_frame() returns false and receive_frame() returns null.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut r) = self.inner.take() {
            r.destroy();
        }
        Ok(())
    }

    #[napi]
    pub fn platform(&self) -> String {
        #[cfg(target_os = "windows")]
        return "spout".to_string();
        #[cfg(target_os = "macos")]
        return "syphon-metal".to_string();
    }
}
```

Note: `stop()` changes from `&self` to `&mut self`. napi-rs handles `&mut self` correctly for `#[napi]` methods.

- [ ] **Step 3: Run tests**

Run: `cargo test --manifest-path packages/native/Cargo.toml`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/native/src/lib.rs packages/native/src/mac/receiver.rs packages/native/src/win/receiver.rs
git commit -m "fix(native): make TextureReceiver.stop() actually release native resources

stop() now takes the inner Receiver via Option::take(), triggering
immediate native cleanup (syphon_receiver_destroy / spout_receiver_destroy).
After stop(), all methods return safe defaults (false/null/0).
Previously stop() was a no-op, leaking resources until JS GC ran Drop."
```

---

### Task 6: Add error handling to `SenderDiscovery._refresh()` (Fix 9)

**Files:**
- Modify: `packages/renderer/src/discovery.ts:43-66`
- Modify: `packages/renderer/src/__tests__/discovery.test.ts`

**Problem:** `SenderDiscovery._refresh()` calls `listSenders()` in a timer callback without try/catch. If the native layer throws (e.g., from the Windows JSON bug, or transient GPU error), the exception escapes the interval callback as an uncaught exception, crashing the process.

- [ ] **Step 1: Write failing test for error in `_refresh`**

Add to `packages/renderer/src/__tests__/discovery.test.ts`:

```typescript
it("emits 'error' when listSenders throws", () => {
  const errorHandler = vi.fn();
  discovery.on("error", errorHandler);
  discovery.start(100);

  // listSenders throws on next poll
  mockListSenders.mockImplementation(() => {
    throw new Error("Native error");
  });
  vi.advanceTimersByTime(100);

  expect(errorHandler).toHaveBeenCalledTimes(1);
  expect(errorHandler.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(errorHandler.mock.calls[0][0].message).toBe("Native error");
});

it("continues polling after error in listSenders", () => {
  const errorHandler = vi.fn();
  const updatedHandler = vi.fn();
  discovery.on("error", errorHandler);
  discovery.on("updated", updatedHandler);
  discovery.start(100);

  // First tick: throws
  mockListSenders.mockImplementation(() => {
    throw new Error("Transient error");
  });
  vi.advanceTimersByTime(100);
  expect(errorHandler).toHaveBeenCalledTimes(1);

  // Second tick: recovers
  mockListSenders.mockReturnValue([{ name: "VJ" }]);
  vi.advanceTimersByTime(100);
  expect(updatedHandler).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/renderer && pnpm vitest run src/__tests__/discovery.test.ts`
Expected: FAIL (currently throws uncaught in timer)

- [ ] **Step 3: Add try/catch to `_refresh()` and add `error` to events interface**

In `packages/renderer/src/discovery.ts`:

Update the events interface:

```typescript
export interface SenderDiscoveryEvents {
  updated: [senders: SenderInfo[]];
  added: [senders: SenderInfo[]];
  removed: [senders: SenderInfo[]];
  error: [error: Error];
}
```

Wrap `_refresh` body in try/catch:

```typescript
private _refresh(): void {
  if (this._disposed) return;

  try {
    const current = listSenders();
    const prev = this._senders;

    const added = current.filter((c) => !prev.some((p) => this._isSame(c, p)));
    const removed = prev.filter((p) => !current.some((c) => this._isSame(c, p)));

    this._senders = current;

    if (added.length > 0) {
      this.emit("added", added);
    }

    if (removed.length > 0) {
      this.emit("removed", removed);
    }

    if (added.length > 0 || removed.length > 0) {
      this.emit("updated", current);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.emit("error", error);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/renderer && pnpm vitest run src/__tests__/discovery.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/renderer/src/discovery.ts packages/renderer/src/__tests__/discovery.test.ts
git commit -m "fix(renderer): add error handling to SenderDiscovery polling

Wraps _refresh() in try/catch and emits 'error' event instead of letting
exceptions escape the interval callback as uncaught exceptions. Polling
continues after errors so transient failures don't kill the process."
```
