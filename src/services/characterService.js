import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("CharacterService");
import { generateImage } from "./imageService.js";
import { generateCharacterBiblePrompts } from "./promptService.js";


export async function generateCharacterBible(workflowId, demographic, tempDir) {
    const workflowAssetsDir = path.join(tempDir, "characters");
    fs.mkdirSync(workflowAssetsDir, { recursive: true });

    logger.info(`👤 Generating Character Bible for workflow: ${workflowId}`);

    const prompts = generateCharacterBiblePrompts(demographic);
    const anchorImages = [];

    for (let i = 0; i < prompts.length; i++) {
        const viewName = i === 0 ? "front" : i === 1 ? "profile" : "three_quarter";
        logger.info(`📸 Generating anchor image: ${viewName}`);

        // We use a high-quality generation for the bible
        const result = await generateImage(prompts[i], i + 1, workflowAssetsDir, "16:9");

        if (result.imageUrl) {
            // Rename to something more semantic if needed, but generateImage already saves it
            const newPath = path.join(workflowAssetsDir, `${viewName}.png`);
            fs.renameSync(result.imageUrl, newPath);

            // Return public URL or absolute path? Let's return absolute path for backend use
            anchorImages.push(newPath);
        }
    }

    if (anchorImages.length === 0) {
        throw new Error("Failed to generate any character anchor images.");
    }

    logger.info(`✅ Character Bible complete with ${anchorImages.length} images.`);
    return anchorImages;
}
