const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const url = process.env.MONGO_URL || 'mongodb+srv://cloud:eFtnSh3VyUxGMZbO@cluster0.y0hnvsx.mongodb.net/';
const dbName = process.env.MONGO_DB_NAME || 'SEMICONSPACE_SHIPWAY_SERVICE_DEV';

let client;
let db;

async function connectToDatabase() {
    if (db) return db;

    try {
        // No need for useNewUrlParser or useUnifiedTopology
        client = new MongoClient(url);
        await client.connect();
        console.log('Connected to MongoDB');

        db = client.db(dbName);

        process.on("SIGINT", async () => {
            if (client) await client.close();
            console.log("🔒 Database connection closed.");
            process.exit(0);
        });

        return db;
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        throw error;
    }
}

module.exports = { connectToDatabase };
