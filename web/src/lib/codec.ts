// Voice codec abstraction for the bandwidth-starved tiers (BLE today, RF
// later). The internet tier doesn't use this at all — WebRTC negotiates
// Opus itself.
//
// TODO(codec2): this is a placeholder, not Codec2. The architecture doc
// calls Codec2 "the single most load-bearing codec decision in the
// project" (700-1200 bps over BLE/RF) and that's still the target — it
// needs libcodec2 cross-compiled to WASM (via emscripten, not installed in
// this environment yet) or wrapped as a native Android codec. Swapping it
// in only touches this file: implement VoiceCodec and point ble.ts at it.
//
// Until then, this uses the browser's built-in WebCodecs AudioEncoder
// with Opus pinned to its lowest usable bitrate. It's still ~5-10x the
// bitrate Codec2 would use, so it's a real, working, on-device codec
// pipeline (not mocked data) — just not the final bitrate budget.
export interface EncodedFrame {
  data: Uint8Array
  timestampUs: number
}

export interface VoiceCodec {
  encode(chunk: AudioData): Promise<EncodedFrame[]>
  decode(frame: EncodedFrame): Promise<AudioData[]>
  close(): void
}

const SAMPLE_RATE = 16000 // voice-grade; matches Codec2's typical operating rate
// bps. Was 6000 ("Opus's practical floor") until confirmed on real hardware
// that this was the actual cause of garbled, unintelligible audio — at
// 6000bps over the ~10ms chunks MediaStreamTrackProcessor hands back, each
// encoded frame carried a mere 7.5 bytes of payload (6000 * 0.010 / 8),
// nowhere near enough for Opus to encode anything recognizable as speech.
// 32000 keeps this comfortably above BLE's bandwidth ceiling while actually
// being audible — still well short of Codec2's eventual 700-1200bps target,
// which needs the real codec swap (see TODO above), not a bitrate knob.
const PLACEHOLDER_BITRATE = 32000

export interface CodecFormat {
  sampleRate: number
  numberOfChannels: number
  // Duration, in microseconds, of the AudioData chunks that will actually be
  // fed to encode(). Opus's AudioEncoder rejects a chunk whose duration
  // doesn't match its configured frame size ("incompatible with codec
  // parameters") — this must reflect what MediaStreamTrackProcessor is
  // really handing back (observed as 480 samples/10ms @ 48kHz on real
  // hardware), not the 20ms textbook default for voice codecs. Only matters
  // for encode(); decode-only callers (PushToTalkPlayer) can omit it.
  frameDurationUs?: number
}

export type CodecMode = 'encode' | 'decode'

export class PlaceholderLowBitrateCodec implements VoiceCodec {
  private encoder: AudioEncoder | null = null
  private decoder: AudioDecoder | null = null
  private pendingEncoded: EncodedFrame[] = []
  private pendingDecoded: AudioData[] = []

  // Takes the actual capture/playback format rather than assuming SAMPLE_RATE
  // everywhere: getUserMedia's sampleRate/channelCount constraints are hints,
  // not guarantees, and mic hardware that can't produce 16kHz mono hands back
  // its native format instead — configuring Opus for anything else then
  // makes encode() reject every frame with "incompatible with codec
  // parameters".
  //
  // `mode` matters: PushToTalkRecorder only ever calls encode(), and
  // PushToTalkPlayer only ever calls decode() — but this constructor used to
  // build *both* an AudioEncoder and an AudioDecoder unconditionally,
  // wasting one unused codec instance every single time. Confirmed on real
  // hardware that this caused voice to stop working after a handful of
  // "Hold to talk" presses (each one makes a brand new PushToTalkRecorder,
  // hence a brand new codec pair): Android's underlying MediaCodec pool is
  // finite and system-wide, and closing a codec doesn't always free its slot
  // instantly, so accumulated unused instances eventually exhaust it —
  // silently, since AudioEncoder/AudioDecoder construction failures only
  // surface through their async `error` callback (console-only, never
  // reaches the app's own log panel), not a thrown exception. Building only
  // the codec direction actually needed halves the leak.
  constructor(format: CodecFormat, mode: CodecMode) {
    if (mode === 'encode') {
      this.encoder = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          this.pendingEncoded.push({ data, timestampUs: chunk.timestamp })
        },
        error: (e) => console.error('[codec] encoder error', e),
      })
      this.encoder.configure({
        codec: 'opus',
        sampleRate: format.sampleRate,
        numberOfChannels: format.numberOfChannels,
        bitrate: PLACEHOLDER_BITRATE,
        opus: { frameDuration: format.frameDurationUs ?? 20000 },
      })
      return
    }

    this.decoder = new AudioDecoder({
      output: (audioData) => this.pendingDecoded.push(audioData),
      error: (e) => console.error('[codec] decoder error', e),
    })
    this.decoder.configure({
      codec: 'opus',
      sampleRate: format.sampleRate,
      numberOfChannels: format.numberOfChannels,
    })
  }

  async encode(chunk: AudioData): Promise<EncodedFrame[]> {
    if (!this.encoder) throw new Error('codec was constructed in decode mode, not encode')
    this.encoder.encode(chunk)
    chunk.close()
    await this.encoder.flush()
    const out = this.pendingEncoded
    this.pendingEncoded = []
    return out
  }

  async decode(frame: EncodedFrame): Promise<AudioData[]> {
    if (!this.decoder) throw new Error('codec was constructed in encode mode, not decode')
    this.decoder.decode(
      new EncodedAudioChunk({
        type: 'key', // Opus frames are independently decodable
        timestamp: frame.timestampUs,
        data: frame.data,
      }),
    )
    await this.decoder.flush()
    const out = this.pendingDecoded
    this.pendingDecoded = []
    return out
  }

  close() {
    this.encoder?.close()
    this.decoder?.close()
  }
}

export const SAMVAD_CODEC_SAMPLE_RATE = SAMPLE_RATE
