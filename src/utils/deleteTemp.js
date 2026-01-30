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

    // Forcefully delete directory and all contents (even if not empty)
    fs.rmSync(baseDir, { recursive: true, force: true });
    console.log(`✅ Deleted temp files in: ${baseDir}`);
  } catch (err) {
    console.error("⚠️ Error cleaning temp files:", err.message);
  }
}
