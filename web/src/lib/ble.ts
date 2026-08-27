// BLE mesh tier (fallback 1): push-to-talk / short voice notes over
// Bluetooth Low Energy, no internet required. Every connected device runs
// *both* GATT roles at once — advertise+serve (peripheral, via the custom
// native plugin) and scan+connect (central, via @capacitor-community/
// bluetooth-le) — so any two SAMVAD phones can find and pair with each
// other regardless of which one happens to notice the other first. This is
// a single-hop implementation (two devices directly connected); the
// flooding relay behavior described in the architecture doc for a wider
// mesh is the natural next extension of this same peer abstraction.
//
// Whichever side discovers and connects (central) is the Noise initiator;
// whichever side accepts the incoming connection (peripheral) is the
// responder — the same convention lib/webrtc.ts uses for the internet tier.
//
// KNOWN HARDWARE LIMITATION (confirmed on real devices, not theoretical):
// on at least one tested chipset, a device running both roles concurrently
// silently drops the GATT connection callback on the central side — the
// connection succeeds at the OS level (confirmed from the peripheral's
// perspective) but the central's own connect() promise never resolves or
// rejects, hanging forever with no error. Isolating each device to a single
// role (see the `peripheral`/`central` flags on start(), surfaced in the UI
// as a role selector) reliably works around it. Kept `both` as the default
// here regardless, since dual-role is the architecturally correct behavior
// for a real mesh — the single-role selector exists as a fallback for
// hardware where concurrent dual-role turns out to be unreliable.
import { Buffer } from 'buffer'
import { BleClient, type ScanResult } from '@capacitor-community/bluetooth-le'
import {
  SamvadBlePeripheral,
  SAMVAD_SERVICE_UUID,
  SAMVAD_RX_CHARACTERISTIC_UUID,
  SAMVAD_TX_CHARACTERISTIC_UUID,
} from './ble-peripheral'
import { NoiseXXSession, fingerprintOf } from './noise'
import type { NoiseKeyPair } from 'noise-protocol'
import { FrameType, FrameReassembler, encodeFrame, chunk } from './framing'

const MAX_BLE_CHUNK_BYTES = 150 // conservative; safe under default negotiated ATT MTU on most Android BLE stacks

export type BlePeerRole = 'central' | 'peripheral'

export interface BlePeer {
  deviceId: string
  role: BlePeerRole
  secure: boolean
  remoteFingerprint?: string
  sendVoiceFrame(data: Uint8Array): Promise<void>
}

export interface BleTierEvents {
  onPeerConnected?(peer: BlePeer): void
  onPeerDisconnected?(deviceId: string): void
  onVoiceFrame?(deviceId: string, plaintext: Uint8Array): void
  onLog?(line: string): void
}

interface InternalPeer {
  deviceId: string
  role: BlePeerRole
  noise: NoiseXXSession
  reassembler: FrameReassembler
  established: boolean
}

export class BleTier {
  private localIdentity: NoiseKeyPair
  private events: BleTierEvents
  private peers = new Map<string, InternalPeer>()
  private scanning = false
  private advertising = false

  constructor(localIdentity: NoiseKeyPair, events: BleTierEvents = {}) {
    this.localIdentity = localIdentity
    this.events = events
  }

  private log(line: string) {
    this.events.onLog?.(line)
  }

  /**
   * By default a device runs both GATT roles at once (see the module
   * comment). Some chipsets appear to drop the GATT connection callback
   * when a device is simultaneously advertising its own service and
   * connecting out to a peer's — pass `{ peripheral: false }` or
   * `{ central: false }` to force a single role, as a workaround on
   * hardware where that turns out to be a real limitation.
   */
  async start(opts: { peripheral?: boolean; central?: boolean } = {}) {
    const { peripheral = true, central = true } = opts
    // Sequential, not Promise.all: each half triggers its own independent
    // Android runtime-permission request (this plugin's advertise/connect,
    // @capacitor-community/bluetooth-le's scan/connect/location). Two
    // concurrent permission-dialog flows from the same app is a known
    // source of races on Android — a callback can fire against a stale
    // permission snapshot mid-flight. Serializing avoids it entirely.
    if (peripheral) await this.startPeripheral()
    if (central) await this.startCentral()
  }

