import { exec } from "child_process";

export function createVideo(imagesPattern, audioFile, outputFile = "output.mp4") {
  return new Promise((resolve, reject) => {
    const ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe";

    // Important: quote all paths
    const cmd = `"${ffmpegPath}" -r 1 -i "${imagesPattern}" -i "${audioFile}" -c:v libx264 -c:a aac -pix_fmt yuv420p "${outputFile}"`;

    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve(outputFile);
    });
  });
}
