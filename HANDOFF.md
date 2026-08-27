# Handoff / context transfer

Living doc for whoever picks this project up next — what's actually true
about the codebase right now, what's been tried, what broke, and what's
still open. Update this alongside your PR, not after the fact; the goal is
that a new contributor can read this once and skip re-discovering
everything below the hard way.

Read [README.md](README.md) first for the architecture/status overview.
This doc is the "why is it built this way, and what's still on fire"
layer underneath that.

## Where things stand

- **Internet tier** (`web/src/lib/webrtc.ts`): verified working end-to-end
  on real hardware as of the initial commit. Live WebRTC/Opus call, Noise
  XX handshake over the signaling channel for fingerprint verification.
  Hasn't needed further fixes since.
- **BLE mesh tier** (`web/src/lib/ble.ts`, `ble-peripheral.ts`,
  `ptt.ts`, `codec.ts`): working end-to-end on real hardware (two Android
  phones, wireless ADB), but has had a string of real bugs found only by
  actually running it on physical devices — every one of the "known
  hardware limitations" in the README was discovered that way, not by
  reading the code. See [PR history below](#ble-mesh-tier-bug-history) —
  expect more of these. Simulators/emulators cannot substitute for real
  hardware here (see [Testing](#testing) below).

## Testing

**You need two physical Android phones.** Android emulators do not
support functional BLE (no working central *or* peripheral GATT role),
so there is no way to test the BLE mesh tier without real hardware — this
isn't a "nice to have," it's a hard blocker for verifying anything in
`ble.ts` / `ble-peripheral.ts` / the native
`SamvadBlePeripheralPlugin.kt`.

Workflow used so far (both phones on the same Wi-Fi, controlled via
wireless ADB from a dev machine with no physical access to the devices):

```bash
adb pair <ip>:<pairing-port> <pairing-code>   # from the device's Wireless debugging screen
adb mdns services                              # find the actual *connect* port — it is NOT the pairing port
adb connect <ip>:<connect-port>
```

Gotchas hit in practice:
- The pairing port and the connect port are different. `adb connect` on
  the pairing port fails with "Connection refused"; you have to run
  `adb mdns services` after pairing to find the real `_adb-tls-connect._tcp`
  port.
- Wireless ADB sessions drop when the phone sleeps/locks or leaves Wi-Fi —
  expect to re-pair periodically (pairing codes are single-use and expire
  in ~2 minutes, so grab a fresh one each time rather than reusing an old
  message).
- On ColorOS/OnePlus-Oppo devices, `adb install -r` frequently blocks on a
  native "App scan" confirmation dialog (`com.oplus.stdsp`) that doesn't
  show up as a normal install prompt — `adb shell input tap` on the
  on-screen "Continue installation" button works, but get its exact
  bounds via `adb shell uiautomator dump` first; eyeballing screenshot
  coordinates and forgetting to scale them to actual device pixels is an
  easy way to waste time tapping the wrong thing (screencap resolution and
  the coordinate space `input tap` expects are not always what a scaled
  screenshot preview implies — check `adb shell wm size`).
- Gradle 8.x will not run on very new JDKs (`Unsupported class file major
  version`). If system Java is too new, point `JAVA_HOME` at Android
  Studio's bundled JBR (`/Applications/Android Studio.app/Contents/jbr` on
  macOS) rather than installing another JDK.
- Reinstalling over a build signed with a different debug keystore fails
  with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` — `adb uninstall` first. This
  also wipes the app's Noise identity (stored in WebView `localStorage`),
  so both phones get new fingerprints after a fresh install.

**Codec/audio pipeline logic can be tested without any of the above.**
`web/codec-test.html` + `web/src/codec-test.ts` (added in PR #2) is a
standalone Vite-dev-server-only page that wires `PushToTalkRecorder`
straight into `PushToTalkPlayer` via a synthetic oscillator tone instead
of `getUserMedia` — useful for iterating on `ptt.ts`/`codec.ts` (frame
batching, bitrate, encode/decode correctness) from a desktop browser with
no phones and no microphone permission needed. It is **not** part of the
production build (`vite build` only bundles `index.html` — verified via
`dist/` contents). It cannot tell you anything about real BLE transport
behavior (write latency, connection interval, notification drops) —
that part still needs real hardware.

## BLE mesh tier bug history

Every one of these was found by actually running the app on two real
phones, not by code review — worth internalizing before assuming a
change is safe just because it compiles and typechecks.

**[PR #1](https://github.com/kodykebab/samvad/pull/1) — merged.**
1. `web/src/App.css` — the peer row was `display: flex` with no wrap; on
   one test device's aspect ratio the "Hold to talk" button rendered
   fully off-screen and was untappable. Fixed with `flex-wrap: wrap`.
2. `web/src/lib/ptt.ts` — releasing the talk button could call
   `codec.close()` while the recorder's pump loop was still mid-`encode()`,
   throwing `InvalidStateError: closed codec`. Fixed by deferring `close()`
   until the pump loop actually exits.
3. `web/src/lib/ptt.ts` + `codec.ts` — the encoder was hardcoded to 16kHz
   mono; real mic hardware delivered a different native format, so every
   frame was rejected with `EncodingError: incompatible with codec
   parameters`. Fixed by reading the actual `AudioData` chunk's format
   instead of assuming one, and propagating it over the wire so the
   receiver's decoder matches.

**[PR #2](https://github.com/kodykebab/samvad/pull/2) — open, NOT YET
MERGED, NOT YET RE-VERIFIED ON HARDWARE.** Filed to address a reported
"bad call quality" issue (bitrate was suspected; turned out not to be the
main cause):
4. `web/src/lib/ble.ts` — central writes used `BleClient.write()` (ATT
   write-with-response), which blocks until the peripheral ACKs at the
   GATT layer — a full round trip bounded by the connection interval
   (commonly 30-50ms). The recorder's pump loop awaits each send before
   reading the next mic chunk, so capture was throttled to ack speed
   instead of running in real time. This is the same mechanism behind a
   `Write timeout` → `[ble] stopped` failure seen in testing. Switched to
   `BleClient.writeWithoutResponse()` — the peripheral's RX characteristic
   already declared `PROPERTY_WRITE_NO_RESPONSE`, it just wasn't used.
5. `web/src/lib/ptt.ts` — raw mic chunks off `MediaStreamTrackProcessor`
   turned out to be 10ms on real hardware; Opus's practical frame size
   for voice is closer to 20ms. At the placeholder 6000bps bitrate, 10ms
   frames carried only ~7.5 bytes of payload — barely above Opus's own
   per-packet overhead. Now buffers raw chunks up to a ~20ms target
   before merging (`mergeAudioChunks`) and encoding.
   **This PR could not be re-verified end-to-end on physical hardware**
   before it was opened — wireless ADB connectivity to both test phones
   was lost mid-session. It's been typechecked, production-built, and
   exercised through the synthetic-source harness (confirms the batching
   math and that encode/decode don't throw), but the actual claim — that
   removing the write-response round trip measurably improves audio
   quality — has not been listened to on a real two-phone call yet.
   **Do that before merging, or if you're picking this up after it's
   already merged, be skeptical until someone has.**

## Known issues not yet fixed (from the same investigation)

Identified while diagnosing the quality issue above but out of scope for
PR #2 — still real, still worth doing:

- **`SamvadBlePeripheralPlugin.kt`'s `notify()`** (peripheral → central
  voice direction) calls `notifyCharacteristicChanged(...)` and resolves
  immediately, with no `onNotificationSent()` callback wired up. Android's
  BLE stack silently drops notifications sent faster than the radio can
  drain its internal queue, and there's currently zero visibility into
  that — no error, no retry, nothing in the log. Peripheral-side voice
  frames can be lost with no trace. Fix: hook `onNotificationSent()` and
  gate the next `notify()` call on it (or track in-flight state).
- **No connection-priority request.** The community BLE plugin already
  exposes `requestConnectionPriority()` (`Device.kt`), but nothing in
  `ble.ts` calls it after connecting. Requesting
  `CONNECTION_PRIORITY_HIGH` would shorten the connection interval
  (commonly ~30-50ms "balanced" default → ~11-15ms), reducing latency on
  both the central write path and the peripheral notify path regardless
  of write type.
- **Codec2 swap is still a TODO**, per `codec.ts`'s existing comment — the
  current placeholder (WebCodecs `AudioEncoder`/Opus) is a real working
  pipeline, not mocked, but at 5-10x the bitrate Codec2 would use.
  `libcodec2` cross-compiled to WASM (or a native Android wrapper) isn't
  wired up yet. Swapping it in is scoped to touch only `codec.ts`
  (implement the `VoiceCodec` interface, point `ptt.ts` at it).
- **BLE is single-hop.** Two directly-connected devices only — the
  flooding-relay behavior for a wider mesh described in the architecture
  doc is the natural next extension of the same `BlePeer` abstraction in
  `ble.ts`, not yet built.

## Contributing

No direct push access to `kodykebab/samvad` as of this writing — PRs #1
and #2 both went through a fork (`happypeepo/samvad`) via `gh repo fork
--remote --remote-name=fork`, then `git push fork <branch>` and `gh pr
create --repo kodykebab/samvad --base main --head <fork-owner>:<branch>`.
If you have push access, ignore this section.
