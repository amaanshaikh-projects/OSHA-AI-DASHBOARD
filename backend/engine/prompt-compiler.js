const { getAppConfig } = require('../config.js');
const crypto = require('crypto');

function generateRuleHash(compiledRule) {
    const dataToHash = {
        local: compiledRule.local_conditions,
        semantic: compiledRule.semantic_conditions
    };
    return crypto.createHash('sha256').update(JSON.stringify(dataToHash)).digest('hex');
}

function validateCompiledRule(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('LLM output is not a valid JSON object');
    }

    const defaultRule = {
        local_conditions: {
            objects: [],
            zones: [],
            triggers: [],
            movement: []
        },
        semantic_conditions: [],
        ambiguous_conditions: []
    };

    const validated = { ...defaultRule };
    
    if (parsed.local_conditions) {
        if (Array.isArray(parsed.local_conditions.objects)) validated.local_conditions.objects = parsed.local_conditions.objects.map(String);
        if (Array.isArray(parsed.local_conditions.zones)) validated.local_conditions.zones = parsed.local_conditions.zones.map(String);
        if (Array.isArray(parsed.local_conditions.triggers)) validated.local_conditions.triggers = parsed.local_conditions.triggers.map(String);
        if (Array.isArray(parsed.local_conditions.movement)) validated.local_conditions.movement = parsed.local_conditions.movement.map(String);
    }
    
    if (Array.isArray(parsed.semantic_conditions)) {
        validated.semantic_conditions = parsed.semantic_conditions.map(String);
    }
    if (Array.isArray(parsed.ambiguous_conditions)) {
        validated.ambiguous_conditions = parsed.ambiguous_conditions.map(String);
    }

    return validated;
}

async function compilePrompt(userId, cameraId, ruleId, version, promptText, availableZones = []) {
    const config = getAppConfig();
    const openRouterConfig = config.openRouter;

    if (!openRouterConfig || !openRouterConfig.apiKey) {
        throw new Error('OpenRouter API key is not configured');
    }

    const systemPrompt = `You are a strict Prompt Compiler for a Multi-Tenant AI Security Camera System.
The user provides a natural language prompt describing an event they want to monitor.
Your job is to parse this prompt into a strictly typed JSON object separating 'local_conditions' (things YOLO/trackers can do) and 'semantic_conditions' (things an LLM needs to verify visually).

CRITICAL INSTRUCTIONS:
1. 'local_conditions.objects' MUST map to standard COCO classes (e.g., "guy" -> "person", "SUV" -> "car", "package" -> "backpack"). If no object is specified, default to empty array.
2. 'local_conditions.zones' should contain the IDs of any requested zones. Available zones for this camera: ${JSON.stringify(availableZones)}. DO NOT guess zone IDs if none match.
3. 'local_conditions.triggers' can only be: "ENTER_ZONE", "EXIT_ZONE", "OBJECT_APPEARED", "OBJECT_STOPS", "OBJECT_REMAINS", "OBJECT_MOVED".
4. 'semantic_conditions' is an array of strings detailing things that require visual reasoning (e.g., "wearing a red shirt", "carrying a package", "holding a gun"). DO NOT include standard COCO classes here unless modifying them.
5. 'ambiguous_conditions' is an array of strings for subjective/unclear terms (e.g., "suspicious", "weird").

Return ONLY valid JSON matching this schema exactly:
{
    "local_conditions": {
        "objects": ["array of required COCO objects e.g. person, car, dog"],
        "zones": ["array of zone IDs e.g. zone_123"],
        "triggers": ["array of trigger types"]
    },
    "semantic_conditions": ["array of specific semantic checks"],
    "ambiguous_conditions": ["array of unclear/subjective terms"]
}`;

    const body = {
        model: openRouterConfig.model || 'google/gemini-pro-1.5',
        response_format: { type: 'json_object' },
        max_tokens: 1000,
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

        if (content.startsWith('\`\`\`json')) content = content.substring(7);
        else if (content.startsWith('\`\`\`')) content = content.substring(3);
        if (content.endsWith('\`\`\`')) content = content.substring(0, content.length - 3);
        content = content.trim();

        const parsed = JSON.parse(content);
        const compiled = validateCompiledRule(parsed);
        
        console.log(`[COMPILER] User ${userId} → Rule ${ruleId} → version ${version} compiled`);
        console.log(`[COMPILER] Rule ${ruleId} → local conditions: ${compiled.local_conditions.objects.join(', ')}`);
        if (compiled.semantic_conditions.length > 0) {
            console.log(`[COMPILER] Rule ${ruleId} → semantic conditions: ${compiled.semantic_conditions.join(', ')}`);
        }
        if (compiled.ambiguous_conditions.length > 0) {
            console.log(`[COMPILER] Rule ${ruleId} → ambiguous condition detected: ${compiled.ambiguous_conditions.join(', ')}`);
        }

        return {
            user_id: userId,
            camera_id: cameraId,
            rule_id: ruleId,
            rule_version: version,
            original_prompt: promptText,
            local_conditions: compiled.local_conditions,
            semantic_conditions: compiled.semantic_conditions,
            ambiguous_conditions: compiled.ambiguous_conditions,
            rule_hash: generateRuleHash(compiled),
            compilation_status: 'SUCCESS'
        };
    } catch (e) {
        console.error(`[COMPILER] User ${userId} → Rule ${ruleId} → compilation failed: ${e.message}`);
        return {
            user_id: userId,
            camera_id: cameraId,
            rule_id: ruleId,
            rule_version: version,
            original_prompt: promptText,
            compilation_status: 'FAILED',
            error_reason: e.message
        };
    }
}

module.exports = { compilePrompt, generateRuleHash };
