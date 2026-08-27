import { useEffect, useRef, useState } from 'react'
import { Buffer } from 'buffer'
import './App.css'
import { loadOrCreateDeviceIdentity, fingerprintOf } from './lib/noise'
import { SignalingClient } from './lib/signaling'
import { CallSession, type CallStatus } from './lib/webrtc'
import { TransportManager, type Tier } from './lib/transport'
import { BleTier, type BlePeer } from './lib/ble'
import { PushToTalkRecorder, PushToTalkPlayer } from './lib/ptt'
import { getSignalingHost, setSignalingHost, signalingWsUrl, signalingHealthUrl } from './lib/config'

const identity = loadOrCreateDeviceIdentity()
const localFingerprint = fingerprintOf(identity.publicKey)

function TierBadge({ tier }: { tier: Tier }) {
  const label = tier === 'internet' ? 'Internet' : tier === 'ble' ? 'BLE Mesh' : 'Searching'
  return <span className={`tier-badge tier-${tier}`}>{label}</span>
}

export default function App() {
  const [tier, setTier] = useState<Tier>('searching')
  const [log, setLog] = useState<string[]>([])
  const appendLog = (line: string) => setLog((prev) => [...prev.slice(-49), line])

  // Address of the signaling server. Auto-filled with the page's own host
  // in a browser tab; must be entered once on the native app (see lib/config.ts).
  const [signalingHost, setSignalingHostState] = useState(getSignalingHost())
  function updateSignalingHost(host: string) {
    setSignalingHostState(host)
    setSignalingHost(host)
  }

  // --- internet tier state ---
  const [room, setRoom] = useState('')
  const [callStatus, setCallStatus] = useState<CallStatus | 'idle'>('idle')
  const [fingerprints, setFingerprints] = useState<{ local: string; remote: string } | null>(null)
  const callRef = useRef<CallSession | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  // --- BLE tier state ---
  const [blePeers, setBlePeers] = useState<BlePeer[]>([])
  // 'both' matches ble.ts's own architecturally-correct default (see its
  // module comment) and the dropdown's "(default)" label below. A prior
  // commit silently hardcoded this to 'central' for "this device pair" —
  // since every device runs the same build, that meant *every* phone
  // defaulted to scan-only and never advertised, so two default installs
  // could never find each other. Switch to 'peripheral'/'central' per
  // device only as a workaround for the confirmed concurrent-role GATT
  // hang on some chipsets (see README's Known limitations).
  const [bleRole, setBleRole] = useState<'both' | 'peripheral' | 'central'>('both')
  const bleTierRef = useRef<BleTier | null>(null)
  const pttRecorderRef = useRef<PushToTalkRecorder | null>(null)
  const pttPlayersRef = useRef<Map<string, PushToTalkPlayer>>(new Map())

  useEffect(() => {
    if (!signalingHost) return
    const tm = new TransportManager({
      signalingHealthUrl: signalingHealthUrl(signalingHost),
      onTierChange: (t) => {
        setTier(t)
        appendLog(`transport tier -> ${t}`)
      },
    })
    tm.start()
    return () => tm.stop()
  }, [signalingHost])

  // 'idle': never joined. 'closed'/'failed': a previous call ended (either
  // side hung up, or negotiation broke) — both are terminal, both should
  // allow rejoining, not just the pristine 'idle' state a naive
  // `!== 'idle'` check would require.
  const callIsActive = !['idle', 'closed', 'failed'].includes(callStatus)

  function leaveCall() {
    callRef.current?.close()
    callRef.current = null
    setCallStatus('idle')
    setFingerprints(null)
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    appendLog('left call')
  }

  async function joinInternetCall() {
    if (!room || !signalingHost) return
    if (callRef.current) leaveCall() // defensive: clean up any straggler before starting fresh
    setCallStatus('connecting-signaling')
    try {
      const signaling = new SignalingClient(signalingWsUrl(signalingHost), room)
      await signaling.ready
      appendLog('signaling connected, waiting for peer + exchanging identity keys')

      // Role can't depend on join-order timing (a race between two humans
      // typing the same room code) because the Noise handshake state has to
      // be initialized as initiator-or-responder up front. Instead, both
      // sides exchange identity public keys first and independently compute
      // the same tie-break, so exactly one of them ends up as initiator.
      const localKey = Buffer.from(identity.publicKey).toString('base64')
      const remoteKey = await new Promise<string>((resolve) => {
        const sendHello = () => signaling.send({ type: 'hello', publicKey: localKey })
        const unsubscribe = signaling.onMessage((msg) => {
          if (msg.type === 'hello') {
            unsubscribe()
            resolve(msg.publicKey)
          } else if (msg.type === 'peer-joined') {
            // We may have sent our first hello before anyone was in the
            // room to receive it (the server doesn't replay history to
            // late joiners) — resend now that someone just arrived.
            sendHello()
          }
        })
        sendHello()
      })

      if (localKey === remoteKey) {
        appendLog(
          '[warn] both peers have the SAME identity key — you\'re likely testing two tabs on the ' +
            'same browser, which share localStorage. Use two different browsers, an Incognito ' +
            'window for one side, or two separate devices.',
        )
      }
      const role = localKey < remoteKey ? 'initiator' : 'responder'
      appendLog(`internet tier: resolved role -> ${role}`)

      const call = new CallSession(signaling, role, identity, {
        onStatusChange: setCallStatus,
        onFingerprint: (local, remote) => setFingerprints({ local, remote }),
        onRemoteStream: (stream) => {
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream
        },
        onLog: appendLog,
      })
      callRef.current = call
      if (role === 'initiator') await call.start()
      else setCallStatus('verifying') // responder is idle-but-listening until step 1 arrives; reflect that in the UI now
    } catch (err) {
      appendLog(`internet tier error: ${err}`)
      setCallStatus('failed')
    }
  }

  async function toggleBleTier() {
    if (bleTierRef.current) {
      await bleTierRef.current.stop()
      bleTierRef.current = null
      setBlePeers([])
      appendLog('[ble] stopped')
      return
    }
    const ble = new BleTier(identity, {
      onLog: appendLog,
      onPeerConnected: (peer) => setBlePeers((prev) => [...prev.filter((p) => p.deviceId !== peer.deviceId), peer]),
      onPeerDisconnected: (id) => setBlePeers((prev) => prev.filter((p) => p.deviceId !== id)),
      onVoiceFrame: (deviceId, plaintext) => {
        let player = pttPlayersRef.current.get(deviceId)
        if (!player) {
          player = new PushToTalkPlayer()
          pttPlayersRef.current.set(deviceId, player)
        }
        void player.playFrame(plaintext)
      },
    })
    bleTierRef.current = ble
    try {
      await ble.start({
        peripheral: bleRole === 'both' || bleRole === 'peripheral',
        central: bleRole === 'both' || bleRole === 'central',
      })
    } catch (err) {
      appendLog(`BLE tier error: ${err}`)
    }
  }

  async function startPtt(peer: BlePeer) {
    if (pttRecorderRef.current) return // already recording — ignore a duplicate press
    const recorder = new PushToTalkRecorder(
      (bytes) => peer.sendVoiceFrame(bytes),
      (err) => appendLog(`[ptt] stream error: ${err}`),
    )
    pttRecorderRef.current = recorder
    try {
      await recorder.start()
      appendLog(`[ptt] recording -> ${peer.deviceId}`)
    } catch (err) {
      appendLog(`[ptt] failed to start: ${err}`)
      pttRecorderRef.current = null
    }
  }

  function stopPtt() {
    pttRecorderRef.current?.stop()
    pttRecorderRef.current = null
  }

  return (
    <div className="app">
      <header>
        <h1>SAMVAD</h1>
        <div className="subtitle">Secure Ad-hoc Mesh Voice · device fingerprint {localFingerprint}</div>
        <TierBadge tier={tier} />
      </header>

      <section className="panel">
        <h2>Internet tier — live call</h2>
        <div className="row">
          <input
            placeholder="signaling server host (e.g. 192.168.1.11)"
            value={signalingHost}
            onChange={(e) => updateSignalingHost(e.target.value)}
          />
        </div>
        <div className="row">
          <input
            placeholder="room code (share with peer)"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={callIsActive}
          />
          {callIsActive ? (
            <button onClick={leaveCall}>Leave call</button>
          ) : (
            <button onClick={joinInternetCall} disabled={!room || !signalingHost}>
              Join call
            </button>
          )}
        </div>
        <div className="status-line">
          status: <b>{callStatus}</b>
        </div>
        {fingerprints && (
          <div className="fingerprints">
            <div>your fingerprint&nbsp; {fingerprints.local}</div>
            <div>peer fingerprint&nbsp; {fingerprints.remote}</div>
            <div className="hint">Compare these out loud before trusting the call.</div>
          </div>
        )}
        <audio ref={remoteAudioRef} autoPlay />
      </section>

      <section className="panel">
        <h2>BLE mesh tier — push to talk</h2>
        <div className="row">
          <select
            value={bleRole}
            disabled={!!bleTierRef.current}
            onChange={(e) => setBleRole(e.target.value as typeof bleRole)}
          >
            <option value="both">Both roles (default)</option>
            <option value="peripheral">Peripheral only (advertise)</option>
            <option value="central">Central only (scan)</option>
          </select>
        </div>
        <button onClick={toggleBleTier}>{bleTierRef.current ? 'Stop BLE' : 'Start BLE'}</button>
        <ul className="peer-list">
          {blePeers.map((peer) => (
            <li key={peer.deviceId}>
              <span>
                <span className="peer-role">{peer.role}</span>
                {peer.deviceId} · secure {peer.remoteFingerprint}
              </span>
              <button
                // Pointer Events only — deliberately not mouse+touch handlers
                // side by side. On a real touchscreen a touch also
                // synthesizes a trailing mousedown/mouseup for legacy-code
                // compatibility, so mouse+touch handlers together fire
                // startPtt() twice per physical press: two PushToTalkRecorder
                // instances race, and the first one's stop() closes the
                // AudioEncoder out from under the second one's still-running
                // encode() loop (surfaces as "Cannot call 'encode' on a
                // closed codec"). Pointer Events unify touch/mouse/pen into
                // one event stream with no such duplication.
                onPointerDown={() => startPtt(peer)}
                onPointerUp={stopPtt}
                onPointerLeave={stopPtt}
                onPointerCancel={stopPtt}
              >
                Hold to talk
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel log-panel">
        <h2>Log</h2>
        <pre>{log.join('\n')}</pre>
      </section>
    </div>
  )
}
