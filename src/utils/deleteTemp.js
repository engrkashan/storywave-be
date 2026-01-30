import fs from "fs";
import path from "path";

// 🧹 Safely delete temp files & folders recursively (Production-Safe)
export function deleteTempFiles(baseDir) {
  try {
    if (!fs.existsSync(baseDir)) return;

    // Safety guard: Prevent accidental deletion outside project
    const rootDir = process.cwd();
    const resolvedBase = path.resolve(baseDir);
    if (!resolvedBase.startsWith(rootDir)) {
      console.warn(
        `⚠️ Skipping deletion outside project root: ${resolvedBase}`,
      );
      return;
    }

    fs.readdirSync(baseDir).forEach((file) => {
      const filePath = path.join(baseDir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        deleteTempFiles(filePath); // recursive delete
        try {
          fs.rmdirSync(filePath);
        } catch (e) {
          console.warn(`⚠️ Could not remove dir: ${filePath} (${e.message})`);
        }
      } else {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn(`⚠️ Could not remove file: ${filePath} (${e.message})`);
        }
      }

      fs.rmdirSync(baseDir);
    });
  } catch (err) {
    console.error("⚠️ Error cleaning temp files:", err.message);
  }
}
