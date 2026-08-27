// Push-to-talk glue: mic -> codec -> wire, and wire -> codec -> speakers.
// This is the interaction model the architecture doc settled on for the BLE
// tier (Section 6.4) instead of live duplex calling — flooding-hop mesh
// links can't hide jitter the way a direct WebRTC path can, so BLE carries
// short recorded voice notes instead of a continuous stream.
import { PlaceholderLowBitrateCodec, SAMVAD_CODEC_SAMPLE_RATE, type CodecFormat, type EncodedFrame } from './codec'

// Wire format for one encoded voice frame: [4 byte LE timestamp][4 byte LE
// sampleRate][1 byte channels][opus data]. Format travels with every frame
// (instead of being assumed) because the sender's actual capture format
// depends on what its mic hardware will give up — see PushToTalkRecorder.start.
function packFrame(frame: EncodedFrame, format: { sampleRate: number; numberOfChannels: number }): Uint8Array {
  const out = new Uint8Array(9 + frame.data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, frame.timestampUs >>> 0, true)
  view.setUint32(4, format.sampleRate >>> 0, true)
  view.setUint8(8, format.numberOfChannels)
  out.set(frame.data, 9)
  return out
}

function unpackFrame(bytes: Uint8Array): EncodedFrame & { sampleRate: number; numberOfChannels: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const timestampUs = view.getUint32(0, true)
  const sampleRate = view.getUint32(4, true)
  const numberOfChannels = view.getUint8(8)
  return { timestampUs, sampleRate, numberOfChannels, data: bytes.slice(9) }
}

// One of Opus's own allowed frame durations (2.5/5/10/20/40/60ms) — not
// picked arbitrarily. Raw chunks off MediaStreamTrackProcessor arrived as
// 10ms on every real device tested, which is technically valid for Opus but
// a poor fit for voice: at a bitrate low enough to matter on BLE, Opus's
// LPC-based voice mode needs a wider analysis window than 10ms to encode
// anything intelligible, the same way SAMPLE_RATE/PLACEHOLDER_BITRATE were
// already a compromise. 60ms means ~6 raw chunks batched into one encode()
// call, trading a bit of push-to-talk latency (acceptable — this is
// recorded voice notes, not a live duplex stream, see the module comment
// above) for a usable amount of data per Opus frame.
const TARGET_FRAME_DURATION_US = 60_000

/**
 * Concatenates multiple same-format AudioData chunks into one. Safe because
 * capture is always requested as mono (channelCount: 1, honored on every
 * device tested so far even when the sampleRate hint wasn't) — a single
 * plane's worth of bytes per chunk, so this never has to reason about
 * per-channel interleaving the way a stereo merge would.
 */
function mergeAudioChunks(chunks: AudioData[]): AudioData {
  const first = chunks[0]
  const byteLengths = chunks.map((c) => c.allocationSize({ planeIndex: 0 }))
  const combined = new Uint8Array(byteLengths.reduce((a, b) => a + b, 0))
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].copyTo(combined.subarray(offset, offset + byteLengths[i]), { planeIndex: 0 })
    offset += byteLengths[i]
  }
  const merged = new AudioData({
    format: first.format!,
    sampleRate: first.sampleRate,
    numberOfChannels: first.numberOfChannels,
    numberOfFrames: chunks.reduce((sum, c) => sum + c.numberOfFrames, 0),
    timestamp: first.timestamp,
    data: combined,
  })
  for (const c of chunks) c.close()
  return merged
}

export class PushToTalkRecorder {
  private codec: PlaceholderLowBitrateCodec | null = null
  private format: CodecFormat | null = null
  private track: MediaStreamTrack | null = null
  private reader: ReadableStreamDefaultReader<AudioData> | null = null
  private recording = false
  private send: (bytes: Uint8Array) => Promise<void>
  private onError?: (err: unknown) => void
  private pumpDone: Promise<void> = Promise.resolve()
  // How many raw chunks to merge per encode() call — computed from the
  // first chunk's actual duration once we see it (see pump()), so the
  // encoder is always configured for and fed exactly this many merged
  // frames' worth of duration, never a mismatched leftover.
  private chunksPerBatch = 0
  private batchBuffer: AudioData[] = []

