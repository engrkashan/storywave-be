import { FishAudioClient } from "fish-audio";

const fishAudio = new FishAudioClient({ apiKey: process.env.FISH_API_KEY });

/**
 * Get Fish Audio voices
 */
export async function getFishVoices(req, res) {
    try {

        // Fetch voices with larger page size to ensure we get enough American English voices
        const response = await fishAudio.voices.search({
            page_size: 100,
            language: "en", // Filter for English language
        });

        const voices = response.items || response.voices || [];

        // Filter for American English voices based on tags
        const americanVoices = voices.filter((voice) => {
            const tags = voice.tags || [];
            const tagsLower = tags.map(t => t.toLowerCase());

            // Check if voice is American English
            // Look for "American", "US", or English without other regional markers
            const isAmerican = tagsLower.some(tag =>
                tag.includes('american') ||
                tag.includes('us') ||
                tag.includes('usa')
            );

            // Exclude non-American English accents
            const isOtherAccent = tagsLower.some(tag =>
                tag.includes('british') ||
                tag.includes('australian') ||
                tag.includes('indian') ||
                tag.includes('scottish') ||
                tag.includes('irish')
            );

            // If explicitly American, include it
            if (isAmerican) return true;

            // If it's English but has no regional tag, include it (likely American default)
            const hasEnglish = tagsLower.some(tag => tag.includes('english'));
            if (hasEnglish && !isOtherAccent) return true;

            return false;
        });

        // Take only first 20 American English voices
        const selectedVoices = americanVoices.slice(0, 20);

        const formatted = selectedVoices.map((voice) => ({
            id: voice.id || voice._id,
            label: voice.name || voice.title,
            provider: "fish",
            tags: voice.tags || {},
        }));

        res.json({ voices: formatted });
    } catch (error) {
        res.status(500).json({
            error: "Failed to fetch Fish voices",
            message: error.message,
        });
    }
}

/**
 * Generate voice preview
 */
export async function getVoicePreview(req, res) {
    try {
        const { text, voiceId, provider } = req.body;

        if (!text || !voiceId || !provider) {
            return res.status(400).json({
                error: "Missing required fields: text, voiceId, provider",
            });
        }

        if (provider === "fish") {
            // Add storytelling emotion to preview text
            const emotionalText = `(narrator)(calm) ${text}`;


            // Generate Fish Audio preview with S1 model
            const audio = await fishAudio.textToSpeech.convert(
                {
                    text: emotionalText,
                    reference_id: voiceId,
                },
                "s1" // Use S1 model for better emotion support
            );

            // Convert ReadableStream to Buffer
            const buffer = Buffer.from(await new Response(audio).arrayBuffer());

            // Send audio as response
            res.set({
                "Content-Type": "audio/mpeg",
                "Content-Length": buffer.length,
            });
            res.send(buffer);
        } else {
            res.status(400).json({
                error: "Unsupported provider",
                message: "Only 'fish' provider is supported for preview",
            });
        }
    } catch (error) {
        res.status(500).json({
            error: "Failed to generate voice preview",
            message: error.message,
        });
    }
}