  async stop() {
    if (this.scanning) await BleClient.stopLEScan().catch(() => {})
    if (this.advertising) await SamvadBlePeripheral.stopAdvertising().catch(() => {})
    for (const peer of this.peers.values()) {
      if (peer.role === 'central') await BleClient.disconnect(peer.deviceId).catch(() => {})
    }
    this.peers.clear()
  }

  // ---- peripheral role: advertise + serve a GATT server -----------------

  private async startPeripheral() {
    const { supported } = await SamvadBlePeripheral.initialize()
    if (!supported) {
      this.log('BLE peripheral mode unsupported on this device — advertising disabled')
      return
    }

    await SamvadBlePeripheral.addListener('centralConnected', ({ deviceId }) => {
      this.log(`[peripheral] central connected: ${deviceId}`)
      this.peers.set(deviceId, {
        deviceId,
        role: 'peripheral',
        noise: new NoiseXXSession('responder', this.localIdentity),
        reassembler: new FrameReassembler(),
        established: false,
      })
    })

    await SamvadBlePeripheral.addListener('centralDisconnected', ({ deviceId }) => {
      this.log(`[peripheral] central disconnected: ${deviceId}`)
      this.peers.delete(deviceId)
      this.events.onPeerDisconnected?.(deviceId)
    })

    await SamvadBlePeripheral.addListener('write', ({ deviceId, data }) => {
      this.handleIncomingBytes(deviceId, new Uint8Array(Buffer.from(data, 'base64')))
    })

    await SamvadBlePeripheral.startAdvertising({ localName: 'SAMVAD' })
    this.advertising = true
    this.log('[peripheral] advertising SAMVAD service')
  }

  // ---- central role: scan + connect out to peripherals -------------------

  private async startCentral() {
    this.log('[central] initializing...')
    await BleClient.initialize()
    this.log('[central] initialized, requesting scan...')
    this.scanning = true
    // Deliberately unfiltered at the native level — requestLEScan({ services:
    // [...] }) delegates to Android's ScanFilter.setServiceUuid(), which on a
    // real Samsung SM-G781B (confirmed on hardware) silently matched nothing:
    // the peripheral side was verifiably advertising SAMVAD_SERVICE_UUID (a
    // raw unfiltered scan showed every advertised UUID from every nearby
    // device, SAMVAD's peripheral included), yet the native-filtered scan
    // produced zero onScanResult callbacks for minutes straight. Matching
    // the UUID string ourselves in JS found the same peer within seconds.
    // Costs a little extra JS-side traffic from irrelevant nearby BLE
    // devices (headphones, etc.) — worth it for actually working on this
    // chipset. See HANDOFF.md's BLE bug history for the full writeup.
    await BleClient.requestLEScan({}, (result) => {
      if (result.uuids?.some((u) => u.toLowerCase() === SAMVAD_SERVICE_UUID.toLowerCase())) {
        this.onScanResult(result)
      }
    })
    this.log('[central] scanning for SAMVAD peers')
  }

  private async onScanResult(result: ScanResult) {
    const deviceId = result.device.deviceId
    if (this.peers.has(deviceId)) return // already connected/connecting

    // Claim it immediately to avoid a second concurrent connect attempt from
    // another scan result callback for the same device.
    this.peers.set(deviceId, {
      deviceId,
      role: 'central',
      noise: new NoiseXXSession('initiator', this.localIdentity),
      reassembler: new FrameReassembler(),
      established: false,
    })

    try {
      this.log(`[central] connecting to ${deviceId}`)
      await BleClient.connect(deviceId, (id) => {
        this.peers.delete(id)
        this.events.onPeerDisconnected?.(id)
      })
      await BleClient.startNotifications(
        deviceId,
        SAMVAD_SERVICE_UUID,
        SAMVAD_TX_CHARACTERISTIC_UUID,
        (value) => this.handleIncomingBytes(deviceId, new Uint8Array(value.buffer)),
      )

      // Kick off the Noise handshake as the initiator.
      const peer = this.peers.get(deviceId)!
      const msg1 = peer.noise.start()
      await this.writeToPeer(deviceId, encodeFrame(FrameType.NoiseHandshake, msg1))
    } catch (err) {
      this.log(`[central] connect to ${deviceId} failed: ${err}`)
      this.peers.delete(deviceId)
    }
  }

