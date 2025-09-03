require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const os = require('os'); // <-- add this

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'shipway-proxy', time: new Date().toISOString() });
});

// 👇 Request logger
app.use((req, res, next) => {
    console.log(`${req.method} ${req.originalUrl}`);
    next();
});

// Import Routes
const shipwayRoutes = require('./routes/shipwayRoutes');
app.use('/api', shipwayRoutes);


// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'An error occurred, please try again later.' });
});

const httpServer = http.createServer(app);
const HTTP_PORT = process.env.HTTP_PORT || 8080;

// 👇 helper to get LAN IP
function getLocalIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

httpServer.listen(HTTP_PORT, () => {
    const ip = getLocalIp();
    console.log(`HTTP Server listening on:`);
    console.log(`Local:   http://localhost:${HTTP_PORT}`);
    console.log(`Network: http://${ip}:${HTTP_PORT}`);
});
