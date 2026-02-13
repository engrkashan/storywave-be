import { FishAudioClient } from "fish-audio";

const fishAudio = new FishAudioClient({ apiKey: process.env.FISH_API_KEY });

// Predefined list of specific Fish Audio voice IDs
const FISH_VOICE_IDS = [
    "9d1efa1645a34f219cfb0ac605960a14",
    "0e73b5c5ff5740cd8d85571454ef28ae",
    "98544e744e754814a6aa22229f63f475",
    "3ad4d432023c47ee9e6c7805b973630a",
    "80e34d5e0b2b4577a486f3a77e357261",
    "1625a0fcc6eb4b2695275ab638fc34a0",
    "2a01ebc0f9fc490f9e15a34d27424fd1",
    "e67757098a81402e8fd074fb494c6b72",
    "638c5a1ed89a41fb8baeadc00ddd8448",
    "45b0b82dacc04037933924cb00bab236",
    "4edfb590384f4d728816681dff98ef78",
    "84f0f8f157644a119c6463ae57b7648e",
    "c021c5dde1774cd4abee9bdb9653923b",
    "d43fb7ec01224f2e9cca4dd30fca0966",
    "eff348d9b7254adfb55b6c4ea629b457",
    "4392854e8d0547a39604c2619fcbc9f3",
    "e44db292ef804a9bae85a5b66230bad9",
    "bf322df2096a46f18c579d0baa36f41d",
    "9a9cf47702da476aa4629e2506d4a857",
    "536d3a5e000945adb7038665781a4aca",
    "79d0bd3e4e5444b18f7b6d89b5927bf1",
    "933563129e564b19a115bedd57b7406a",
    "e3cd384158934cc9a01029cd7d278634",
    "b347db033a6549378b48d00acb0d06cd",
    "8ef4a238714b45718ce04243307c57a7",
    "31a18e2d02c340bf896c39ed27f7e8c5",
    "16b2981936f34328886f4f230e7fe196",
    "0327fdb5da9e4fd782899a8058c8ae2b",
    "2fb4f43723794e64855f6466c2c13679",
    "65c0b8155c464a648161af8877404f11",
    "8a5a849eff184046ae6bdb9a1825165c",
    "5e79e8f5d2b345f98baa8c83c947532d",
    "2947ec32c7e1479c8ec5628a1fc035f1",
    "1ca7bc02099d47f1ae06b31f26875523",
    "35cb9c3f50f048a0a49bc606816d2b6e",
    "2ea060bfb19e426bb66378bcb54dd565",
    "98e364e9a41c465a9d4fdafc267f84ea",
    "71fc4ced6367468288f3bc5b9e80921e",
    "860323c9e1354f6ea14079788b0bca0d",
    "b089032e45db460fb1934ece75a8c51d",
    "21d8216af9ad4a9a96149845ecd89850",
    "74e2e3eface047b69dd352afbcf8c88c",
    "4f942ae62f85423c9e2fadc4b0df2b02",
    "001262690f2a4eea84aa764cc536df24",
    "75049ca2fdc5491eb9e12eec434c1f63",
    "10d94e1796c24ff094175985167699b7",
    "840f8c7ab9e84691a74608ce51c89d33",
    "47eec8ee3b7941b58ef57b1b7294202e",
    "159619a64f754162bc02f023ef97edf9",
    "490cf0f3d7bb4eb28a0799a34ba2d7aa",
    "8d63071f286d44d2b8e1d66bc486a47a",
    "32c42e365ec64733815812b74f400927",
    "7e4baf13677e4b95b5e25a60b9a717b4",
    "08fd53a9ebe14a2cb72c452cbb3e82a9",
    "247a1ba2050d48c6925e56e2be135abf",
    "783e4bc723494007a7d84c458d14d1ba",
    "45b9c65115fc4eee8c8df5b0782cc9ff",
    "7cefff1c89464d7dbc412482f909ec2d",
    "2ee00298253b4d4a9ffa1c8615a5f82d",
    "42e70f5bc7b34a9e84abbbd6ec5572d0",
    "7561330e2bf34a76a80508fafcf81327",
    "329ff0b9604444ec982526af54630427",
    "4fe31e5e2bba44288bf9944cb1e511d8",
    "06366bd48deb46d98e0df6160f798cb3",
    "9ab5d9df251341b5a43c64575acd8aae",
    "5f9dc1849c7644eaa48df363d988ad0e",
    "3f6e5d576b1147f788d5e7542bbbaf1b",
    "739da5c41315410caa69bfcc9a2e80f9",
    "1127a2a0c8574b75a20d1f8dae12c1b9",
    "1005d2697a1d4b4dbb2f954033652be6",
    "5a8c5ea548324024bc33e92f40631f88",
    "03a9e8a0655042cebd7d17d117ed3500",
    "5e352d0226694656ae6155ba20582aac",
    "a50ea00b1bef4a12a3f670a0ca75b695",
    "93963d9a417b492387a10dbdade8c644",
    "5b36b8232b054f958e00a2b707b30e32",
];

/**
 * Get Fish Audio voices (optimized to use specific voice IDs)
 */
export async function getFishVoices(req, res) {
    try {
        // Fetch metadata for each specific voice ID
        const voicePromises = FISH_VOICE_IDS.map(async (voiceId) => {
            try {
                const voice = await fishAudio.voices.get(voiceId);
                return {
                    id: voice.id || voice._id || voiceId,
                    label: voice.name || voice.title || `Voice ${voiceId.substring(0, 8)}`,
                    provider: "fish",
                    tags: voice.tags || [],
                };
            } catch (error) {
                console.error(`Failed to fetch voice ${voiceId}:`, error.message);
                // Return a fallback object if individual voice fetch fails
                return {
                    id: voiceId,
                    label: `Voice ${voiceId.substring(0, 8)}`,
                    provider: "fish",
                    tags: [],
                };
            }
        });

        const voices = await Promise.all(voicePromises);

        res.json({ voices });
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
