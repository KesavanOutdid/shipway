const winston = require("winston");
const path = require("path");
const fs = require("fs");

const logsDirectory = path.join(__dirname, "..", "Log"); // force it inside src/Log

// Ensure log directory exists
if (!fs.existsSync(logsDirectory)) {
    fs.mkdirSync(logsDirectory, { recursive: true });
}

const logFilename = path.join(logsDirectory, "Shipway.log");

const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp({ format: "DD/MM/YYYY HH:mm:ss" }),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
            let metaString = "";
            if (Object.keys(meta).length) {
                try {
                    metaString = " " + JSON.stringify(meta);
                } catch {
                    metaString = " [Could not stringify meta]";
                }
            }
            return `${timestamp} [${level.toUpperCase()}]: ${message}${metaString}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: logFilename }), // ✅ write to file
        new winston.transports.Console(), // still log to terminal
    ],
});

module.exports = logger;
