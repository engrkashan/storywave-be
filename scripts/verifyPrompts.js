import { extractStoryMetadata, generateMasterPrompts } from "../src/services/promptService.js";
import dotenv from "dotenv";
dotenv.config();

const sampleStory = `
In the heart of the bustling Caribbean market of Port-au-Prince, 1974, Jacques, a weathered Haitian fisherman with skin like cracked mahogany, finds himself cornered. 
The air is thick with the scent of fried plantains and salt air. 
A corrupt officer sneers at him, tapping a baton against his palm. Jacques clenches his jaw, his dark eyes ablaze with a suppressed fury that reflects the orange glow of a nearby lantern. 
In his shaking hand, he grips a rusted iron compass, his father's only legacy. 
The humidity makes the velvet ribbon tied around it damp and heavy.
`;

const title = "The Port of Secrets";

async function test() {
    console.log("🔍 Testing Metadata Extraction...");
    const metadata = await extractStoryMetadata(sampleStory);
    console.log("✅ Metadata:", JSON.stringify(metadata, null, 2));

    console.log("\n📦 Testing Master Prompt Generation (1:1)...");
    const prompts11 = generateMasterPrompts(metadata, title, "1:1");
    console.log("✅ Poster Prompt:", prompts11.poster);

    console.log("\n📦 Testing Master Prompt Generation (16:9)...");
    const prompts169 = generateMasterPrompts(metadata, title, "16:9");
    console.log("✅ Cinematic Prompt:", prompts169.cinematic);
}

test();
