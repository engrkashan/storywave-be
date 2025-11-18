import cors from "cors";
import dns from "dns";
import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import { runScheduledWorkflows } from "./jobs/workflow.runner.js";

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

app.use("/static", express.static("public"));

import mediaRoutes from "./routes/media.routes.js";

app.use("/api/media", mediaRoutes);

// Test Route
app.get("/", (req, res) => {
  res.json({ message: "Hello, world!" });
});

import authRoutes from "./routes/auth.routes.js";
import storyRoutes from "./routes/story.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import podcastRoutes from "./routes/podcast.routes.js";
import creationsRoutes from "./routes/creations.route.js";
import overviewRoutes from "./routes/overview.routes.js";
import voiceCloneRoutes from "./routes/voice.clone.routes.js";

app.use("/api/auth", authRoutes);
app.use("/api/story", storyRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/podcast", podcastRoutes);
app.use("/api/creations", creationsRoutes);
app.use("/api/voice-clone", voiceCloneRoutes);

// dns configuration
dns.setDefaultResultOrder("ipv4first");

cron.schedule("* * * * *", async () => {
  console.log("⏰ Checking for scheduled workflows...");
  await runScheduledWorkflows();
});

// cron.schedule(
//   "*/30 * * * * *",
//   async () => {
//     console.log("⏰ Checking for scheduled workflows (every 30s)...");
//     await runScheduledWorkflows();
//   },
//   {
//     scheduled: true,
//   }
// );

// Start Server
const port = process.env.PORT || 4002;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
