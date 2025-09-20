import { exec } from "child_process";

export function createVideo(imagesPattern, audioFile, outputFile = "output.mp4") {
    return new Promise((resolve, reject) => {
        const command = `ffmpeg -r 1 -i ${imagesPattern} -i ${audioFile} -c:v libx264 -c:a aac -pix_fmt yuv420p ${outputFile}`;
        exec(command, (err) => {
            if (err) reject(err);
            else resolve(outputFile);
        });
    });
}
