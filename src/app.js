import cors from "cors";
import dns from "dns";
import dotenv from "dotenv";
import express from "express";
import morgan from "morgan";

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));
app.use(express.static("public"));

import mediaRoutes from "./routes/media.routes.js";

app.use("/api/media", mediaRoutes);

// Test Route
app.get("/", (req, res) => {
  res.json({ message: "Hello, world!" });
});

import authRoutes from "./routes/auth.routes.js";
import storyRoutes from "./routes/story.routes.js"
import adminRoutes from "./routes/admin.routes.js"
import podcastRoutes from "./routes/podcast.routes.js";

app.use("/api/auth", authRoutes);
app.use("/api/story", storyRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/podcast", podcastRoutes);

// dns configuration
dns.setDefaultResultOrder("ipv4first");

// Start Server
const port = process.env.PORT || 4002;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
