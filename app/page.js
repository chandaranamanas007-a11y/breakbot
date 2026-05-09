'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import mqtt from 'mqtt'

const MQTT_BROKER = process.env.NEXT_PUBLIC_MQTT_BROKER || 'wss://broker.hivemq.com:8884/mqtt'
const MQTT_TOPIC_CMD = 'breakerbot/cmd'
const MQTT_TOPIC_STATUS = 'breakerbot/status'
const MQTT_TOPIC_LOG = 'breakerbot/log'

// Authentication logic moved strictly to Secure Hash Algorithm (SHA-256)
// Eliminating Vercel environment dependencies while retaining GitHub plaintext security
const HASH_PIN = '5387f61fb55c0cbbd377bcca98fb5de224d081b7a2d815779c6d4825d1cb3776' // 'circuit'
const HASH_RECOVERY = '9273c5cf8c697c11267b14d2af52538dd3f4ebf88fa068e8055627f12e8b0a96' // 'CBMA'

async function hashStr(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Geofencing ─────────────────────────────────────────────────────────────
const HOME_LAT = 22.2752   // Naval Nagar, Mavdi, Rajkot
const HOME_LON = 70.7718
const ZONE1_RADIUS_KM = 30
// India bounding box (conservative — any position outside = Zone 3)
const INDIA_BBOX = { minLat: 6.0, maxLat: 37.0, minLon: 68.0, maxLon: 98.0 }

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function classifyZone(lat, lon) {
  const isInIndia =
    lat >= INDIA_BBOX.minLat &&
    lat <= INDIA_BBOX.maxLat &&
    lon >= INDIA_BBOX.minLon &&
    lon <= INDIA_BBOX.maxLon
  if (!isInIndia) return 3
  const dist = haversineDistance(HOME_LAT, HOME_LON, lat, lon)
  return dist <= ZONE1_RADIUS_KM ? 1 : 2
}

// ── IP-based Geolocation Fallback ──────────────────────────────────────────
async function ipFallbackGeolocate() {
  const res = await fetch('http://ip-api.com/json/?fields=status,lat,lon,country')
  if (!res.ok) throw new Error('IP geolocation request failed')
  const data = await res.json()
  if (data.status === 'success') return { lat: data.lat, lon: data.lon, country: data.country }
  throw new Error('IP geolocation lookup failed')
}
// ───────────────────────────────────────────────────────────────────────────

export default function Home() {
  // Session
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [accessCodeInput, setAccessCodeInput] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isShake, setIsShake] = useState(false)

  // Device
  const [connected, setConnected] = useState(false)
  const [doorStatus, setDoorStatus] = useState('CLOSED')
  const [cardStatus, setCardStatus] = useState('ACTIVE')
  const [fanStatus, setFanStatus] = useState(false)
  const [lightsStatus, setLightsStatus] = useState(false)
  const [isLockedOut, setIsLockedOut] = useState(false)
  const [logs, setLogs] = useState([])

  // Feature
  const [isListening, setIsListening] = useState(false)
  const [theme, setTheme] = useState('default')
  const [weather, setWeather] = useState({ temp: 24, condition: 'Cloudy', humidity: 65 })
  const [loading, setLoading] = useState({})
  const [systemUptime, setSystemUptime] = useState('00:00:00')
  const [pinInput, setPinInput] = useState('')
  const [showPinModal, setShowPinModal] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [notification, setNotification] = useState(null)

  // ── Geofencing State ──────────────────────────────────────────────────────
  const [geoZone, setGeoZone] = useState(null)        // null | 1 | 2 | 3
  const [geoDistance, setGeoDistance] = useState(null) // km from home
  const [geoError, setGeoError] = useState(null)
  const [isGeoLockedDown, setIsGeoLockedDown] = useState(false)
  // Two-layer lockdown clearance
  const [showLockdownClearModal, setShowLockdownClearModal] = useState(false)
  const [lockdownClearStep, setLockdownClearStep] = useState(1) // 1=PIN, 2=ReactivateCode
  const [lockdownClearInput, setLockdownClearInput] = useState('')
  const [lockdownClearError, setLockdownClearError] = useState('')

  // ── Location Verification Gate State ──────────────────────────────────────
  const [geoVerified, setGeoVerified] = useState(false)       // true once location confirmed
  const [geoSource, setGeoSource] = useState(null)             // 'gps' | 'ip' | null
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [ipFallbackFailed, setIpFallbackFailed] = useState(false)
  const [geoGateStatus, setGeoGateStatus] = useState('acquiring') // 'acquiring' | 'fallback' | 'denied' | 'failed'
  // Emergency CBMA override for the gate
  const [showEmergencyOverride, setShowEmergencyOverride] = useState(false)
  const [emergencyInput, setEmergencyInput] = useState('')
  const [emergencyError, setEmergencyError] = useState('')
  // ─────────────────────────────────────────────────────────────────────────

  const clientRef = useRef(null)
  const startTime = useRef(Date.now())
  const lastZoneRef = useRef(null) // prevent duplicate zone messages

  // Uptime
  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime.current) / 1000)
      const hrs = String(Math.floor(diff / 3600)).padStart(2, '0')
      const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, '0')
      const secs = String(diff % 60).padStart(2, '0')
      setSystemUptime(`${hrs}:${mins}:${secs}`)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Weather sim
  useEffect(() => {
    const interval = setInterval(() => {
      setWeather((prev) => ({
        ...prev,
        temp: prev.temp + (Math.random() > 0.5 ? 0.1 : -0.1),
      }))
    }, 10000)
    return () => clearInterval(interval)
  }, [])

  // Stable log function (no dependency changes)
  const addLog = useCallback((text, type = 'info') => {
    setLogs((prev) =>
      [{ text, type, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) }, ...prev].slice(0, 50)
    )
  }, [])

  // MQTT
  useEffect(() => {
    if (!isLoggedIn) return
    const client = mqtt.connect(MQTT_BROKER, {
      clientId: 'breakerbot_web_' + Math.random().toString(16).slice(2, 8),
      clean: true,
      reconnectPeriod: 5000,
    })
    client.on('connect', () => {
      setConnected(true)
      client.subscribe([MQTT_TOPIC_STATUS, MQTT_TOPIC_LOG])
      client.publish(MQTT_TOPIC_CMD, JSON.stringify({ action: 'get_status' }))
      addLog('Dashboard online', 'success')
    })
    client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString())
        if (topic === MQTT_TOPIC_STATUS) {
          if (data.door !== undefined) setDoorStatus(data.door)
          if (data.card !== undefined) setCardStatus(data.card)
          if (data.fan !== undefined) setFanStatus(data.fan === 'ON')
          if (data.lights !== undefined) setLightsStatus(data.lights === 'ON')
          if (data.lockout !== undefined) setIsLockedOut(data.lockout)
        }
        if (topic === MQTT_TOPIC_LOG) {
          addLog(data.action || 'Event', data.success !== false ? 'success' : 'error')
        }
      } catch (e) {
        console.error('Parse error:', e)
      }
    })
    client.on('disconnect', () => setConnected(false))
    clientRef.current = client
    return () => client.end()
  }, [isLoggedIn, addLog])

  // ── Geolocation Watcher with IP Fallback ──────────────────────────────────
  useEffect(() => {
    if (!isLoggedIn) return

    // ── No browser geolocation support → try IP fallback immediately ──
    if (!navigator?.geolocation) {
      setGeoError('Geolocation not supported by this browser')
      setGeoGateStatus('fallback')
      addLog('⚠️ Browser geolocation not supported — trying IP fallback', 'warning')
      attemptIpFallback()
      return
    }

    const onPosition = (pos) => {
      const { latitude, longitude } = pos.coords
      const distance = haversineDistance(HOME_LAT, HOME_LON, latitude, longitude)
      const zone = classifyZone(latitude, longitude)

      setGeoDistance(distance)
      setGeoError(null)
      setGeoVerified(true)
      setGeoSource('gps')
      setGeoGateStatus('verified')

      if (lastZoneRef.current !== zone) {
        lastZoneRef.current = zone
        setGeoZone(zone)

        if (zone === 1) {
          addLog(`📍 Zone 1 — Home vicinity (${distance.toFixed(1)} km) [GPS]`, 'success')
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_home', distance_km: distance.toFixed(1) })
          )
        } else if (zone === 2) {
          addLog(`✈️ Zone 2 — Away (${distance.toFixed(1)} km from home) [GPS]`, 'info')
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_away', distance_km: distance.toFixed(1) })
          )
        } else if (zone === 3) {
          addLog('🌐🚨 Zone 3 — INTERNATIONAL LOCKDOWN ACTIVATED [GPS]', 'error')
          setIsGeoLockedDown(true)
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_lockdown' })
          )
        }
      }
    }

    const onError = (err) => {
      // Error code 1 = PERMISSION_DENIED
      if (err.code === 1) {
        setPermissionDenied(true)
        setGeoError('Location permission denied')
        setGeoGateStatus('fallback')
        addLog('🚫 Location permission DENIED — attempting IP fallback', 'error')
        attemptIpFallback()
      } else if (err.code === 2) {
        // POSITION_UNAVAILABLE
        setGeoError('Position unavailable')
        setGeoGateStatus('fallback')
        addLog('⚠️ GPS position unavailable — attempting IP fallback', 'warning')
        attemptIpFallback()
      } else if (err.code === 3) {
        // TIMEOUT
        setGeoError('Location request timed out')
        setGeoGateStatus('fallback')
        addLog('⏱️ GPS timed out — attempting IP fallback', 'warning')
        attemptIpFallback()
      } else {
        setGeoError(err.message)
        setGeoGateStatus('failed')
        addLog(`❌ Geolocation error: ${err.message}`, 'error')
      }
    }

    const watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    })
    return () => navigator.geolocation.clearWatch(watchId)
  }, [isLoggedIn, addLog])

  // ── IP Fallback Logic ─────────────────────────────────────────────────────
  const attemptIpFallback = async () => {
    try {
      const { lat, lon } = await ipFallbackGeolocate()
      const distance = haversineDistance(HOME_LAT, HOME_LON, lat, lon)
      let zone = classifyZone(lat, lon)

      // STRICT RULE: IP-based location NEVER gets Zone 1
      // Max access level is Zone 2 (Away mode with PIN required)
      if (zone === 1) {
        zone = 2
        addLog('📡 IP fallback: coordinates near home but downgraded to Zone 2 (IP not trusted for Zone 1)', 'warning')
      }

      setGeoDistance(distance)
      setGeoVerified(true)
      setGeoSource('ip')
      setGeoGateStatus('verified')
      setGeoError(null)

      lastZoneRef.current = zone
      setGeoZone(zone)

      if (zone === 2) {
        addLog(`📡 Zone 2 — Away (${distance.toFixed(1)} km from home) [IP Fallback]`, 'info')
        clientRef.current?.publish(
          MQTT_TOPIC_CMD,
          JSON.stringify({ action: 'zone_away', distance_km: distance.toFixed(1), source: 'ip' })
        )
      } else if (zone === 3) {
        addLog('🌐🚨 Zone 3 — INTERNATIONAL LOCKDOWN ACTIVATED [IP Fallback]', 'error')
        setIsGeoLockedDown(true)
        clientRef.current?.publish(
          MQTT_TOPIC_CMD,
          JSON.stringify({ action: 'zone_lockdown', source: 'ip' })
        )
      }
    } catch {
      // Both GPS and IP failed — treat as security failure
      setIpFallbackFailed(true)
      setGeoGateStatus('failed')
      addLog('🔴 IP fallback FAILED — location cannot be verified. Dashboard locked.', 'error')
      clientRef.current?.publish(
        MQTT_TOPIC_CMD,
        JSON.stringify({ action: 'zone_verification_failed' })
      )
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Emergency CBMA Override (Gate Bypass — Final Recovery Layer) ─────────
  const handleEmergencyOverride = async () => {
    const inputHash = await hashStr(emergencyInput)
    if (inputHash === HASH_RECOVERY) {
      // CBMA is the ONLY emergency bypass — grants Zone 2 (Away) access, never Zone 1
      setGeoVerified(true)
      setGeoSource('emergency')
      setGeoZone(2)
      setGeoGateStatus('verified')
      setGeoDistance(null)
      lastZoneRef.current = 2
      setShowEmergencyOverride(false)
      setEmergencyInput('')
      addLog('🔓 EMERGENCY OVERRIDE — Recovery code accepted. Access granted at Zone 2 (Away).', 'warning')
      clientRef.current?.publish(
        MQTT_TOPIC_CMD,
        JSON.stringify({ action: 'emergency_override', zone: 2 })
      )
      showNotification('Emergency Override Active — Zone 2', false)
    } else {
      setEmergencyError('Invalid emergency code.')
      addLog('❌ Failed emergency override attempt', 'error')
      setEmergencyInput('')
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Login
  const handleLogin = async (e) => {
    e.preventDefault()
    const inputHash = await hashStr(accessCodeInput)
    if (inputHash === HASH_PIN) {
      setIsLoggedIn(true)
      setLoginError('')
    } else {
      setLoginError('Invalid access code.')
      setAccessCodeInput('')
      setIsShake(true)
      setTimeout(() => setIsShake(false), 500)
    }
  }

  const handleLogout = () => {
    setIsLoggedIn(false)
    setAccessCodeInput('')
    // Reset geolocation state on logout
    setGeoVerified(false)
    setGeoSource(null)
    setGeoZone(null)
    setGeoDistance(null)
    setGeoError(null)
    setGeoGateStatus('acquiring')
    setPermissionDenied(false)
    setIpFallbackFailed(false)
    lastZoneRef.current = null
  }

  // Voice
  const toggleVoiceControl = () => {
    if (!('webkitSpeechRecognition' in window)) {
      showNotification('Voice not supported on this browser', true)
      return
    }
    if (isListening) { setIsListening(false); return }
    const recognition = new window.webkitSpeechRecognition()
    recognition.continuous = false
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.onstart = () => { setIsListening(true); showNotification('Listening...', false) }
    recognition.onend = () => setIsListening(false)
    recognition.onresult = (event) => {
      const command = event.results[0][0].transcript.toLowerCase()
      showNotification(`"${command}"`, false)
      processVoiceCommand(command)
    }
    recognition.start()
  }

  const processVoiceCommand = (cmd) => {
    if (cmd.includes('light') && (cmd.includes('on') || cmd.includes('off'))) handleToggle('lights')
    if (cmd.includes('fan') && (cmd.includes('on') || cmd.includes('off'))) handleToggle('fan')
    if (cmd.includes('open') && cmd.includes('door')) handleSecureAction('open_door')
  }

  // Commands
  const sendCommand = (action, device = null) => {
    if (clientRef.current && connected) {
      clientRef.current.publish(MQTT_TOPIC_CMD, JSON.stringify({ action }))
      if (device === 'fan') {
        const ns = !fanStatus; setFanStatus(ns); addLog(`Fan turned ${ns ? 'ON' : 'OFF'}`, 'info')
      }
      if (device === 'lights') {
        const ns = !lightsStatus; setLightsStatus(ns); addLog(`Lights turned ${ns ? 'ON' : 'OFF'}`, 'info')
      }
      if (action === 'disable_card') { setCardStatus('DISABLED'); addLog('RFID Card Disabled', 'error') }
    } else {
      showNotification('System offline', true)
    }
  }

  const handleSecureAction = (action) => {
    if (isGeoLockedDown) {
      showNotification('🌐 International lockdown active — clear lockdown first', true)
      return
    }
    setPendingAction(action)
    setShowPinModal(true)
    setPinInput('')
  }

  const verifyAndExecute = async () => {
    const isSpecialAction = pendingAction === 'enable_card' || pendingAction === 'clear_lockout'
    const correctHash = isSpecialAction ? HASH_RECOVERY : HASH_PIN
    const inputHash = await hashStr(pinInput)
    if (inputHash === correctHash) {
      if (pendingAction === 'open_door') {
        setDoorStatus('OPENING...')
        addLog('Door Unlocked & Opened', 'success')
        setFanStatus(true); setLightsStatus(true)
        setTimeout(() => setDoorStatus('OPEN'), 1000)
        setTimeout(() => { setDoorStatus('CLOSED'); addLog('Door Closed automatically', 'info') }, 5000)
      } else if (pendingAction === 'enable_card') {
        setCardStatus('ACTIVE'); addLog('RFID Card Reactivated', 'success')
      } else if (pendingAction === 'disable_card') {
        setCardStatus('DISABLED'); addLog('RFID Card Disabled', 'error')
      } else if (pendingAction === 'clear_lockout') {
        setIsLockedOut(false); addLog('Security Lockout Cleared', 'success')
      }
      sendCommand(pendingAction)
      setShowPinModal(false); setPendingAction(null)
      showNotification('Access Granted', false)
    } else {
      showNotification('Access Denied', true)
      addLog('Failed Access Attempt', 'error')
    }
    setPinInput('')
  }

  const handleToggle = (device) => {
    if (isGeoLockedDown) { showNotification('🌐 International lockdown active.', true); return }
    if (loading[device]) return
    setLoading((prev) => ({ ...prev, [device]: true }))
    if (device === 'fan') sendCommand('toggle_fan', 'fan')
    if (device === 'lights') sendCommand('toggle_lights', 'lights')
    setTimeout(() => setLoading((prev) => ({ ...prev, [device]: false })), 600)
  }

  // ── Two-Layer Lockdown Clearance ─────────────────────────────────────────
  const handleLockdownClearInput = async () => {
    setLockdownClearError('')
    const inputHash = await hashStr(lockdownClearInput)
    
    if (lockdownClearStep === 1) {
      if (inputHash === HASH_PIN) {
        setLockdownClearStep(2)
        setLockdownClearInput('')
        addLog('Lockdown clear — Layer 1 verified', 'info')
      } else {
        setLockdownClearError('Incorrect Security PIN.')
        addLog('Failed lockdown clear — Layer 1', 'error')
        setLockdownClearInput('')
      }
    } else if (lockdownClearStep === 2) {
      if (inputHash === HASH_RECOVERY) {
        setIsGeoLockedDown(false)
        lastZoneRef.current = null // force zone reclassification on next position
        setShowLockdownClearModal(false)
        setLockdownClearStep(1)
        setLockdownClearInput('')
        addLog('🔓 International Lockdown Cleared — Admin Override', 'success')
        clientRef.current?.publish(
          MQTT_TOPIC_CMD,
          JSON.stringify({ action: 'zone_clear' })
        )
        showNotification('Lockdown Cleared ✅', false)
      } else {
        setLockdownClearError('Incorrect Reactivation Key.')
        addLog('Failed lockdown clear — Layer 2', 'error')
        setLockdownClearInput('')
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const showNotification = (message, isError = false) => {
    setNotification({ message, isError })
    setTimeout(() => setNotification(null), 3500)
  }

  // Zone display helpers
  const ZONE_META = {
    1: { label: '🟢 Zone 1 – Home', color: 'zone-green', icon: '🏠', desc: 'Full access enabled' },
    2: { label: '🟡 Zone 2 – Away', color: 'zone-amber', icon: '✈️', desc: 'PIN required for all actions' },
    3: { label: '🔴 Zone 3 – International', color: 'zone-red', icon: '🌐', desc: 'Lockdown active' },
    null: { label: '📡 Locating...', color: 'zone-unknown', icon: '📡', desc: 'Acquiring GPS signal' },
  }
  const zm = ZONE_META[geoZone]

  // Source badge text
  const SOURCE_LABELS = { gps: '🛰️ GPS', ip: '📡 IP', emergency: '🔑 CBMA' }
  const sourceLabel = geoSource ? SOURCE_LABELS[geoSource] : null

  // ── Login Screen ──────────────────────────────────────────────────────────
  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className={`login-card ${isShake ? 'shake' : ''}`} style={isShake ? { animation: 'shake 0.5s ease' } : {}}>
          <div className="logo">
            <div className="logo-icon"><LogoIcon /></div>
            <h1>Circuit Breakers</h1>
          </div>
          <p className="subtitle">Secure Verification Required</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Access Code"
              autoComplete="off"
              value={accessCodeInput}
              onChange={(e) => setAccessCodeInput(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary">Authenticate</button>
          </form>
          <p className="error-message">{loginError}</p>
        </div>
      </div>
    )
  }

  // ── Location Verification Gate ────────────────────────────────────────────
  // Dashboard is BLOCKED until location is verified via GPS, IP fallback, or
  // the emergency CBMA override. This prevents the geolocation bypass attack.
  if (!geoVerified) {
    return (
      <div className="geo-gate-container">
        <div className="geo-gate-card">
          <div className="geo-gate-logo">
            <LogoIcon size={48} />
            <span>Circuit Breakers</span>
          </div>

          {/* ── Acquiring GPS ── */}
          {geoGateStatus === 'acquiring' && (
            <div className="geo-gate-status">
              <div className="geo-gate-spinner"></div>
              <h2>Verifying Location</h2>
              <p className="geo-gate-sub">
                Acquiring GPS signal to verify your location.<br />
                Please allow location access when prompted.
              </p>
              <div className="geo-gate-step-chips">
                <span className="geo-gate-chip active">🛰️ GPS Acquiring...</span>
              </div>
            </div>
          )}

          {/* ── IP Fallback in progress ── */}
          {geoGateStatus === 'fallback' && !ipFallbackFailed && (
            <div className="geo-gate-status">
              <div className="geo-gate-spinner fallback"></div>
              <h2>GPS Unavailable</h2>
              <p className="geo-gate-sub">
                {permissionDenied
                  ? <>Location permission was <strong>denied</strong>.<br />Attempting IP-based location as fallback...</>
                  : <>GPS signal could not be acquired.<br />Attempting IP-based location as fallback...</>
                }
              </p>
              <div className="geo-gate-step-chips">
                <span className="geo-gate-chip denied">🛰️ GPS Failed</span>
                <span className="geo-gate-chip-arrow">→</span>
                <span className="geo-gate-chip active">📡 IP Fallback...</span>
              </div>
            </div>
          )}

          {/* ── Both GPS and IP Failed — Locked ── */}
          {(geoGateStatus === 'failed' || (geoGateStatus === 'fallback' && ipFallbackFailed)) && (
            <div className="geo-gate-status">
              <div className="geo-gate-lock-icon">🔒</div>
              <h2>Location Verification Failed</h2>
              <p className="geo-gate-sub">
                Both GPS and IP-based location verification failed.<br />
                Dashboard access is <strong>blocked</strong> for security.
              </p>
              <div className="geo-gate-step-chips">
                <span className="geo-gate-chip denied">🛰️ GPS Failed</span>
                <span className="geo-gate-chip-arrow">→</span>
                <span className="geo-gate-chip denied">📡 IP Failed</span>
              </div>
              <div className="geo-gate-warning">
                <span className="geo-gate-warning-icon">⚠️</span>
                <span>Only the emergency recovery code can bypass this gate.</span>
              </div>
              {!showEmergencyOverride && (
                <button
                  className="btn-emergency-override"
                  onClick={() => {
                    setShowEmergencyOverride(true)
                    setEmergencyInput('')
                    setEmergencyError('')
                  }}
                >
                  🔑 Emergency Recovery
                </button>
              )}
            </div>
          )}

          {/* ── Emergency CBMA Override Form ── */}
          {showEmergencyOverride && (
            <div className="geo-gate-emergency">
              <h3>🔑 Emergency Recovery</h3>
              <p className="geo-gate-emergency-sub">
                Enter the emergency recovery code to bypass location verification.<br />
                Access will be restricted to <strong>Zone 2 (Away Mode)</strong>.
              </p>
              <input
                type="password"
                value={emergencyInput}
                onChange={(e) => setEmergencyInput(e.target.value)}
                placeholder="Emergency Code"
                autoFocus
                className="pin-input"
                style={{ letterSpacing: '6px', textTransform: 'uppercase' }}
                onKeyDown={(e) => e.key === 'Enter' && handleEmergencyOverride()}
              />
              {emergencyError && <p className="lockdown-error">{emergencyError}</p>}
              <div className="modal-buttons">
                <button className="btn-secondary" onClick={() => {
                  setShowEmergencyOverride(false)
                  setEmergencyInput('')
                  setEmergencyError('')
                }}>Cancel</button>
                <button className="btn-confirm" onClick={handleEmergencyOverride}>Verify</button>
              </div>
            </div>
          )}

          {/* Logout button */}
          <button className="btn-gate-logout" onClick={handleLogout}>← Back to Login</button>
        </div>
      </div>
    )
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  return (
    <div className={`dashboard-container theme-${theme}`}>

      {/* Toast notification */}
      {notification && (
        <div className={`notification-container ${notification.isError ? 'error' : 'success'}`}>
          <div className="notification-content">
            <span className="notification-icon">{notification.isError ? '⚠️' : '✅'}</span>
            <span className="notification-text">{notification.message}</span>
          </div>
          <div className="notification-progress"></div>
        </div>
      )}

      {/* ── Zone 3 Full-screen Geo Lockdown Overlay ── */}
      {isGeoLockedDown && (
        <div className="geo-lockdown-overlay">
          <div className="geo-lockdown-card">
            <div className="geo-lockdown-pulse">🌐</div>
            <h2>INTERNATIONAL LOCKDOWN</h2>
            <p className="geo-lockdown-sub">
              Device location detected <strong>outside India</strong>.<br />
              All controls disabled. ESP32 buzzer &amp; LCD LOCKOUT active.
            </p>
            <div className="geo-lockdown-status">
              <span className="geo-status-chip">🔊 Buzzer: ON</span>
              <span className="geo-status-chip">📟 LCD: LOCKOUT</span>
              <span className="geo-status-chip">🚪 Door: SEALED</span>
            </div>
            <button
              className="btn-lockdown-clear"
              onClick={() => {
                setShowLockdownClearModal(true)
                setLockdownClearStep(1)
                setLockdownClearInput('')
                setLockdownClearError('')
              }}
            >
              🔑 Admin Override — Clear Lockdown
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header>
        <div className="header-content">
          <div className="logo-small"><LogoIcon size={32} /><span>Circuit Breakers</span></div>
          <div className="header-actions">
            <span className={`zone-pill ${zm.color}`}>
              {zm.label}
              {geoZone !== null && geoDistance !== null && ` · ${geoDistance.toFixed(0)} km`}
              {sourceLabel && <span className="zone-source-badge">{sourceLabel}</span>}
            </span>
            <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></div>
            <button className="btn-logout" onClick={handleLogout}>Exit</button>
          </div>
        </div>
      </header>

      <main>
        <div className="fade-in">

          {/* RFID Lockout Banner */}
          {isLockedOut && (
            <div className="lockout-banner fade-in">
              <div className="lockout-content">
                <span className="lockout-icon">🚨</span>
                <div>
                  <h3>SECURITY LOCKOUT</h3>
                  <p>System blocked due to multiple failed scan attempts.</p>
                </div>
                <button className="btn-reset" onClick={() => handleSecureAction('clear_lockout')}>
                  Reset System
                </button>
              </div>
            </div>
          )}

          {/* Zone Status Banner */}
          <div className={`zone-banner zone-banner-${geoZone ?? 'null'}`}>
            <span className="zone-banner-icon">{zm.icon}</span>
            <div className="zone-banner-text">
              <strong>
                {zm.label}
                {sourceLabel && <span className="zone-banner-source">{sourceLabel}</span>}
              </strong>
              <span>
                {geoZone === 2 && geoDistance !== null
                  ? `${geoDistance.toFixed(1)} km from home — ${zm.desc}`
                  : zm.desc}
                {geoSource === 'ip' && ' (IP-based — limited trust)'}
                {geoSource === 'emergency' && ' (Emergency override — limited access)'}
              </span>
            </div>
            {geoError && <span className="geo-error-badge">⚠️ {geoError}</span>}
          </div>

          {/* IP / Emergency source warning banner */}
          {(geoSource === 'ip' || geoSource === 'emergency') && (
            <div className="source-warning-banner">
              <span className="source-warning-icon">{geoSource === 'ip' ? '📡' : '🔑'}</span>
              <div className="source-warning-text">
                <strong>
                  {geoSource === 'ip' ? 'IP-Based Location Active' : 'Emergency Override Active'}
                </strong>
                <span>
                  {geoSource === 'ip'
                    ? 'GPS was unavailable. Location determined via IP address. Zone 1 (Home) privileges are disabled. All actions require PIN verification.'
                    : 'Location could not be verified. Access granted via emergency recovery code. Zone 1 (Home) privileges are disabled. All actions require PIN verification.'
                  }
                </span>
              </div>
            </div>
          )}

          {/* Tools Bar */}
          <div className="tools-bar">
            <div className="tool-item">
              <span className="tool-icon">🌡️</span>
              <div className="tool-info">
                <span className="tool-value">{weather.temp.toFixed(1)}°C</span>
                <span className="tool-label">{weather.condition}</span>
              </div>
            </div>
            <div className="tool-item">
              <span className="tool-icon">⏱️</span>
              <div className="tool-info">
                <span className="tool-value">{systemUptime}</span>
                <span className="tool-label">Uptime</span>
              </div>
            </div>
            <div className="flex-spacer"></div>
            <div className="tool-actions">
              <button className={`control-btn-small ${isListening ? 'listening' : ''}`} onClick={toggleVoiceControl}>
                <MicIcon /> {isListening ? 'Listening...' : 'Voice'}
              </button>
              <select className="theme-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="default">Midnight</option>
                <option value="emerald">Forest</option>
                <option value="amber">Sunset</option>
              </select>
            </div>
          </div>

          {/* Status Cards */}
          <div className="status-grid">
            <StatusCard label="RFID Status" value={isLockedOut ? 'LOCKED' : cardStatus} icon={<RFIDIcon />} active={isLockedOut} danger={isLockedOut} />
            <StatusCard label="Fan Status" value={fanStatus ? 'On' : 'Off'} icon={<FanIcon />} active={fanStatus} />
            <StatusCard label="Lights Status" value={lightsStatus ? 'On' : 'Off'} icon={<LightIcon />} active={lightsStatus} />
            <StatusCard label="Door Status" value={doorStatus} icon={<DoorIcon />} active={doorStatus === 'OPEN'} />
          </div>

          <div className="dashboard-columns">
            <div className="column-left">
              <div className="section-card">
                <h2>Controls</h2>
                {(geoZone === 2 || geoSource === 'ip' || geoSource === 'emergency') && (
                  <div className="zone-warning-note">
                    ✈️ <strong>Away Mode</strong> — Security PIN required for all actions
                  </div>
                )}
                <div className="controls-grid">
                  <button
                    className={`control-btn fan-btn ${fanStatus ? 'active' : ''} ${isGeoLockedDown ? 'geo-disabled' : ''}`}
                    onClick={() => handleToggle('fan')}
                  >
                    <FanIcon size={32} /><span>Fan</span>
                  </button>
                  <button
                    className={`control-btn lights-btn ${lightsStatus ? 'active' : ''} ${isGeoLockedDown ? 'geo-disabled' : ''}`}
                    onClick={() => handleToggle('lights')}
                  >
                    <LightIcon size={32} /><span>Lights</span>
                  </button>
                  <button
                    className={`control-btn door-btn ${isGeoLockedDown ? 'geo-disabled' : ''}`}
                    onClick={() => handleSecureAction('open_door')}
                  >
                    <DoorIcon size={32} /><span>Unlock</span>
                  </button>
                </div>
              </div>

              <div className="section-card">
                <h2>Security</h2>
                <div className="list-controls">
                  <button className="list-btn danger" onClick={() => handleSecureAction('disable_card')}>
                    <AlertIcon size={20} /> Report Lost Card
                  </button>
                  <button className="list-btn warning" onClick={() => handleSecureAction('enable_card')}>
                    <ShieldIcon size={20} /> Reactivate Card
                  </button>
                </div>
              </div>
            </div>

            <div className="column-right">
              <div className="section-card h-full">
                <h2>Activity Log</h2>
                <div className="activity-log">
                  {logs.map((log, i) => (
                    <div key={i} className={`activity-item ${log.type}`}>
                      <div className="activity-icon"><ActivityIcon /></div>
                      <div className="activity-content">
                        <span className="activity-text">{log.text}</span>
                        <span className="activity-time">{log.time}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── Standard PIN / Reactivate Modal ── */}
      {showPinModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>{pendingAction === 'enable_card' ? 'Administrator Access' : 'Security Verification'}</h3>

            {/* Zone 2 context hint */}
            {geoZone === 2 && (
              <div className="zone2-modal-hint">
                ✈️ You are <strong>{geoDistance?.toFixed(0)} km</strong> from home (Away Mode).<br />
                Extra verification is active.
              </div>
            )}

            {/* IP/Emergency source hint */}
            {(geoSource === 'ip' || geoSource === 'emergency') && geoZone !== 2 && (
              <div className="zone2-modal-hint">
                {geoSource === 'ip' ? '📡' : '🔑'} Location verified via {geoSource === 'ip' ? 'IP address' : 'emergency override'}.<br />
                Enhanced verification is active.
              </div>
            )}

            <div style={{ textAlign: 'center', marginBottom: '20px', fontSize: '40px' }}>
              {pendingAction === 'enable_card' ? '🗝️' : '🔒'}
            </div>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder={pendingAction === 'enable_card' || pendingAction === 'clear_lockout' ? 'Enter Reactivation Code' : 'Enter PIN'}
              autoFocus
              className="pin-input"
              style={pendingAction === 'enable_card' || pendingAction === 'clear_lockout' ? { letterSpacing: '4px', textTransform: 'uppercase' } : {}}
              onKeyDown={(e) => e.key === 'Enter' && verifyAndExecute()}
            />
            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => setShowPinModal(false)}>Cancel</button>
              <button className="btn-confirm" onClick={verifyAndExecute}>Verify</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Zone 3 Lockdown Clear Modal — Two Layer ── */}
      {showLockdownClearModal && (
        <div className="modal-overlay">
          <div className="modal-content lockdown-clear-modal">
            <h3>🌐 Admin Override</h3>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginBottom: '16px', fontSize: '14px' }}>
              Two-layer verification required to clear International Lockdown
            </p>

            {/* Step indicator */}
            <div className="lockdown-steps">
              <div className={`lockdown-step ${lockdownClearStep >= 1 ? 'step-active' : ''} ${lockdownClearStep > 1 ? 'step-done' : ''}`}>
                {lockdownClearStep > 1 ? '✅' : '🔒'} Layer 1
              </div>
              <div className="lockdown-step-arrow">→</div>
              <div className={`lockdown-step ${lockdownClearStep >= 2 ? 'step-active' : ''}`}>
                🗝️ Layer 2
              </div>
            </div>

            <p className="lockdown-step-label">
              {lockdownClearStep === 1 ? 'Enter Security PIN' : 'Enter Reactivation Key'}
            </p>
            <input
              type="password"
              value={lockdownClearInput}
              onChange={(e) => setLockdownClearInput(e.target.value)}
              placeholder={lockdownClearStep === 1 ? 'Security PIN' : 'Reactivation Code'}
              autoFocus
              className="pin-input"
              style={lockdownClearStep === 2 ? { letterSpacing: '4px', textTransform: 'uppercase' } : {}}
              onKeyDown={(e) => e.key === 'Enter' && handleLockdownClearInput()}
            />
            {lockdownClearError && <p className="lockdown-error">{lockdownClearError}</p>}
            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => {
                setShowLockdownClearModal(false)
                setLockdownClearStep(1)
                setLockdownClearInput('')
                setLockdownClearError('')
              }}>Cancel</button>
              <button className="btn-confirm" onClick={handleLockdownClearInput}>
                {lockdownClearStep === 1 ? 'Next →' : '🔓 Clear Lockdown'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function StatusCard({ label, value, icon, active, danger }) {
  return (
    <div className={`status-card ${active ? 'active' : ''} ${danger ? 'danger' : ''}`}>
      <div className="status-icon">{icon}</div>
      <div className="status-info">
        <span className="status-label">{label}</span>
        <span className="status-value">{value}</span>
      </div>
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────────────────
const LogoIcon = ({ size = 60 }) => (
  <svg width={size} height={size} viewBox="0 0 60 60" fill="none">
    <path d="M30 5L5 22.5V50H55V22.5L30 5Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
    <path d="M20 50V32H40V50" stroke="currentColor" strokeWidth="3" />
    <circle cx="35" cy="40" r="2" fill="currentColor" />
  </svg>
)
const RFIDIcon = () => (<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M7 11V7C7 4.79086 8.79086 3 11 3H13C15.2091 3 17 4.79086 17 7V11" stroke="currentColor" strokeWidth="2" /></svg>)
const FanIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 6V12L16 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>)
const LightIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 3V6M12 18V21M6 12H3M21 12H18M7.05 7.05L4.93 4.93M19.07 4.93L16.95 7.05M7.05 16.95L4.93 19.07M19.07 19.07L16.95 16.95" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" /></svg>)
const DoorIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="12" height="18" rx="1" stroke="currentColor" strokeWidth="2" /><circle cx="13" cy="12" r="1" fill="currentColor" /><path d="M16 12H20M18 10L20 12L18 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const AlertIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V12C3 16.97 6.84 21.44 12 22C17.16 21.44 21 16.97 21 12V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /> <path d="M12 8V12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M12 16H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>)
const ShieldIcon = ({ size = 24 }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V12C3 16.97 6.84 21.44 12 22C17.16 21.44 21 16.97 21 12V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M9 12L11 14L15 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const ActivityIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" /></svg>)
const MicIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>)
