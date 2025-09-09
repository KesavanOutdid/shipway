require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const os = require("os");
const errorHandler = require("./src/middlewares/errorHandler");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
    res.json({ ok: true, service: "shipway-proxy", time: new Date().toISOString() });
});

// Routes
const shipwayRoutes = require("./src/routes/shipwayRoutes");
app.use("/api", shipwayRoutes);

// Error Handler (centralized)
app.use(errorHandler);

// --- Server Setup ---
const HTTP_PORT = process.env.HTTP_PORT || 9090;
const httpServer = http.createServer(app);

function getLocalIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === "IPv4" && !net.internal) {
                return net.address;
            }
        }
    }
    return "localhost";
}

httpServer.listen(HTTP_PORT, () => {
    const ip = getLocalIp();
    console.log(`HTTP Server listening on:`);
    console.log(`Local:   http://localhost:${HTTP_PORT}`);
    console.log(`Network: http://${ip}:${HTTP_PORT}`);
});
