import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import path from "path";

/**
 * Merge multiple MP3 audio files into one MP3 sequentially.
 * If only one file is passed, just copy it.
 */
export async function mergeAudioFiles(files, outputFile) {
  return new Promise((resolve, reject) => {
    if (!files || files.length === 0) {
      return reject(new Error("No audio files provided for merging"));
    }

    // If only one file → just copy it
    if (files.length === 1) {
      fs.copyFileSync(files[0], outputFile);
      console.log(`Single file copied to ${outputFile}`);
      return resolve(outputFile);
    }

    // Create a temporary list file for ffmpeg concat demuxer
    const listFile = path.join(
      process.cwd(),
      "public",
      "podcasts",
      `merge_list_${Date.now()}.txt`
    );
    const fileContent = files.map(f => `file '${path.resolve(f)}'`).join("\n");
    fs.writeFileSync(listFile, fileContent);

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .save(outputFile)
      .on("end", () => {
        console.log(`Audio merged successfully to ${outputFile}`);
        fs.unlinkSync(listFile); // clean up temp file
        resolve(outputFile);
      })
      .on("error", (err) => {
        console.error("FFMPEG Merge Error:", err.message);
        reject(err);
      });
  });
}
