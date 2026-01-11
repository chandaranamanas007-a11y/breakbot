'use client'

import { useState, useEffect, useRef } from 'react'
import mqtt from 'mqtt'

const MQTT_BROKER = process.env.NEXT_PUBLIC_MQTT_BROKER || 'wss://broker.hivemq.com:8884/mqtt'
const MQTT_TOPIC_CMD = 'breakerbot/cmd'
const MQTT_TOPIC_STATUS = 'breakerbot/status'
const MQTT_TOPIC_LOG = 'breakerbot/log'
const SECURITY_PIN = process.env.NEXT_PUBLIC_SECURITY_PIN || '1234'

export default function Home() {
  const [connected, setConnected] = useState(false)
  const [doorStatus, setDoorStatus] = useState('CLOSED')
  const [cardStatus, setCardStatus] = useState('ACTIVE')
  const [logs, setLogs] = useState([])
  const [pinInput, setPinInput] = useState('')
  const [showPinModal, setShowPinModal] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const clientRef = useRef(null)

  useEffect(() => {
    const client = mqtt.connect(MQTT_BROKER, {
      clientId: 'breakerbot_web_' + Math.random().toString(16).slice(2, 8),
      clean: true,
      reconnectPeriod: 5000,
    })

    client.on('connect', () => {
      setConnected(true)
      client.subscribe([MQTT_TOPIC_STATUS, MQTT_TOPIC_LOG])
      client.publish(MQTT_TOPIC_CMD, JSON.stringify({ action: 'get_status' }))
    })

    client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString())

        if (topic === MQTT_TOPIC_STATUS) {
          if (data.door !== undefined) setDoorStatus(data.door)
          if (data.card !== undefined) setCardStatus(data.card)
        }

        if (topic === MQTT_TOPIC_LOG) {
          setLogs(prev => [{
            time: new Date().toLocaleString(),
            source: data.source || 'Unknown',
            action: data.action || 'Access',
            success: data.success !== false
          }, ...prev].slice(0, 50))
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
  }, [])

  const sendCommand = (action) => {
    if (clientRef.current && connected) {
      clientRef.current.publish(MQTT_TOPIC_CMD, JSON.stringify({ action }))
    }
  }

  const handleSecureAction = (action) => {
    setPendingAction(action)
    setShowPinModal(true)
    setPinInput('')
  }

  const verifyAndExecute = () => {
    if (pinInput === SECURITY_PIN) {
      sendCommand(pendingAction)
      setShowPinModal(false)
      setPendingAction(null)
    } else {
      alert('Wrong PIN!')
    }
    setPinInput('')
  }

  const handleDisableCard = () => {
    if (confirm('Are you sure you want to disable the card? This will report it as lost.')) {
      sendCommand('disable_card')
    }
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>BreakerBot Security</h1>

      <div style={styles.connectionStatus}>
        <span style={{
          ...styles.statusDot,
          backgroundColor: connected ? '#4CAF50' : '#f44336'
        }}></span>
        {connected ? 'Connected' : 'Disconnected'}
      </div>

      <div style={styles.statusCard}>
        <h2 style={styles.statusTitle}>System Status</h2>
        <div style={styles.statusRow}>
          <span>Door:</span>
          <span style={{
            color: doorStatus === 'OPEN' ? '#4CAF50' : '#888'
          }}>{doorStatus}</span>
        </div>
        <div style={styles.statusRow}>
          <span>RFID Card:</span>
          <span style={{
            color: cardStatus === 'ACTIVE' ? '#4CAF50' : '#f44336'
          }}>{cardStatus}</span>
        </div>
      </div>

      <div style={styles.controls}>
        <button
          style={{...styles.btn, ...styles.btnOpen}}
          onClick={() => handleSecureAction('open_door')}
          disabled={!connected}
        >
          Open Door
        </button>

        <button
          style={{...styles.btn, ...styles.btnDanger}}
          onClick={handleDisableCard}
          disabled={!connected}
        >
          Report Lost Card
        </button>

        <button
          style={{...styles.btn, ...styles.btnWarn}}
          onClick={() => handleSecureAction('enable_card')}
          disabled={!connected}
        >
          Reactivate Card
        </button>
      </div>

      <div style={styles.logsSection}>
        <h2 style={styles.logsTitle}>Access Logs</h2>
        <div style={styles.logsList}>
          {logs.length === 0 ? (
            <p style={styles.noLogs}>No access logs yet</p>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{
                ...styles.logItem,
                borderLeft: `4px solid ${log.success ? '#4CAF50' : '#f44336'}`
              }}>
                <div style={styles.logTime}>{log.time}</div>
                <div style={styles.logAction}>
                  {log.success ? '✅' : '🚨'} {log.action} via {log.source}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showPinModal && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3>Security Check</h3>
            <p>Enter PIN to proceed:</p>
            <input
              type="password"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              style={styles.pinInput}
              placeholder="Enter PIN"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && verifyAndExecute()}
            />
            <div style={styles.modalButtons}>
              <button
                style={{...styles.btn, ...styles.btnOpen, width: 'auto'}}
                onClick={verifyAndExecute}
              >
                Confirm
              </button>
              <button
                style={{...styles.btn, ...styles.btnCancel, width: 'auto'}}
                onClick={() => setShowPinModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backgroundColor: '#1a1a2e',
    minHeight: '100vh',
    color: 'white',
    padding: '20px',
  },
  title: {
    textAlign: 'center',
    fontSize: '28px',
    marginBottom: '10px',
  },
  connectionStatus: {
    textAlign: 'center',
    marginBottom: '20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
  },
  statusDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    display: 'inline-block',
  },
  statusCard: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '20px',
    marginBottom: '20px',
  },
  statusTitle: {
    margin: '0 0 15px 0',
    fontSize: '18px',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 0',
    borderBottom: '1px solid #333',
  },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    marginBottom: '20px',
  },
  btn: {
    border: 'none',
    color: 'white',
    padding: '16px 24px',
    fontSize: '16px',
    cursor: 'pointer',
    borderRadius: '8px',
    width: '100%',
    fontWeight: '600',
  },
  btnOpen: {
    backgroundColor: '#4CAF50',
  },
  btnDanger: {
    backgroundColor: '#f44336',
  },
  btnWarn: {
    backgroundColor: '#ff9800',
    color: 'black',
  },
  btnCancel: {
    backgroundColor: '#666',
  },
  logsSection: {
    backgroundColor: '#16213e',
    borderRadius: '12px',
    padding: '20px',
  },
  logsTitle: {
    margin: '0 0 15px 0',
    fontSize: '18px',
  },
  logsList: {
    maxHeight: '300px',
    overflowY: 'auto',
  },
  noLogs: {
    color: '#888',
    textAlign: 'center',
  },
  logItem: {
    backgroundColor: '#1a1a2e',
    padding: '12px',
    marginBottom: '8px',
    borderRadius: '6px',
  },
  logTime: {
    fontSize: '12px',
    color: '#888',
  },
  logAction: {
    fontSize: '14px',
    marginTop: '4px',
  },
  modal: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modalContent: {
    backgroundColor: '#16213e',
    padding: '30px',
    borderRadius: '12px',
    textAlign: 'center',
    width: '90%',
    maxWidth: '300px',
  },
  pinInput: {
    width: '100%',
    padding: '12px',
    fontSize: '18px',
    borderRadius: '6px',
    border: 'none',
    marginBottom: '15px',
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  modalButtons: {
    display: 'flex',
    gap: '10px',
    justifyContent: 'center',
  },
}
