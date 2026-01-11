# BreakerBot Web Dashboard

Control your ESP32 Smart Access system from anywhere via the internet.

## Setup Instructions

### 1. Set Up HiveMQ Cloud (Free MQTT Broker)

1. Go to [HiveMQ Cloud](https://www.hivemq.com/cloud/) and sign up for free
2. Create a new cluster (free tier is fine)
3. Once created, note down:
   - **Cluster URL**: Something like `abc123.s1.eu.hivemq.cloud`
   - **Port**: `8883` (TLS) for ESP32, `8884` (WebSocket TLS) for web
4. Go to "Access Management" and create credentials:
   - Username: `breakerbot`
   - Password: (choose a strong password)

### 2. Update ESP32 Code

In `sketch_nov17a.ino`, update the MQTT settings (around line 27):

```cpp
const char* mqtt_server = "YOUR-CLUSTER.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_user = "breakerbot";
const char* mqtt_pass = "your-password";
```

**Important**: For HiveMQ Cloud (TLS), you also need to change the WiFiClient to WiFiClientSecure. Add this code before `setup()`:

```cpp
// Replace: WiFiClient mqttWifiClient;
// With:
WiFiClientSecure mqttWifiClient;

// And in setup(), before mqttClient.setServer(), add:
mqttWifiClient.setInsecure(); // Skip certificate verification (for simplicity)
```

Then install the **PubSubClient** library in Arduino IDE:
- Go to Sketch → Include Library → Manage Libraries
- Search for "PubSubClient" by Nick O'Leary
- Install it

Upload the updated code to your ESP32.

### 3. Deploy to Vercel

1. Push this folder to GitHub:
   ```bash
   cd breakerbot-web
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create breakerbot-web --public --push
   ```

2. Go to [Vercel](https://vercel.com) and sign in with GitHub

3. Click "Add New Project" and import `breakerbot-web`

4. Add Environment Variables:
   - `NEXT_PUBLIC_MQTT_BROKER`: `wss://YOUR-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt`
   - `NEXT_PUBLIC_SECURITY_PIN`: `1234` (or your preferred PIN)

5. Click "Deploy"

### 4. Test It

1. Make sure your ESP32 is powered on and connected to WiFi
2. Open your Vercel URL (e.g., `breakerbot-web.vercel.app`)
3. The status should show "Connected"
4. Try opening the door - you should see the ESP32 respond!

## Quick Test (Public Broker)

For testing without HiveMQ Cloud setup, both the website and ESP32 are configured to use the public `broker.hivemq.com` by default. This works but is **not secure for production** - anyone could control your door!

## Files

- `app/page.js` - Main dashboard UI
- `app/layout.js` - App layout
- `.env.example` - Environment variables template

## Security Notes

- The PIN is validated client-side for demo purposes
- For production, consider adding server-side authentication
- Use HiveMQ Cloud (not the public broker) for secure communication
- Consider adding MQTT topic prefixes unique to your device