  constructor(send: (bytes: Uint8Array) => Promise<void>, onError?: (err: unknown) => void) {
    this.send = send
    this.onError = onError
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMVAD_CODEC_SAMPLE_RATE, echoCancellation: true },
    })
    this.track = stream.getAudioTracks()[0]
    // Insertable-streams bridge from a live MediaStreamTrack to WebCodecs AudioData.
    const processor = new MediaStreamTrackProcessor({ track: this.track })
    this.reader = processor.readable.getReader()
    this.recording = true
    // Fire-and-forget by design (start() shouldn't block on the whole
    // recording session) — but that means an error thrown mid-stream had
    // nowhere to go. Route it out explicitly instead of losing it. Also
    // tracked so stop() can wait for any in-flight encode() before closing
    // the codec out from under it.
    this.pumpDone = this.pump().catch((err) => this.onError?.(err))
  }

  private async pump() {
    while (this.recording && this.reader) {
      const { value, done } = await this.reader.read()
      if (done || !value) break
      if (this.chunksPerBatch === 0) {
        // channelCount/sampleRate on getUserMedia are only hints, and even
        // the negotiated MediaStreamTrack settings don't guarantee the exact
        // chunk shape WebCodecs will deliver — real hardware handed back
        // 48kHz mono in 480-sample (10ms) chunks here, not the 20ms+ frame
        // Opus voice presets assume. Derive how many of these raw chunks
        // merge into one TARGET_FRAME_DURATION_US batch from what actually
        // showed up, instead of assuming a fixed count — and configure the
        // encoder for that merged duration (not the raw per-chunk one), since
        // every encode() call from here on feeds it a merged batch.
        const rawChunkDurationUs = Math.round((value.numberOfFrames / value.sampleRate) * 1_000_000)
        this.chunksPerBatch = Math.max(1, Math.round(TARGET_FRAME_DURATION_US / rawChunkDurationUs))
        this.format = {
          sampleRate: value.sampleRate,
          numberOfChannels: value.numberOfChannels,
          frameDurationUs: rawChunkDurationUs * this.chunksPerBatch,
        }
        this.codec = new PlaceholderLowBitrateCodec(this.format, 'encode')
      }
      this.batchBuffer.push(value)
      if (this.batchBuffer.length < this.chunksPerBatch) continue
      const merged = mergeAudioChunks(this.batchBuffer)
      this.batchBuffer = []
      const frames = await this.codec!.encode(merged)
      for (const frame of frames) await this.send(packFrame(frame, this.format!))
    }
    // Whatever's left in batchBuffer is shorter than the encoder's configured
    // frame duration — encoding it would throw "incompatible with codec
    // parameters" the same way a raw 10ms chunk did before batching existed.
    // Dropping the last partial fraction of a second of a push-to-talk
    // recording is an acceptable trade for not crashing on release.
    for (const c of this.batchBuffer) c.close()
    this.batchBuffer = []
    // encode() no longer flushes per call (see codec.ts) — drain whatever
    // the encoder is still internally holding onto now that the session's
    // actually ending, or the last second or so of every recording would
    // silently never get sent.
    if (this.codec) {
      const encoded = await this.codec.drain()
      for (const frame of encoded) await this.send(packFrame(frame, this.format!))
    }
  }

  stop() {
    this.recording = false
    this.reader?.cancel().catch(() => {})
    this.track?.stop()
    // Wait for the pump loop to actually exit before closing the codec —
    // it may be mid-`await this.codec.encode(value)` right now, and closing
    // out from under that call throws InvalidStateError ("closed codec").
    const codec = this.codec
    this.pumpDone.finally(() => codec?.close())
  }
}

/** Decodes incoming voice frames and schedules them back-to-back on an AudioContext for gapless playback. */
export class PushToTalkPlayer {
  private codec: PlaceholderLowBitrateCodec | null = null
  private ctx: AudioContext | null = null
  private format: { sampleRate: number; numberOfChannels: number } | null = null
  private nextPlayTime = 0
  // Callers fire-and-forget playFrame() per incoming voice frame (see
  // App.tsx's onVoiceFrame), so consecutive frames arriving close together
  // (now the norm — see writeWithoutResponse in ble.ts) can call decode()
  // before the previous call's decode()+flush() has resolved. The codec's
  // pendingDecoded buffer is shared and drained wholesale by whichever
  // flush() resolves first, so overlapping calls could hand one frame's
  // output to a different frame's caller, or drop it entirely when its own
  // flush() later finds the buffer already emptied — reordered/missing
  // audio that looks exactly like "still not clean" even after the
  // transport stopped being the bottleneck. Chaining every call through
  // this queue guarantees only one decode+flush+schedule cycle runs at a
  // time, strictly in arrival order.
  private queue: Promise<void> = Promise.resolve()

  playFrame(bytes: Uint8Array): Promise<void> {
    this.queue = this.queue.then(() => this.decodeAndSchedule(bytes))
    return this.queue
  }

  private async decodeAndSchedule(bytes: Uint8Array) {
    const frame = unpackFrame(bytes)
    // The sender's actual capture format travels with the frame (see
    // packFrame) — build (or rebuild) the decoder and playback context to
    // match it rather than assuming SAMVAD_CODEC_SAMPLE_RATE, since that's
    // just a fallback default, not a guarantee of what the peer captured at.
    if (!this.codec || !this.ctx || this.format?.sampleRate !== frame.sampleRate) {
      this.codec?.close()
      this.ctx?.close()
      this.format = { sampleRate: frame.sampleRate, numberOfChannels: frame.numberOfChannels }
      this.codec = new PlaceholderLowBitrateCodec(this.format, 'decode')
      this.ctx = new AudioContext({ sampleRate: frame.sampleRate })
      this.nextPlayTime = 0
    }
    const ctx = this.ctx
    const decoded = await this.codec.decode(frame)
    for (const audioData of decoded) {
      const buffer = ctx.createBuffer(
        audioData.numberOfChannels,
        audioData.numberOfFrames,
        audioData.sampleRate,
      )
      const channelData = new Float32Array(audioData.numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: 0, format: 'f32-planar' })
      buffer.copyToChannel(channelData, 0)
      audioData.close()

      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, this.nextPlayTime)
      source.start(startAt)
      this.nextPlayTime = startAt + buffer.duration
    }
  }

  close() {
    this.codec?.close()
    this.ctx?.close()
  }
}
