import cors from "cors";
import dns from "dns";
import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("App");

// Load environment variables
dotenv.config();

const app = express();


// Middleware
import morgan from "morgan";
app.use(morgan("dev")); // Log all API requests to the terminal
app.use(cors());
app.use(express.json({ limit: "5000mb" }));
app.use(express.urlencoded({ extended: true, limit: "5000mb" }));

app.use("/static", express.static("public"));

import mediaRoutes from "./routes/media.routes.js";

app.use("/api/media", mediaRoutes);

// Test Route
app.get("/", (req, res) => {
  res.json({ message: "Hello, world!" });
});

import adminRoutes from "./routes/admin.routes.js";
import authRoutes from "./routes/auth.routes.js";
import creationsRoutes from "./routes/creations.route.js";
import overviewRoutes from "./routes/overview.routes.js";
import storyRoutes from "./routes/story.routes.js";
import voiceRoutes from "./routes/voice.routes.js";
import { runScheduledWorkflows } from "./services/workflowService.js";
import { syncPostStatuses } from "./services/socialPublishService.js";
import publishRoutes from "./routes/publish.routes.js";
import editorRoutes from "./routes/editor.routes.js";
// Start BullMQ worker in-process (REMOVED: runs in separate process now)

app.use("/api/auth", authRoutes);
app.use("/api/story", storyRoutes);
app.use("/api/editor", editorRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/creations", creationsRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/publish", publishRoutes);

// dns configuration
dns.setDefaultResultOrder("ipv4first");

cron.schedule("* * * * *", async () => {
  await runScheduledWorkflows();
});

// Sync social post statuses from Mallary every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  await syncPostStatuses();
});


// Start Server
const port = process.env.PORT || 4002;
app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);
});
