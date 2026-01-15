'use client'

import { useState, useEffect, useRef } from 'react'
import mqtt from 'mqtt'

const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt'
const MQTT_TOPIC_CMD = 'breakerbot/cmd'
const MQTT_TOPIC_STATUS = 'breakerbot/status'
const MQTT_TOPIC_LOG = 'breakerbot/log'
const ACCESS_CODE = 'CBMA'
const SECURITY_PIN = process.env.NEXT_PUBLIC_SECURITY_PIN || '1234'

export default function Home() {
  // Session State
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [accessCodeInput, setAccessCodeInput] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isShake, setIsShake] = useState(false)

  // Device State
  const [connected, setConnected] = useState(false)
  const [doorStatus, setDoorStatus] = useState('CLOSED')
  const [cardStatus, setCardStatus] = useState('ACTIVE')
  const [fanStatus, setFanStatus] = useState(false)
  const [lightsStatus, setLightsStatus] = useState(false)
  const [logs, setLogs] = useState([])

  // UI State
  const [pinInput, setPinInput] = useState('')
  const [showPinModal, setShowPinModal] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [notification, setNotification] = useState(null)

  const clientRef = useRef(null)

  // Initialize Session
  useEffect(() => {
    const session = sessionStorage.getItem('smartHomeSession')
    if (session === 'active') {
      setIsLoggedIn(true)
    }
  }, [])

  // MQTT Connection (Only when logged in)
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
      addLog('Dashboard loaded', 'success')
    })

    client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString())

        if (topic === MQTT_TOPIC_STATUS) {
          if (data.door !== undefined) setDoorStatus(data.door)
          if (data.card !== undefined) setCardStatus(data.card)
          if (data.fan !== undefined) setFanStatus(data.fan)
          if (data.lights !== undefined) setLightsStatus(data.lights)
        }

        if (topic === MQTT_TOPIC_LOG) {
          addLog(data.action || 'Event', data.success !== false ? 'success' : 'error')
        }
      } catch (e) {
        console.error('Parse error:', e)
      }
    })

    client.on('disconnect', () => setConnected(false))
    client.on('error', (err) => console.error('MQTT error:', err))

    clientRef.current = client

    return () => {
      client.end()
    }
  }, [isLoggedIn])

  // Login Handler
  const handleLogin = (e) => {
    e.preventDefault()
    if (accessCodeInput === ACCESS_CODE) {
      setIsLoggedIn(true)
      sessionStorage.setItem('smartHomeSession', 'active')
      setLoginError('')
    } else {
      setLoginError('Invalid access code. Please try again.')
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

  // Command Helpers
  // Button Loading States
  const [loading, setLoading] = useState({})

  // Command Helpers
  const sendCommand = (action, device = null) => {
    if (clientRef.current && connected) {
      clientRef.current.publish(MQTT_TOPIC_CMD, JSON.stringify({ action }))

      // Optimistic Updates
      if (device === 'fan') {
        setFanStatus(prev => !prev)
      } else if (device === 'lights') {
        setLightsStatus(prev => !prev)
      }
    } else {
      showNotification('Not connected to device', true)
    }
  }

  const handleSecureAction = (action) => {
    setPendingAction(action)
    setShowPinModal(true)
    setPinInput('')
  }

  const verifyAndExecute = () => {
    if (pinInput === SECURITY_PIN) {
      if (pendingAction === 'open_door') {
        setDoorStatus('OPENING...')
        setTimeout(() => setDoorStatus('OPEN'), 1000)
        setTimeout(() => setDoorStatus('CLOSED'), 5000)
      }

      sendCommand(pendingAction)
      setShowPinModal(false)
      setPendingAction(null)
      showNotification('Command executed successfully', false)
    } else {
      showNotification('Wrong PIN! Access denied', true)
    }
    setPinInput('')
  }

  const handleToggle = (device) => {
    if (loading[device]) return

    setLoading(prev => ({ ...prev, [device]: true }))

    if (device === 'fan') sendCommand('toggle_fan', 'fan')
    if (device === 'lights') sendCommand('toggle_lights', 'lights')

    // Fake loading delay for visual feedback
    setTimeout(() => {
      setLoading(prev => ({ ...prev, [device]: false }))
    }, 600)
  }

  // Logs & Notifications
  const addLog = (text, type = 'info') => {
    setLogs(prev => [{
      text,
      type,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }, ...prev].slice(0, 50))
  }

  const showNotification = (message, isError = false) => {
    setNotification({ message, isError })
    setTimeout(() => setNotification(null), 3000)
  }

  // Render Login Page
  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className={`login-card ${isShake ? 'shake' : ''}`} style={isShake ? { animation: 'shake 0.5s ease' } : {}}>
          <div className="logo">
            <div className="logo-icon">
              <svg width="60" height="60" viewBox="0 0 60 60" fill="none">
                <path d="M30 5L5 22.5V50H55V22.5L30 5Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                <path d="M20 50V32H40V50" stroke="currentColor" strokeWidth="3" />
                <circle cx="35" cy="40" r="2" fill="currentColor" />
              </svg>
            </div>
            <h1>Smart Home</h1>
          </div>
          <p className="subtitle">Enter access code to continue</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Access Code"
              maxLength="4"
              autoComplete="off"
              value={accessCodeInput}
              onChange={(e) => setAccessCodeInput(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary">Access Dashboard</button>
          </form>
          <p className="error-message">{loginError}</p>
        </div>
      </div>
    )
  }

  // Render Dashboard
  return (
    <div className="dashboard-container">
      {notification && (
        <div
          className="notification"
          style={{
            background: notification.isError ?
              'linear-gradient(135deg, #ef4444, #dc2626)' :
              'linear-gradient(135deg, #10b981, #059669)'
          }}
        >
          {notification.message}
        </div>
      )}

      <header>
        <div className="header-content">
          <div className="logo-small">
            <svg width="32" height="32" viewBox="0 0 60 60" fill="none">
              <path d="M30 5L5 22.5V50H55V22.5L30 5Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
              <path d="M20 50V32H40V50" stroke="currentColor" strokeWidth="3" />
              <circle cx="35" cy="40" r="2" fill="currentColor" />
            </svg>
            <span>Smart Home</span>
          </div>
          <div className="header-actions">
            <div className="connection-status">
              <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></div>
              <span>{connected ? 'Connected' : 'Connecting...'}</span>
            </div>
            <button className="btn-logout" onClick={handleLogout}>Logout</button>
          </div>
        </div>
      </header>

      <main>
        {/* Status Grid */}
        <div className="status-grid">
          <StatusCard
            label="RFID Status"
            value={cardStatus}
            icon={<RFIDIcon />}
          />
          <StatusCard
            label="Fan Status"
            value={fanStatus ? 'On' : 'Off'}
            icon={<FanIcon />}
          />
          <StatusCard
            label="Lights Status"
            value={lightsStatus ? 'On' : 'Off'}
            icon={<LightIcon />}
          />
          <StatusCard
            label="Door Status"
            value={doorStatus}
            icon={<DoorIcon />}
          />
        </div>

        {/* Manual Controls */}
        <div className="controls-section">
          <h2>Manual Controls</h2>
          <div className="controls-grid">
            <button className="control-btn fan-btn" onClick={() => handleToggle('fan')}>
              <FanIcon size={32} />
              <span>Toggle Fan</span>
            </button>
            <button className="control-btn lights-btn" onClick={() => handleToggle('lights')}>
              <LightIcon size={32} />
              <span>Toggle Lights</span>
            </button>
          </div>
        </div>

        {/* Door Control */}
        <div className="controls-section">
          <h2>Door Control</h2>
          <button className="control-btn door-btn" onClick={() => handleSecureAction('open_door')}>
            <DoorIcon size={32} />
            <span>Open Door</span>
          </button>
        </div>

        {/* Security Controls */}
        <div className="controls-section">
          <h2>Security</h2>
          <div className="controls-grid">
            <button className="control-btn danger-btn" onClick={() => {
              if (confirm('Are you sure you want to report the card as lost?')) sendCommand('disable_card')
            }}>
              <AlertIcon size={32} />
              <span>Report Lost Card</span>
            </button>

            <button className="control-btn warning-btn" onClick={() => handleSecureAction('enable_card')}>
              <ShieldIcon size={32} />
              <span>Reactivate Card</span>
            </button>
          </div>
        </div>

        {/* Activity Log */}
        <div className="controls-section">
          <h2>Recent Activity</h2>
          <div className="activity-log">
            {logs.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: '20px' }}>No recent activity</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className={`activity-item ${log.type}`}>
                  <div className="activity-icon">
                    <ActivityIcon />
                  </div>
                  <div className="activity-content">
                    <span className="activity-text">{log.text}</span>
                    <span className="activity-time">{log.time}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* PIN Modal */}
      {showPinModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Security Check</h3>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder="Enter PIN"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && verifyAndExecute()}
            />
            <div className="modal-buttons">
              <button className="btn-secondary" onClick={() => setShowPinModal(false)}>Cancel</button>
              <button className="btn-confirm" onClick={verifyAndExecute}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Components
function StatusCard({ label, value, icon }) {
  return (
    <div className="status-card">
      <div className="status-icon">
        {icon}
      </div>
      <div className="status-info">
        <span className="status-label">{label}</span>
        <span className="status-value">{value}</span>
      </div>
    </div>
  )
}

// Icons
const RFIDIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M7 11V7C7 4.79086 8.79086 3 11 3H13C15.2091 3 17 4.79086 17 7V11" stroke="currentColor" strokeWidth="2" />
  </svg>
)

const FanIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 6V12L16 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

const LightIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 3V6M12 18V21M6 12H3M21 12H18M7.05 7.05L4.93 4.93M19.07 4.93L16.95 7.05M7.05 16.95L4.93 19.07M19.07 19.07L16.95 16.95" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
  </svg>
)

const DoorIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="4" y="3" width="12" height="18" rx="1" stroke="currentColor" strokeWidth="2" />
    <circle cx="13" cy="12" r="1" fill="currentColor" />
    <path d="M16 12H20M18 10L20 12L18 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const AlertIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 2L3 7V12C3 16.97 6.84 21.44 12 22C17.16 21.44 21 16.97 21 12V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M9 12L11 14L15 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ShieldIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 2L3 7V12C3 16.97 6.84 21.44 12 22C17.16 21.44 21 16.97 21 12V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 8V12M12 16H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

const ActivityIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
  </svg>
)
