import { google } from "googleapis";
import fs from "fs";

export async function uploadToYouTube(auth, filePath, title, description) {
  const youtube = google.youtube({ version: "v3", auth });
  const res = await youtube.videos.insert({
    part: "snippet,status",
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: "public" },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return res.data;
}
