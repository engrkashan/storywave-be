export function generateThumbnailPrompt(title, storyType) {
    const genres = {
        true_crime_fiction_cinematic: {
            style:
                "cinematic Netflix-style true-crime artwork with high-contrast noir lighting",
            elements:
                "dark alleys, blurred police lights, cryptic evidence objects, shadowy suspect silhouette",
            colors: "moody reds, deep shadows, noir tones with stark highlights",
            mood: "intense, dramatic, suspense-filled, evoking mystery",
            composition: "rule of thirds, central focus on enigmatic clue",
        },

        true_crime_nonfiction_forensic: {
            style: "realistic forensic documentary visual with sharp details",
            elements:
                "crime scene markers, fingerprint overlays, forensic tools, evidence closeups, investigation board",
            colors:
                "cool blues, sterile whites, forensic lab tones with subtle yellow accents",
            mood: "analytical, investigative, unbiased, truth-revealing",
            composition: "balanced grid layout, focal point on key evidence",
        },

        manipulation_sexual_manipulation: {
            style: "mature psychological manipulation symbolism with surreal twists",
            elements:
                "broken masks, tangled strings, shadowy silhouettes, metaphorical tension, distorted faces",
            colors:
                "dark purples, muted reds, deep dramatic contrasts with ethereal glows",
            mood: "intense, psychological, emotionally charged, unsettling",
            composition: "asymmetrical for tension, central pull on symbolic figure",
        },

        cultural_history_documentary: {
            style:
                "National Geographic-style cultural documentary artwork with textured depth",
            elements:
                "heritage artifacts, historical textures, symbolic cultural patterns, ancient ruins or icons",
            colors: "earthy tones, warm natural hues, golden hour lighting",
            mood: "educational, respectful, culturally rich, exploratory",
            composition: "wide panoramic view, focal artifact in foreground",
        },

        homesteading_howto_field_guide: {
            style:
                "rustic, practical homesteading field-guide illustration with natural realism",
            elements:
                "tools, wooden textures, garden elements, simple natural objects, hands in action",
            colors: "greens, browns, softly lit outdoor tones with vibrant accents",
            mood: "practical, peaceful, self-sufficient, empowering",
            composition: "close-up on tools, balanced with scenic background",
        },

        work_and_trades_shop_manual: {
            style: "technical how-to shop manual artwork with precise lines",
            elements:
                "tools, machinery diagrams, workshop parts, reference shapes, blueprints overlay",
            colors:
                "industrial grays, metallic tones, clean technical colors with blue highlights",
            mood: "instructive, clear, mechanical, hands-on",
            composition: "diagram-centric, focal on machinery with annotations",
        },

        work_and_trades_shopfloordoc: {
            style: "real-world shop-floor documentary style with gritty authenticity",
            elements:
                "factory environment, tools, workbenches, mechanical details, workers in motion",
            colors: "industrial tones, steel blues, warm highlights from sparks",
            mood: "authentic, gritty, hands-on, industrious",
            composition: "dynamic angle, central action on workbench",
        },

        investigative_discovery_journalistic: {
            style:
                "journalistic investigative documentary artwork with collage elements",
            elements:
                "documents, maps, red string connections, headlines, evidence boards, magnifying glass",
            colors:
                "cool investigative blues with high contrast shadows and red accents",
            mood: "urgent, analytical, truth-seeking, revealing",
            composition: "pinboard layout, focal on connected clues",
        },

        storytelling_cinematic: {
            style: "dramatic cinematic movie-style illustration with epic depth",
            elements:
                "symbolic objects based on the title, dramatic lighting, atmospheric depth, heroic or tense figures",
            colors: "rich cinematic tones with golden or blue hour vibes",
            mood: "emotional, visual, immersive, narrative-driven",
            composition: "widescreen framing, central character or symbol",
        },

        conversation_narrated_documentary: {
            style: "blended narrated-documentary visual style with soft overlays",
            elements:
                "voice-wave graphics, symbolic objects from the story, soft documentary textures, subtle animations",
            colors: "neutral documentary tones with warm highlights and fades",
            mood: "thoughtful, reflective, narrative-driven, conversational",
            composition: "layered with foreground symbols, balanced flow",
        },

        education_howto_trades: {
            style:
                "clear instructional educational trades illustration with step-by-step clarity",
            elements:
                "tools, diagrams, step-by-step symbolic objects, charts or icons",
            colors: "clean, bright educational palette with primary accents",
            mood: "practical, clear, helpful, motivational",
            composition: "sequential layout, focal on instructional element",
        },

        horror_murder: {
            style:
                "gruesome horror illustration with stylized gore and chiaroscuro shadows",
            elements:
                "blood splatters, shadowy killers, weapons in silhouette, crime scenes with eerie fog",
            colors: "crimson reds, dark blacks, eerie greens and purples",
            mood: "terrifying, gruesome, suspenseful, nightmarish",
            composition:
                "tense close-up, asymmetrical for dread, focal on bloodied symbol",
        },
    };

    const g = genres[storyType] || genres.storytelling_cinematic;

    const titleKeywords = title
        .toLowerCase()
        .split(" ")
        .filter((word) =>
            ["murder", "blood", "killer", "crime", "horror"].includes(word)
        );
    const customElements =
        titleKeywords.length > 0
            ? `, incorporating ${titleKeywords.join(" and ")} motifs`
            : "";

    return `
    Create a highly detailed, cinematic 16:9 digital illustration based on the story titled "${title}". 
    Style: ${g.style}. 
    Include elements such as: ${g.elements}${customElements}. 
    Color palette: ${g.colors}. 
    Mood: ${g.mood}. 
    Composition: ${g.composition}, with high contrast and emotional hook. 
    Ultra-sharp, visually striking, thumbnail-quality artwork optimized for click-through. No text unless specified.
      `.trim();
}
