'use client'

import { useState, useEffect, useRef } from 'react'
import mqtt from 'mqtt'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt'
const MQTT_TOPIC_CMD = 'breakerbot/cmd'
const MQTT_TOPIC_STATUS = 'breakerbot/status'
const MQTT_TOPIC_LOG = 'breakerbot/log'
const ACCESS_CODE = 'circuit'
const SECURITY_PIN = 'circuit'
const REACTIVATE_CODE = 'CBMA'

export default function Home() {
  // Session State
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [accessCodeInput, setAccessCodeInput] = useState('')
  const [loginError, setLoginError] = useState('')
  const [isShake, setIsShake] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')

  // Device State
  const [connected, setConnected] = useState(false)
  const [doorStatus, setDoorStatus] = useState('CLOSED')
  const [cardStatus, setCardStatus] = useState('ACTIVE')
  const [fanStatus, setFanStatus] = useState(false)
  const [lightsStatus, setLightsStatus] = useState(false)
  const [isLockedOut, setIsLockedOut] = useState(false)
  const [logs, setLogs] = useState([])

  // Analytics State
  const [energyData, setEnergyData] = useState([])
  const [currentLoad, setCurrentLoad] = useState(0)

  // Feature State
  const [isListening, setIsListening] = useState(false)
  const [theme, setTheme] = useState('default')
  const [weather, setWeather] = useState({ temp: 24, condition: 'Cloudy', humidity: 65 })
  const [sysHealth, setSysHealth] = useState({ uptime: '0h 0m', signal: 'Excellent' })

  // UI State
  const [pinInput, setPinInput] = useState('')
  const [showPinModal, setShowPinModal] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [notification, setNotification] = useState(null)
  const [loading, setLoading] = useState({})

  const clientRef = useRef(null)
  const startTime = useRef(Date.now())

  // Initialize Session & Theme
  useEffect(() => {
    const session = sessionStorage.getItem('smartHomeSession')
    if (session === 'active') {
      setIsLoggedIn(true)
    }
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // System Health Timer
  useEffect(() => {
    const interval = setInterval(() => {
      const diff = Date.now() - startTime.current
      const hours = Math.floor(diff / 3600000)
      const minutes = Math.floor((diff % 3600000) / 60000)
      setSysHealth(prev => ({ ...prev, uptime: `${hours}h ${minutes}m` }))
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // Live Energy Data Generation
  useEffect(() => {
    // Generate initial history
    const initialData = []
    const now = new Date()
    for (let i = 20; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 5000)
      initialData.push({
        time: time.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        usage: 20 + Math.random() * 10
      })
    }
    setEnergyData(initialData)

    const interval = setInterval(() => {
      // Calculate load based on devices
      let load = 20 // Base load
      if (fanStatus) load += 80
      if (lightsStatus) load += 40

      // Add some random fluctuation
      load += (Math.random() * 5 - 2.5)

      setCurrentLoad(Math.round(load))

      setEnergyData(prev => {
        const newPoint = {
          time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          usage: Math.round(load)
        }
        return [...prev.slice(1), newPoint]
      })
    }, 2000) // Update every 2 seconds

    return () => clearInterval(interval)
  }, [fanStatus, lightsStatus])

  // MQTT Connection
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
      setSysHealth(prev => ({ ...prev, signal: 'Excellent (24ms)' }))
    })

    client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString())
        if (topic === MQTT_TOPIC_STATUS) {
          if (data.door !== undefined) setDoorStatus(data.door)
          if (data.card !== undefined) setCardStatus(data.card)
          if (data.fan !== undefined) setFanStatus(data.fan)
          if (data.lights !== undefined) setLightsStatus(data.lights)
          if (data.lockout !== undefined) setIsLockedOut(data.lockout)
        }
        if (topic === MQTT_TOPIC_LOG) {
          addLog(data.action || 'Event', data.success !== false ? 'success' : 'error')
        }
      } catch (e) {
        console.error('Parse error:', e)
      }
    })

    client.on('disconnect', () => {
      setConnected(false)
      setSysHealth(prev => ({ ...prev, signal: 'Disconnected' }))
    })

    clientRef.current = client
    return () => client.end()
  }, [isLoggedIn])

  // Login Handler
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

  // Voice Control
  const toggleVoiceControl = () => {
    if (!('webkitSpeechRecognition' in window)) {
      showNotification('Voice not supported on this browser', true)
      return
    }

    if (isListening) {
      setIsListening(false)
      return
    }

    const recognition = new window.webkitSpeechRecognition()
    recognition.continuous = false
    recognition.lang = 'en-US'
    recognition.interimResults = false

    recognition.onstart = () => {
      setIsListening(true)
      showNotification('Listening...', false)
    }

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

  // Command Helpers
  const sendCommand = (action, device = null) => {
    if (clientRef.current && connected) {
      clientRef.current.publish(MQTT_TOPIC_CMD, JSON.stringify({ action }))

      // Optimistic Updates
      if (device === 'fan') {
        const newState = !fanStatus
        setFanStatus(newState)
        addLog(`Fan turned ${newState ? 'ON' : 'OFF'}`, 'info')
      }
      if (device === 'lights') {
        const newState = !lightsStatus
        setLightsStatus(newState)
        addLog(`Lights turned ${newState ? 'ON' : 'OFF'}`, 'info')
      }
      if (action === 'disable_card') {
        setCardStatus('DISABLED')
        addLog('RFID Card Disabled', 'error')
      }
    } else {
      showNotification('System offline', true)
    }
  }

  const handleSecureAction = (action) => {
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
        setTimeout(() => setDoorStatus('OPEN'), 1000)
        setTimeout(() => {
          setDoorStatus('CLOSED')
          addLog('Door Closed automatically', 'info')
        }, 5000)
      } else if (pendingAction === 'enable_card') {
        setCardStatus('ACTIVE')
        addLog('RFID Card Reactivated', 'success')
      } else if (pendingAction === 'disable_card') {
        setCardStatus('DISABLED')
      } else if (pendingAction === 'clear_lockout') {
        setIsLockedOut(false)
        addLog('Security Lockout Cleared', 'success')
      }

      sendCommand(pendingAction)
      setShowPinModal(false)
      setPendingAction(null)
      showNotification('Access Granted', false)
    } else {
      showNotification('Access Denied', true)
      addLog('Failed Access Attempt', 'error')
    }
    setPinInput('')
  }

  const handleToggle = (device) => {
    if (loading[device]) return
    setLoading(prev => ({ ...prev, [device]: true }))

    if (device === 'fan') sendCommand('toggle_fan', 'fan')
    if (device === 'lights') sendCommand('toggle_lights', 'lights')

    setTimeout(() => {
      setLoading(prev => ({ ...prev, [device]: false }))
    }, 600)
  }

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

  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className={`login-card ${isShake ? 'shake' : ''}`} style={isShake ? { animation: 'shake 0.5s ease' } : {}}>
          <div className="logo">
            <div className="logo-icon"><LogoIcon /></div>
            <h1>Smart Home</h1>
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

  return (
    <div className={`dashboard-container theme-${theme}`}>
      {notification && (
        <div className="notification" style={{ background: notification.isError ? '#ef4444' : '#10b981' }}>
          {notification.message}
        </div>
      )}

      <header>
        <div className="header-content">
          <div className="logo-small"><LogoIcon size={32} /><span>BreakerBot</span></div>
          <div className="header-actions">
            <button className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>Overview</button>
            <button className={`nav-btn ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>Insights</button>
            <div className="connection-status">
              <div className={`status-dot ${connected ? 'connected' : 'disconnected'}`}></div>
            </div>
            <button className="btn-logout" onClick={handleLogout}>Exit</button>
          </div>
        </div>
      </header>

      <main>
        {activeTab === 'dashboard' && (
          <div className="fade-in">
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

            {/* Tools Bar */}
            <div className="tools-bar">
              <div className="widget-mini">
                <span>🌡️ {weather.temp}°C</span>
                <span className="text-muted">{weather.condition}</span>
              </div>
              <div className="flex-spacer"></div>
              <button className={`control-btn-small ${isListening ? 'listening' : ''}`} onClick={toggleVoiceControl}>
                <MicIcon /> {isListening ? 'Listening...' : 'Voice'}
              </button>
              <select className="theme-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="default">Midnight</option>
                <option value="emerald">Forest</option>
                <option value="amber">Sunset</option>
              </select>
            </div>

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
                  <div className="controls-grid">
                    <button className={`control-btn fan-btn ${fanStatus ? 'active' : ''}`} onClick={() => handleToggle('fan')}>
                      <FanIcon size={32} /><span>Fan</span>
                    </button>
                    <button className={`control-btn lights-btn ${lightsStatus ? 'active' : ''}`} onClick={() => handleToggle('lights')}>
                      <LightIcon size={32} /><span>Lights</span>
                    </button>
                    <button className="control-btn door-btn" onClick={() => handleSecureAction('open_door')}>
                      <DoorIcon size={32} /><span>Unlock</span>
                    </button>
                  </div>
                </div>

                <div className="section-card">
                  <h2>Security</h2>
                  <div className="list-controls">
                    <button className="list-btn danger" onClick={() => {
                      if (confirm('Report card as lost? This will disable access.')) sendCommand('disable_card')
                    }}>
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
        )}

        {activeTab === 'analytics' && (
          <div className="fade-in">
            <div className="analytics-header">
              <div className="metric-card">
                <h3>Current Load</h3>
                <p className="metric-value">{currentLoad}W</p>
                <p className="metric-label">Live Usage</p>
              </div>
              <div className="metric-card">
                <h3>System Health</h3>
                <p className="metric-value">{sysHealth.signal}</p>
                <p className="metric-label">Uptime: {sysHealth.uptime}</p>
              </div>
            </div>

            <div className="glass-panel" style={{ padding: '2rem', marginTop: '20px' }}>
              <h2 style={{ marginBottom: '20px' }}>Live Power Consumption</h2>
              <div style={{ height: '400px', width: '100%' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={energyData}>
                    <defs>
                      <linearGradient id="colorUsage" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="time" stroke="#94a3b8" />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', color: '#f1f5f9' }}
                      itemStyle={{ color: '#818cf8' }}
                    />
                    <Area type="monotone" dataKey="usage" stroke="var(--primary)" fillOpacity={1} fill="url(#colorUsage)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </main>

      {showPinModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>{pendingAction === 'enable_card' ? 'Administrator Access' : 'Security Verification'}</h3>
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

// Icons
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