  // ---- shared framing / handshake / send plumbing ------------------------

  private handleIncomingBytes(deviceId: string, bytes: Uint8Array) {
    const peer = this.peers.get(deviceId)
    if (!peer) return
    for (const frame of peer.reassembler.push(bytes)) {
      if (frame.type === FrameType.NoiseHandshake) this.handleHandshakeFrame(peer, frame.payload)
      else if (frame.type === FrameType.VoiceFrame) this.handleVoiceFrame(peer, frame.payload)
    }
  }

  private async handleHandshakeFrame(peer: InternalPeer, payload: Uint8Array) {
    if (peer.role === 'central') {
      // initiator: this is message 2 (e, ee, s, es) -> reply with message 3
      const remoteKey = peer.noise.readMessage(payload)
      const msg3 = peer.noise.writeMessage(this.localIdentity.publicKey)
      await this.writeToPeer(peer.deviceId, encodeFrame(FrameType.NoiseHandshake, msg3))
      this.markEstablished(peer, remoteKey)
    } else {
      // responder: this is either message 1 (-> reply with message 2) or message 3 (-> done)
      const remoteKeyMaybe = peer.noise.readMessage(payload)
      if (!peer.noise.established) {
        // that was message 1 — reply with message 2, carrying our identity key
        const msg2 = peer.noise.writeMessage(this.localIdentity.publicKey)
        await this.writeToPeer(peer.deviceId, encodeFrame(FrameType.NoiseHandshake, msg2))
      } else {
        // that was message 3 — handshake complete
        this.markEstablished(peer, remoteKeyMaybe)
      }
    }
  }

  private markEstablished(peer: InternalPeer, remoteIdentityPublicKey: Uint8Array) {
    peer.established = true
    const blePeer: BlePeer = {
      deviceId: peer.deviceId,
      role: peer.role,
      secure: true,
      remoteFingerprint: fingerprintOf(remoteIdentityPublicKey),
      sendVoiceFrame: (data) => this.sendVoiceFrame(peer, data),
    }
    this.log(`[${peer.role}] secure channel established with ${peer.deviceId}`)
    this.events.onPeerConnected?.(blePeer)
  }

  private handleVoiceFrame(peer: InternalPeer, payload: Uint8Array) {
    if (!peer.established) return
    try {
      const plaintext = peer.noise.decrypt(payload)
      this.events.onVoiceFrame?.(peer.deviceId, plaintext)
    } catch (err) {
      this.log(`decrypt failed from ${peer.deviceId}: ${err}`)
    }
  }

  private async sendVoiceFrame(peer: InternalPeer, plaintext: Uint8Array) {
    if (!peer.established) throw new Error('secure channel not established')
    const ciphertext = peer.noise.encrypt(plaintext)
    await this.writeToPeer(peer.deviceId, encodeFrame(FrameType.VoiceFrame, ciphertext))
  }

  /** Central writes to the peer's RX characteristic; peripheral notifies via its TX characteristic. */
  private async writeToPeer(deviceId: string, envelope: Uint8Array) {
    const peer = this.peers.get(deviceId)
    if (!peer) return
    for (const piece of chunk(envelope, MAX_BLE_CHUNK_BYTES)) {
      if (peer.role === 'central') {
        await BleClient.write(
          deviceId,
          SAMVAD_SERVICE_UUID,
          SAMVAD_RX_CHARACTERISTIC_UUID,
          new DataView(piece.buffer, piece.byteOffset, piece.byteLength),
        )
      } else {
        await SamvadBlePeripheral.notify({
          deviceId,
          data: Buffer.from(piece).toString('base64'),
        })
      }
    }
  }
}
