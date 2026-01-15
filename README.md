# ⚡ Circuit Breakers Web Dashboard

![Status](https://img.shields.io/badge/Status-Online-success)
![Next.js](https://img.shields.io/badge/Built%20With-Next.js-black)
![License](https://img.shields.io/badge/License-MIT-blue)

A premium, glassmorphism-styled web dashboard for the **Circuit Breakers Smart Home System**. This application provides real-time monitoring and secure control of IoT devices (lights, fans, door locks, RFID) using MQTT over WebSockets.

## ✨ Features

- **🎨 Modern Aesthetic:** Glassmorphism UI with animated backgrounds, blur effects, and smooth transitions.
- **⚡ Real-time Updates:** Instant status synchronization via MQTT (WebSockets).
- **🔒 Secure Access:** 
  - Login system with Session control.
  - PIN verification for critical actions (Door Open, Card Management).
- **📱 PWA Ready:** Installable as a native-like app on Android/iOS.
- **📊 Activity Log:** Visual log of all system events (Access granted, Fan toggled, etc.).
- **🛠 Manual Controls:** Direct toggle of appliances and security reporting.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ installed
- An MQTT Broker (using HiveMQ Public Broker by default)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/breakerbot-web.git
   cd breakerbot-web
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
   *Edit `.env.local` if you need to change the Security PIN.*

4. **Run Development Server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## 🛠 Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_MQTT_BROKER` | WebSocket URL for MQTT Broker | `wss://broker.hivemq.com:8884/mqtt` |
| `NEXT_PUBLIC_SECURITY_PIN` | PIN for critical actions | `1234` |

## 📦 Build for Production

To create an optimized production build:

```bash
npm run build
npm start
```

## 📱 PWA Support

This app works as a Progressive Web App. You can "Add to Home Screen" on your mobile device to use it like a native app.

## 📄 License

This project is licensed under the MIT License.
