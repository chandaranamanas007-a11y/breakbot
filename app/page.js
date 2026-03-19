'use client'

import { useState, useEffect, useRef } from 'react'
import mqtt from 'mqtt'

const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt'
const MQTT_TOPIC_CMD = 'breakerbot/cmd'
const MQTT_TOPIC_STATUS = 'breakerbot/status'
const MQTT_TOPIC_LOG = 'breakerbot/log'
const ACCESS_CODE = 'circuit'
const SECURITY_PIN = 'circuit'
const REACTIVATE_CODE = 'CBMA'

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
  }, [isLoggedIn])

  // ── Geolocation Watcher ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoggedIn) return
    if (!navigator?.geolocation) {
      setGeoError('Geolocation not supported by this browser')
      return
    }

    const onPosition = (pos) => {
      const { latitude, longitude } = pos.coords
      const distance = haversineDistance(HOME_LAT, HOME_LON, latitude, longitude)
      const zone = classifyZone(latitude, longitude)

      setGeoDistance(distance)
      setGeoError(null)

      if (lastZoneRef.current !== zone) {
        lastZoneRef.current = zone
        setGeoZone(zone)

        if (zone === 1) {
          addLog(`📍 Zone 1 — Home vicinity (${distance.toFixed(1)} km)`, 'success')
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_home', distance_km: distance.toFixed(1) })
          )
        } else if (zone === 2) {
          addLog(`✈️ Zone 2 — Away (${distance.toFixed(1)} km from home)`, 'info')
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_away', distance_km: distance.toFixed(1) })
          )
        } else if (zone === 3) {
          addLog('🌐🚨 Zone 3 — INTERNATIONAL LOCKDOWN ACTIVATED', 'error')
          setIsGeoLockedDown(true)
          clientRef.current?.publish(
            MQTT_TOPIC_CMD,
            JSON.stringify({ action: 'zone_lockdown' })
          )
        }
      }
    }

    const onError = (err) => setGeoError(err.message)

    const watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    })
    return () => navigator.geolocation.clearWatch(watchId)
  }, [isLoggedIn])
  // ─────────────────────────────────────────────────────────────────────────

  // Login
  const handleLogin = (e) => {
    e.preventDefault()
    if (accessCodeInput === ACCESS_CODE) {
      setIsLoggedIn(true)
      sessionStorage.setItem('smartHomeSession', 'active')
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
    sessionStorage.removeItem('smartHomeSession')
    setAccessCodeInput('')
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

  const verifyAndExecute = () => {
    const isSpecialAction = pendingAction === 'enable_card' || pendingAction === 'clear_lockout'
    const correctPassword = isSpecialAction ? REACTIVATE_CODE : SECURITY_PIN
    if (pinInput === correctPassword) {
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
  const handleLockdownClearInput = () => {
    setLockdownClearError('')
    if (lockdownClearStep === 1) {
      if (lockdownClearInput === SECURITY_PIN) {
        setLockdownClearStep(2)
        setLockdownClearInput('')
        addLog('Lockdown clear — Layer 1 verified', 'info')
      } else {
        setLockdownClearError('Incorrect Security PIN.')
        addLog('Failed lockdown clear — Layer 1', 'error')
        setLockdownClearInput('')
      }
    } else {
      if (lockdownClearInput === REACTIVATE_CODE) {
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

  const addLog = (text, type = 'info') => {
    setLogs((prev) =>
      [{ text, type, time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) }, ...prev].slice(0, 50)
    )
  }

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
              <strong>{zm.label}</strong>
              <span>
                {geoZone === 2 && geoDistance !== null
                  ? `${geoDistance.toFixed(1)} km from home — ${zm.desc}`
                  : zm.desc}
              </span>
            </div>
            {geoError && <span className="geo-error-badge">⚠️ {geoError}</span>}
          </div>

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
                {geoZone === 2 && (
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

            <div style={{ textAlign: 'center', marginBottom: '20px', fontSize: '40px' }}>
              {pendingAction === 'enable_card' ? '🗝️' : '🔒'}
            </div>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder={pendingAction === 'enable_card' ? 'Enter Code (CBMA)' : 'Enter PIN'}
              autoFocus
              className="pin-input"
              style={pendingAction === 'enable_card' ? { letterSpacing: '4px', textTransform: 'uppercase' } : {}}
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
              {lockdownClearStep === 1 ? 'Enter Security PIN' : 'Enter Reactivation Key (CBMA)'}
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
