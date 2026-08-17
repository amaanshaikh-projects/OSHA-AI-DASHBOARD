const { getAppConfig } = require('../config.js');

function validateMetadata(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('LLM output is not a valid JSON object');
    }

    const defaultMetadata = {
        mode: 'A',
        target_concept: '',
        objects: [],
        primary_objects: [],
        secondary_objects: [],
        attributes: [],
        actions: [],
        locations: [],
        time_conditions: [],
        time_threshold_ms: 0,
        ignore_objects: [],
        relationships: [],
        difficulty: 'Medium',
        recommended_strategy: 'YOLO_AND_GEMINI',
        expected_event: 'Unknown event'
    };

    const validated = { ...defaultMetadata };
    const errors = [];

    const checkArray = (key) => {
        if (parsed[key] !== undefined) {
            if (Array.isArray(parsed[key])) {
                validated[key] = parsed[key].map(String);
            } else {
                errors.push(`Field '${key}' expected array, got ${typeof parsed[key]}`);
            }
        }
    };

    if (parsed.mode === 'A' || parsed.mode === 'B') {
        validated.mode = parsed.mode;
    } else if (parsed.mode !== undefined) {
        errors.push(`Field 'mode' expected 'A' or 'B', got ${parsed.mode}`);
    }

    if (parsed.target_concept !== undefined) validated.target_concept = String(parsed.target_concept);
    if (parsed.difficulty !== undefined) validated.difficulty = String(parsed.difficulty);
    if (parsed.recommended_strategy !== undefined) validated.recommended_strategy = String(parsed.recommended_strategy);
    if (parsed.expected_event !== undefined) validated.expected_event = String(parsed.expected_event);

    if (parsed.time_threshold_ms !== undefined) {
        if (typeof parsed.time_threshold_ms === 'number') {
            validated.time_threshold_ms = parsed.time_threshold_ms;
        } else {
            errors.push(`Field 'time_threshold_ms' expected number, got ${typeof parsed.time_threshold_ms}`);
        }
    }

    checkArray('objects');
    checkArray('primary_objects');
    checkArray('secondary_objects');
    checkArray('attributes');
    checkArray('actions');
    checkArray('locations');
    checkArray('time_conditions');
    checkArray('ignore_objects');
    checkArray('relationships');

    if (errors.length > 0) {
        console.warn(`[PromptExtractor] Metadata Validation Warnings:\n - ${errors.join('\n - ')}`);
    }

    return validated;
}

async function extractMetadata(promptText) {
    const config = getAppConfig();
    const openRouterConfig = config.openRouter;

    if (!openRouterConfig || !openRouterConfig.apiKey) {
        throw new Error('OpenRouter API key is not configured');
    }

    const systemPrompt = `You are an expert AI metadata extractor for an ultra-low API security camera decision engine.
The user will provide a natural language prompt describing an event they want to monitor.
Extract a complete monitoring plan.

You must categorize the prompt into one of two detection modes:
- Mode A (YOLO-Supported): If the main object is a standard COCO class (e.g., person, car, dog, bicycle, truck, backpack, chair).
- Mode B (Open Visual Understanding): If the main object is a complex, specific, or non-COCO concept (e.g., 'yellow toy car', 'teddy bear', 'blue toolbox', 'red suitcase', 'broken window', 'safety vest', 'coffee mug').

CRITICAL INSTRUCTION FOR 'objects' (Mode A only):
If Mode A, map the user's terms to the closest standard COCO class (e.g., "guy" -> "person", "SUV" -> "car", "puppy" -> "dog"). Include the COCO class in the "objects" array.

CRITICAL INSTRUCTION FOR 'target_concept' (Mode B only):
If Mode B, provide a concise string describing the exact visual object or event we need to find (e.g., "yellow toy car").

Return ONLY valid JSON matching this schema exactly, nothing else:
{
    "mode": "A or B (defaults to A if unsure)",
    "target_concept": "The specific visual concept to find (Required for Mode B)",
    "objects": ["array of COCO objects that trigger the event (e.g. person, dog, car)"],
    "primary_objects": ["main subjects of the event"],
    "secondary_objects": ["objects the primary interacts with"],
    "attributes": ["specific colors, clothing, or features (e.g. yellow helmet, red jacket)"],
    "actions": ["required actions (e.g. entering, sitting, leaving)"],
    "locations": ["zones or areas mentioned (e.g. couch, driveway, porch)"],
    "time_conditions": ["any time modifiers (e.g. at night, for 5 minutes)"],
    "time_threshold_ms": 0,
    "ignore_objects": ["objects to explicitly ignore"],
    "relationships": ["spatial relationships (e.g. dog on couch, person near car)"],
    "difficulty": "Easy, Medium, or Hard",
    "recommended_strategy": "YOLO_ONLY or YOLO_AND_GEMINI or MOTION_AND_GEMINI or TIME_BASED",
    "expected_event": "A concise 1-sentence summary of the exact trigger condition"
}`;


    const body = {
        model: openRouterConfig.model,
        response_format: { type: 'json_object' },
        max_tokens: 800,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: promptText }
        ],
        temperature: 0.1
    };

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openRouterConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(openRouterConfig.timeoutMs || 15000)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        let content = data.choices[0].message.content.trim();

        // Strip markdown code fences if present (model sometimes wraps JSON in ```json ... ```)
        if (content.startsWith('```json')) content = content.substring(7);
        else if (content.startsWith('```')) content = content.substring(3);
        if (content.endsWith('```')) content = content.substring(0, content.length - 3);
        content = content.trim();

        const parsed = JSON.parse(content);
        return validateMetadata(parsed);
    } catch (e) {
        console.error('[PromptExtractor] Error extracting metadata:', e.message);
        // Fallback metadata if extraction fails completely
        return validateMetadata({});
    }
}

module.exports = {
    extractMetadata
};
