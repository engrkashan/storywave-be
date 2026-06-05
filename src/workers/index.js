import dotenv from "dotenv";
dotenv.config();

// Now that environment variables are loaded, import the actual worker logic
import "./bullmq.worker.js";
