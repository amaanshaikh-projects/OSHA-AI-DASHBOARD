const { Worker, UnrecoverableError } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');
const { getAppConfig, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../config.js');
const { geminiQueue, trackApiUsage, redisConnection } = require('./queue-manager.js');
const healthController = require('./health-controller.js');
const fs = require('fs').promises;
const sharp = require('sharp');
sharp.cache(false); // Disable sharp cache to prevent memory leaks from unique frames
const { getEmbedder } = require('../utils/embedder-service');
const { cosineSimilarity, getTimeWindow, getWeekKey, getPlanAlertLimit } = require('../utils/shared-utils');
const { sendAlertEmail } = require('./email-service.js');
const quotaManager = require('./quota-manager.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Redis-backed cache helpers (5 minute TTL) ─────────────────────────────────
const CACHE_TTL = 300; // 5 minutes

async function getCachedProfile(userId) {
    const key = `cache:profile:${userId}`;
    const cached = await redisConnection.get(key);
    if (cached) return JSON.parse(cached);
    const { data } = await supabase.from('profiles').select('subscription_plan, subscription_status, email').eq('id', userId).single();
    if (data) await redisConnection.set(key, JSON.stringify(data), 'EX', CACHE_TTL);
    return data;
}

async function getCachedSettings(userId) {
    const key = `cache:settings:${userId}`;
    const cached = await redisConnection.get(key);
    if (cached) return JSON.parse(cached);
    const { data } = await supabase.from('settings').select('email_notifications').eq('user_id', userId).single();
    if (data) await redisConnection.set(key, JSON.stringify(data), 'EX', CACHE_TTL);
    return data;
}

async function getCachedPrompt(camId) {
    const key = `cache:prompt:${camId}`;
    const cached = await redisConnection.get(key);
    if (cached) return JSON.parse(cached);
    const { data } = await supabase.from('camera_prompts').select('*').eq('camera_id', camId).order('created_at', { ascending: false }).limit(1);
    const result = data && data.length > 0 ? data[0] : null;
    if (result) await redisConnection.set(key, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
}

async function callGemini(userId, camId, base64Image, semanticConditions, yoloBoxes = [], previousState = null, modelOverride = null) {
    const config = getAppConfig();
    const openRouterConfig = config.openRouter;

    if (!openRouterConfig || !openRouterConfig.apiKey) {
        throw new Error('OpenRouter API key is not configured');
    }

    const modelToUse = modelOverride || openRouterConfig.model;

    // Track usage before making the call
    // API usage tracking is now done strictly on success/fail.

    const systemPrompt = `You are OSHA AI, a visual event-verification engine.
TIME: ${new Date().toLocaleString()}
GOAL: Determine if the user's monitoring rule is visibly satisfied by the CURRENT IMAGE.

RULES:
1. ONLY use the CURRENT IMAGE as authoritative proof. Previous State is for context (e.g. what changed, continuing events).
2. Evaluate the RULE, not just objects. (e.g. "dog on couch" requires seeing the dog ON the couch, not just both existing).
3. If multiple candidate objects match, include ALL matching indices.
4. Actions/Relationships MUST be visually supported. No guessing.
5. If evidence is ambiguous, heavily occluded, blurry, or needs deeper analysis: set requires_escalation=true and detected=false.
6. False positives are worse than misses. Be precise.
7. Ignore unrelated objects/people/movement.
7. Ignore unrelated objects/people/movement.
8. If Previous State exists, decide event_state: "new", "continuing", "ended", "unchanged", "uncertain". Do not alert again for unchanged states.
9. If the rule requires a custom object NOT in candidates, set detected=true and return its [xmin, ymin, xmax, ymax] (0-1000 scale).
10. IMPORTANT: In the "reason" field, NEVER use terms like "index 0", "at index 1", or any technical jargon. Describe the object naturally in plain english (e.g., "The person on the left is holding a phone").
11. Return a 'semantic_state' object that maps each evaluated semantic condition to a boolean, so the backend can track state transitions.

OUTPUT EXACT JSON:
{
  "detected": true|false,
  "requires_escalation": true|false,
  "matching_indices": [0], // must always use zero-based indexing corresponding exactly to the candidate array supplied by the backend. The first candidate is index 0. Never use one-based indexing.
  "event_state": "new"|"continuing"|"ended"|"unchanged"|"uncertain",
  "reason": "Short explanation",
  "semantic_state": { "condition_1": true, "condition_2": false },
  "custom_bounding_box": [xmin, ymin, xmax, ymax] | null,
  "confidence": 0-100
}`;


    let contextStr = '';
    if (previousState) {
        contextStr += `\n\nPrevious Verified State:\n${JSON.stringify(previousState)}\nEvaluate what has changed compared to this prior state.`;
    }

    if (yoloBoxes && yoloBoxes.length > 0) {
        contextStr += "\n\nCandidate objects detected by YOLO in this frame:\n";
        yoloBoxes.forEach((b, i) => {
            contextStr += `Index ${i}: ${b.label} at normalized box [xmin:${Math.round(b.box[0])}, ymin:${Math.round(b.box[1])}, xmax:${Math.round(b.box[2])}, ymax:${Math.round(b.box[3])}] (0-1000 scale)\n`;
        });
        contextStr += "\nPlease indicate which of these indices matches the user's monitoring rule in your JSON response under 'matching_indices'. matching_indices must always use zero-based indexing corresponding exactly to the candidate array supplied by the backend. The first candidate is index 0. Never use one-based indexing.";
    }

    const body = {
        model: modelToUse,
        response_format: { type: 'json_object' },
        max_tokens: 800,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: "Verify the following conditions: " + (semanticConditions || []).join(', ') + contextStr },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
            }
        ],
        temperature: 0.1
    };

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
        const err = new Error(`OpenRouter API error: ${response.status} ${errText}`);
        // Do not retry 400-499 errors except 429 Too Many Requests
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new UnrecoverableError(err.message);
        }
        throw err;
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();

    // Robust JSON parsing: strip markdown fences
    if (content.startsWith('```json')) content = content.substring(7);
    else if (content.startsWith('```')) content = content.substring(3);
    if (content.endsWith('```')) content = content.substring(0, content.length - 3);
    content = content.trim();

    try {
        const parsed = JSON.parse(content);

        // Strict Schema Validation
        parsed.detected = Boolean(parsed.detected);
        parsed.requires_escalation = Boolean(parsed.requires_escalation);

        const validStates = ['new', 'continuing', 'ended', 'unchanged', 'uncertain'];
        if (!validStates.includes(parsed.event_state)) {
            parsed.event_state = 'uncertain';
        }

        // Clamp confidence safely between 0 and 100
        parsed.confidence = Math.min(100, Math.max(0, parseInt(parsed.confidence) || 95));

        // Validate matching indices strictly without guessing
        if (parsed.matching_indices && Array.isArray(parsed.matching_indices)) {
            const validIndices = [];

            parsed.matching_indices.forEach(idx => {
                if (Number.isInteger(idx) && idx >= 0 && yoloBoxes && idx < yoloBoxes.length) {
                    validIndices.push(idx);
                } else {
                    console.log(`[GeminiWorker] 🚨 Invalid matching_index returned by LLM: ${idx} (candidate count: ${yoloBoxes ? yoloBoxes.length : 0}). Rejecting index without guessing.`);
                }
            });
            parsed.matching_indices = validIndices;
        } else {
            parsed.matching_indices = [];
        }

        // Track success
        await trackApiUsage();
        await quotaManager.incrementApiUsage(userId, camId);
        return parsed;
    } catch (parseErr) {
        console.error(`[GeminiWorker] Invalid Gemini JSON parsing failure: ${parseErr.message}\nContent: ${content}`);
        // Treat malformed JSON as uncertain verification, do not crash worker
        return {
            detected: false,
            requires_escalation: true,
            matching_indices: [],
            event_state: 'uncertain',
            reason: 'LLM returned malformed JSON',
            confidence: 0
        };
    }
}

function startGeminiWorkers() {
    console.log('[GeminiWorker] Starting Gemini worker pool...');

    let stats = {
        processed: 0,
        totalLatency: 0,
        errors429: 0,
        retries: 0
    };

    const worker = new Worker('gemini-tasks', async (job) => {
        const start = Date.now();
        if (job.attemptsMade > 0) {
            stats.retries++;
        }

        const { camId, userId, ruleId, ruleVersion, semanticConditions, imagePath, metadata, eventType, previousState, cameraName } = job.data;

        console.log(`[GeminiWorker] Processing frame for camera ${camId}...`);

        // ── EARLY TRIAL CHECK: Block ALL processing if trial is expired ──
        try {
            const earlyProfile = await getCachedProfile(userId);
            if (earlyProfile?.subscription_status === 'Trial Expired') {
                console.warn(`[GeminiWorker] User ${userId} trial is expired. Dropping job for camera ${camId} without calling Gemini.`);
                try { await fs.unlink(imagePath).catch(() => { }); } catch (e) { }
                return;
            }
            if ((earlyProfile?.subscription_plan || 'Free').toLowerCase() === 'free') {
                const weekKey = getWeekKey();
                const weeklyAlertStr = await redisConnection.get(`alerts_usage:user:${userId}:weekly:${weekKey}`);
                const alertsUsed = weeklyAlertStr ? parseInt(weeklyAlertStr, 10) : 0;

                if (alertsUsed >= 10) {
                    console.warn(`[GeminiWorker] User ${userId} weekly free trial quota exhausted (Alerts: ${alertsUsed}/10). Blocking until next week.`);
                    try { await fs.unlink(imagePath).catch(() => { }); } catch (e) { }
                    return;
                }

                // Note: The Free Trial API limit (30 calls/week per camera) is enforced atomically 
                // right before the OpenRouter API call, just like Starter/Pro limits.
            }
        } catch (earlyCheckErr) {
            console.error('[GeminiWorker] Early trial check error:', earlyCheckErr.message);
        }

        let base64Image;
        let finalYoloBoxes = metadata?.yolo_boxes || [];
        let cropData = null; // Store crop offsets to map LLM boxes back

        try {
            const buffer = await fs.readFile(imagePath);

            const config = getAppConfig();
            if (config.modelRouting?.enableImageQualityGate !== false) {
                const stats = await sharp(buffer).stats();
                const avgBrightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
                if (avgBrightness < 5 || avgBrightness > 250) {
                    console.warn(`[GeminiWorker] ❌ Image quality gate failed (Brightness: ${avgBrightness.toFixed(2)}). Dropping frame.`);
                    try { await fs.unlink(imagePath).catch(() => { }); } catch (e) { }
                    return;
                }
            }

            const imageMetadata = await sharp(buffer).metadata();
            const nativeW = imageMetadata.width;
            const nativeH = imageMetadata.height;

            // Dynamic Cropping Logic based on prompt metadata
            let cropBoxes = finalYoloBoxes;
            let marginFactor = 0.40;
            let useFullFrame = false;

            if (finalYoloBoxes.length > 0 && metadata) {
                const requiredClasses = new Set([
                    ...(metadata.objects || []),
                    ...(metadata.primary_objects || []),
                    ...(metadata.secondary_objects || [])
                ].map(c => c.toLowerCase()));

                if (requiredClasses.size > 0) {
                    const relevantBoxes = finalYoloBoxes.filter(b => b.label && requiredClasses.has(b.label.toLowerCase()));

                    if (relevantBoxes.length === 0) {
                        useFullFrame = true;
                    } else {
                        cropBoxes = relevantBoxes;
                        const detectedClasses = new Set(relevantBoxes.map(b => b.label.toLowerCase()));

                        let detectedAll = true;
                        for (const req of requiredClasses) {
                            if (!detectedClasses.has(req)) {
                                detectedAll = false;
                                break;
                            }
                        }

                        if (detectedAll && relevantBoxes.length > 1) {
                            marginFactor = 0.25; // 25% for multiple relevant objects
                        } else if (!detectedAll && requiredClasses.size > 1) {
                            marginFactor = 0.80; // 80% when missing some required objects
                        } else {
                            marginFactor = 0.40; // Default
                        }
                    }
                }
            }

            // Check if we have YOLO boxes to crop around and we aren't falling back to full-frame
            if (finalYoloBoxes.length > 0 && !useFullFrame) {
                // YOLO boxes are scaled to 320x180.
                const scaleX = nativeW / 320;
                const scaleY = nativeH / 180;

                let minX = nativeW;
                let minY = nativeH;
                let maxX = 0;
                let maxY = 0;

                cropBoxes.forEach(b => {
                    const bx1 = b.box[0] * scaleX;
                    const by1 = b.box[1] * scaleY;
                    const bx2 = b.box[2] * scaleX;
                    const by2 = b.box[3] * scaleY;

                    if (bx1 < minX) minX = bx1;
                    if (by1 < minY) minY = by1;
                    if (bx2 > maxX) maxX = bx2;
                    if (by2 > maxY) maxY = by2;
                });

                // Add dynamic margin for contextual reasoning
                const boxW = maxX - minX;
                const boxH = maxY - minY;
                const marginX = boxW * marginFactor;

                // Give extra top padding (at least 80% of box height) for 'person' detections to avoid cutting off faces/heads
                const hasPerson = cropBoxes.some(b => b.label && b.label.toLowerCase() === 'person');
                const topMarginFactor = hasPerson ? Math.max(marginFactor, 0.80) : marginFactor;

                const marginYTop = boxH * topMarginFactor;
                const marginYBottom = boxH * marginFactor;

                let cropX = Math.max(0, minX - marginX);
                let cropY = Math.max(0, minY - marginYTop);
                let cropW = Math.min(nativeW - cropX, boxW + (marginX * 2));
                let cropH = Math.min(nativeH - cropY, boxH + marginYTop + marginYBottom);

                // Crop, resize, and convert to base64 (max 768px on longest side, 85% JPEG quality)
                const croppedBuffer = await sharp(buffer)
                    .extract({
                        left: Math.round(cropX),
                        top: Math.round(cropY),
                        width: Math.round(cropW),
                        height: Math.round(cropH)
                    })
                    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 85 })
                    .toBuffer();

                // Save crop data so we can map Gemini's custom boxes back to the original 320x180 space if needed
                cropData = { cropX, cropY, cropW, cropH, nativeW, nativeH, scaleX, scaleY };
                base64Image = croppedBuffer.toString('base64');

                // Translate YOLO box coordinates into 0-1000 normalized coordinates inside the cropped image space
                finalYoloBoxes = finalYoloBoxes.map((b, idx) => {
                    const origX1 = b.box[0] * scaleX;
                    const origY1 = b.box[1] * scaleY;
                    const origX2 = b.box[2] * scaleX;
                    const origY2 = b.box[3] * scaleY;

                    // Filter out boxes completely outside the crop
                    if (origX2 <= cropX || origX1 >= cropX + cropW || origY2 <= cropY || origY1 >= cropY + cropH) {
                        return null;
                    }

                    const xmin = Math.round(Math.max(0, Math.min(1000, ((origX1 - cropX) / cropW) * 1000)));
                    const ymin = Math.round(Math.max(0, Math.min(1000, ((origY1 - cropY) / cropH) * 1000)));
                    const xmax = Math.round(Math.max(0, Math.min(1000, ((origX2 - cropX) / cropW) * 1000)));
                    const ymax = Math.round(Math.max(0, Math.min(1000, ((origY2 - cropY) / cropH) * 1000)));

                    return {
                        originalIndex: idx,
                        label: b.label,
                        box: [xmin, ymin, xmax, ymax]
                    };
                }).filter(b => b !== null);
            } else {
                // Mode B / Full frame processing: Downscale to save API costs if image is massive
                const downscaledBuffer = await sharp(buffer)
                    .resize({ width: 960, height: 540, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 75 })
                    .toBuffer();
                base64Image = downscaledBuffer.toString('base64');

                // Scale YOLO boxes (which are 0-320x180 from camera-worker) to 0-1000 scale for Gemini
                finalYoloBoxes = finalYoloBoxes.map((b, idx) => {
                    const xmin = Math.round(Math.max(0, Math.min(1000, (b.box[0] / 320) * 1000)));
                    const ymin = Math.round(Math.max(0, Math.min(1000, (b.box[1] / 180) * 1000)));
                    const xmax = Math.round(Math.max(0, Math.min(1000, (b.box[2] / 320) * 1000)));
                    const ymax = Math.round(Math.max(0, Math.min(1000, (b.box[3] / 180) * 1000)));
                    return {
                        originalIndex: idx,
                        label: b.label,
                        box: [xmin, ymin, xmax, ymax]
                    };
                });
            }

            // Clean up the temp file
            await fs.unlink(imagePath).catch(() => { });
        } catch (e) {
            console.error(`[GeminiWorker] Failed to process image ${imagePath}:`, e.message);
            throw e;
        }

        try {
            const startTime = Date.now();

            // Dynamic Model Balancing based on AI-extracted difficulty
            const config = getAppConfig();
            let primaryModel = config.modelRouting?.primaryModel || 'google/gemini-2.5-flash-lite';
            let escalationModel = config.modelRouting?.escalationModel || 'google/gemini-2.5-flash';
            let apiCostEstimate = 0.00028; // Base cost for Flash Lite

            // Calculate Prompt Complexity based on conditions (adjectives, verbs, connectors)
            let conditionCount = 0;
            if (semanticConditions && Array.isArray(semanticConditions)) {
                conditionCount = semanticConditions.length;
                const joinedConditions = semanticConditions.join(' ').toLowerCase();
                const conditionKeywords = ['wearing', 'holding', 'carrying', 'with', 'without', 'and', 'or', 'running', 'walking', 'standing', 'sitting', 'inside', 'outside'];
                conditionKeywords.forEach(kw => {
                    const regex = new RegExp(`\\b${kw}\\b`, 'g');
                    const matches = joinedConditions.match(regex);
                    if (matches) conditionCount += matches.length;
                });

                // Count colors as explicit conditions
                const colorKeywords = ['red', 'blue', 'green', 'yellow', 'black', 'white', 'orange', 'purple', 'pink', 'brown', 'gray'];
                colorKeywords.forEach(kw => {
                    const regex = new RegExp(`\\b${kw}\\b`, 'g');
                    const matches = joinedConditions.match(regex);
                    if (matches) conditionCount += matches.length;
                });
            }

            if (config.modelRouting?.enableComplexityRouting !== false) {
                if ((metadata && metadata.difficulty === 'Expert') || conditionCount >= 4) {
                    primaryModel = escalationModel;
                    apiCostEstimate = 0.000587; // Base cost for Flash
                    const diffLabel = metadata ? metadata.difficulty : 'Unknown';
                    console.log(`[GeminiWorker] ⚖️ Balancing Logic: Prompt has ${conditionCount} conditions (Diff: ${diffLabel}). Routing directly to heavier model: ${primaryModel}`);
                }
            }

            // --- INJECT ACTUAL PREVIOUS STATE FROM REDIS ---
            let actualPreviousState = null;
            try {
                const stateStr = await redisConnection.get(`last_verified_state:cam:${camId}`);
                if (stateStr) {
                    const parsedState = JSON.parse(stateStr);
                    // Build a compact representation
                    actualPreviousState = {
                        event_state: parsedState.event_state || 'unknown',
                        last_verified: true,
                        tracked_objects: []
                    };
                    // Incorporate track IDs and YOLO labels safely
                    if (metadata && metadata.tracked_ids && metadata.yolo_boxes) {
                        for (let i = 0; i < metadata.tracked_ids.length; i++) {
                            const t_id = metadata.tracked_ids[i];
                            const box = metadata.yolo_boxes[i];
                            if (t_id !== undefined && box && box.label) {
                                actualPreviousState.tracked_objects.push({
                                    track_id: t_id,
                                    class: box.label,
                                    last_verified: parsedState.detected === true
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`[GeminiWorker] Error fetching previous state:`, err.message);
            }

            let finalModel = primaryModel;
            let escalationOccurred = false;
            let escalationReason = null;

            // ATOMIC QUOTA ENFORCEMENT
            const { getPlanApiLimit, getWeekKey } = require('../utils/shared-utils');
            const earlyProfileForQuota = await getCachedProfile(userId);
            const planForRecord = (earlyProfileForQuota?.subscription_plan || 'Free').toLowerCase();
            const alloc = getPlanApiLimit(planForRecord);

            let usageKey;
            if (planForRecord === 'free' || earlyProfileForQuota?.subscription_status === 'Trial Expired') {
                usageKey = `api_usage:cam:${camId}:weekly:${getWeekKey()}`;
            } else {
                // Using server's local timezone for daily reset (YYYY-MM-DD)
                const todayStr = new Intl.DateTimeFormat('en-CA').format(new Date());
                usageKey = `api_usage:cam:${camId}:daily:${todayStr}`;
            }

            const currentUsage = await redisConnection.incr(usageKey);
            if (currentUsage === 1) {
                await redisConnection.expire(usageKey, 86400 * 8); // 8 day TTL
            }

            if (currentUsage > alloc) {
                // Reject, revert usage
                await redisConnection.decr(usageKey);
                // Set Safe Mode Flag
                await redisConnection.set(`quota:safemode:${camId}`, '1', 'EX', 86400 * 2);
                console.warn(`[GeminiWorker] Camera ${camId} reached strict API quota (${alloc}). Safe Mode activated.`);
                return; // Abort job gracefully without error
            }

            let apiCallFailed = true; // Track if we should revert usage
            let result;

            try {
                await redisConnection.incr('gemini_calls_total').catch(() => { });
                console.log(`[GeminiWorker] 🔍 Stage 1: Requesting ${primaryModel} for camera ${camId}...`);
                result = await callGemini(userId, camId, base64Image, semanticConditions, finalYoloBoxes, actualPreviousState, primaryModel);

                // Stage 2: Evaluate confidence and uncertainty
                if (primaryModel !== escalationModel) {
                    const escalationConfidence = config.modelRouting?.escalationConfidence || 75;
                    let shouldEscalate = false;
                    let escReason = '';

                    if (result.requires_escalation) {
                        shouldEscalate = true;
                        escReason = 'Model flagged requires_escalation=true';
                    } else if (result.confidence < escalationConfidence) {
                        shouldEscalate = true;
                        escReason = `Low confidence (${result.confidence}% < ${escalationConfidence}%)`;
                    } else if (result.event_state === 'uncertain') {
                        shouldEscalate = true;
                        escReason = 'event_state is uncertain';
                    }

                    if (shouldEscalate) {
                        escalationOccurred = true;
                        escalationReason = escReason;
                        finalModel = escalationModel;
                        apiCostEstimate += 0.000587; // Add Cost for Flash

                        console.log(`[GeminiWorker] ⚠️ Stage 3: Escalating to ${escalationModel}. Reason: ${escalationReason}`);
                        result = await callGemini(userId, camId, base64Image, semanticConditions, finalYoloBoxes, actualPreviousState, escalationModel);
                    }
                }
                apiCallFailed = false; // Successfully hit API
            } finally {
                if (apiCallFailed) {
                    await redisConnection.decr(usageKey); // Revert usage if API failed completely
                }
            }

            const totalLatencyMs = Date.now() - startTime;

            // Diagnostics Logging
            const diagnosticLog = {
                timestamp: new Date().toISOString(),
                cameraId: camId,
                cameraName: cameraName || 'Unknown',
                primaryModel,
                escalationOccurred,
                escalationReason,
                finalModel,
                finalConfidence: result.confidence,
                finalDecision: result.detected,
                eventState: result.event_state,
                totalLatencyMs,
                apiCostEstimate
            };

            console.log(`[GeminiWorker] 📊 AI Diagnostics Log:`, JSON.stringify(diagnosticLog));
            try {
                await redisConnection.lpush('ai_diagnostics_log', JSON.stringify(diagnosticLog));
                await redisConnection.ltrim('ai_diagnostics_log', 0, 9999); // Keep last 10,000 logs
            } catch (redisErr) {
                console.error('[GeminiWorker] Failed to push diagnostics to Redis:', redisErr.message);
            }

            await healthController.recordApiSuccess(camId);

            // Remove legacy healthController.recordApiRequest as it is handled by the atomic logic above

            if (result.detected) {
                await redisConnection.incr('events_verified').catch(() => { });
                console.log(`[GeminiWorker] 🚨 Event confirmed for camera ${camId}: ${result.reason} (State: ${result.event_state})`);

                // --- 0. FORCE EVENT IDENTITY FROM TRACKER ---
                // "don't make the cooldown depend solely on Gemini's continuing result. Your object tracker + event identity should remain the source of truth for whether it's the same event."
                let matchedIds = [];
                let rejectedIds = [];
                let allTrackedIds = metadata?.tracked_ids || [];

                if (result.matching_indices && Array.isArray(result.matching_indices) && result.matching_indices.length > 0) {
                    result.matching_indices.forEach(idx => {
                        const candidate = finalYoloBoxes[idx];
                        const origIdx = candidate && candidate.originalIndex !== undefined ? candidate.originalIndex : idx;
                        if (allTrackedIds[origIdx] !== undefined) {
                            matchedIds.push(allTrackedIds[origIdx]);
                        }
                    });

                    console.log(`[GeminiWorker] 📊 Match Stats - Cam: ${camId} | Job: ${job.id} | Candidates: ${finalYoloBoxes.length} | Returned matching_indices: ${JSON.stringify(result.matching_indices)} | Matched IDs: ${JSON.stringify(matchedIds)} | Tracked IDs: ${JSON.stringify(allTrackedIds)}`);

                    rejectedIds = allTrackedIds.filter(id => !matchedIds.includes(id));
                } else {
                    matchedIds = allTrackedIds; // Fallback if Gemini doesn't provide indices but says MATCH
                }

                const crypto = require('crypto');
                const promptStr = metadata?.prompt || '';
                const promptHash = crypto.createHash('md5').update(promptStr).digest('hex');

                if (result.event_state === 'new') {
                    for (const id of matchedIds) {
                        const isAccepted = await redisConnection.get(`accepted:cam:${camId}:prompt:${promptHash}:obj:${id}`);
                        if (isAccepted) {
                            console.log(`[GeminiWorker] 🔄 Override: Gemini claimed 'new', but tracker identity (${id}) is already verified for this prompt. Forcing 'continuing'.`);
                            result.event_state = 'continuing';
                            break;
                        }
                    }
                }

                // --- CONTINUOUS REASONING STATE & EVENT TIMELINE ---
                await redisConnection.set(`last_verified_state:cam:${camId}`, JSON.stringify(result), 'EX', 86400 * 7); // Store scene memory for 7 days
                const eventSummary = `[${new Date().toISOString()}] ${eventType || 'Event'} [${result.event_state}]: ${result.reason}`;
                await redisConnection.rpush(`events:cam:${camId}`, eventSummary);
                await redisConnection.ltrim(`events:cam:${camId}`, -100, -1); // Keep last 100 events only

                // Only apply alert cooldowns for NEW events
                if (result.event_state === 'new') {
                    // Store accepted objects in Redis so they are silenced for 24 hours (unless meaningful change occurs)
                    if (metadata && metadata.tracked_ids) {
                        const acceptedPayload = JSON.stringify({ reason: result.reason || 'Event confirmed' });
                        for (const id of matchedIds) {
                            await redisConnection.set(`accepted:cam:${camId}:prompt:${promptHash}:obj:${id}`, acceptedPayload, 'EX', 86400); // 24 hours
                        }
                    }
                }

                // Filter boxes to only include the matching ones, OR append custom bounding box
                let finalBoxes = metadata?.yolo_boxes || [];
                if (result.matching_indices && Array.isArray(result.matching_indices) && result.matching_indices.length > 0) {
                    finalBoxes = result.matching_indices.map(idx => {
                        const candidate = finalYoloBoxes[idx];
                        const origIdx = candidate && candidate.originalIndex !== undefined ? candidate.originalIndex : idx;
                        return (metadata?.yolo_boxes || [])[origIdx];
                    }).filter(Boolean);
                } else if (result.custom_bounding_box && Array.isArray(result.custom_bounding_box) && result.custom_bounding_box.length === 4) {
                    finalBoxes = []; // Clear other YOLO boxes so we only draw the custom box
                    // Convert [xmin, ymin, xmax, ymax] (0-1000) from Gemini
                    const [xmin, ymin, xmax, ymax] = result.custom_bounding_box;
                    let finalBoxX1, finalBoxY1, finalBoxX2, finalBoxY2;

                    if (cropData) {
                        // Map the 0-1000 coordinate relative to the CROP back to the original NATIVE space, then to 320x180
                        const cropRelX1 = (xmin / 1000) * cropData.cropW;
                        const cropRelY1 = (ymin / 1000) * cropData.cropH;
                        const cropRelX2 = (xmax / 1000) * cropData.cropW;
                        const cropRelY2 = (ymax / 1000) * cropData.cropH;

                        const nativeX1 = cropRelX1 + cropData.cropX;
                        const nativeY1 = cropRelY1 + cropData.cropY;
                        const nativeX2 = cropRelX2 + cropData.cropX;
                        const nativeY2 = cropRelY2 + cropData.cropY;

                        finalBoxX1 = nativeX1 / cropData.scaleX;
                        finalBoxY1 = nativeY1 / cropData.scaleY;
                        finalBoxX2 = nativeX2 / cropData.scaleX;
                        finalBoxY2 = nativeY2 / cropData.scaleY;
                    } else {
                        // Full frame 
                        finalBoxX1 = (xmin / 1000) * 320;
                        finalBoxY1 = (ymin / 1000) * 180;
                        finalBoxX2 = (xmax / 1000) * 320;
                        finalBoxY2 = (ymax / 1000) * 180;
                    }

                    finalBoxes.push({
                        label: metadata?.target_concept || 'Target Object',
                        box: [finalBoxX1, finalBoxY1, finalBoxX2, finalBoxY2]
                    });
                }

                let detectionStatus = 'Unread';
                let isRoutine = false;

                const alertMetadata = {
                    yolo_boxes: finalBoxes,
                    expected_event: eventType,
                    is_routine: isRoutine
                };

                // Snapshot and Embedding logic moved down

                if (result.event_state === 'new') {
                    // --- 1. CLASS-LEVEL ACCEPTANCE COOLDOWN (Fast Redis ops) ---
                    // Blocks new alerts for this specific object class on this camera for 60s.
                    // This prevents tracker ID churn from causing spam.
                    // IMPORTANT: Must run BEFORE alert limits check so camera-worker always gets the signal.
                    if (metadata && metadata.yolo_boxes) {
                        const cooldownPromises = [];
                        for (const box of metadata.yolo_boxes) {
                            const className = box.label;
                            if (!className) continue;
                            let cooldownTime = 60;
                            if (['car', 'truck', 'bus', 'chair', 'bench'].includes(className)) cooldownTime = 120;
                            cooldownPromises.push(redisConnection.set(`accepted_class:cam:${camId}:class:${className}`, '1', 'EX', cooldownTime));
                        }
                        await Promise.all(cooldownPromises);
                    }
                }

                // --- 2. Broadcast MATCH result immediately (Unblocks camera-worker and UI) ---
                // IMPORTANT: Must run BEFORE alert limits check. If we skip this,
                // camera-worker never receives the MATCH signal and the object stays
                // in Pending state, causing infinite Gemini API calls.
                if (redisConnection && redisConnection.status === 'ready') {
                    await redisConnection.publish('gemini_results', JSON.stringify({
                        camId,
                        matchedIds,
                        rejectedIds,
                        eventIds: metadata.event_ids,
                        status: 'MATCH',
                        event_state: result.event_state
                    }));
                }

                // --- 3. Check Event State for Alert Suppression ---
                if (result.event_state !== 'new') {
                    console.log(`[GeminiWorker] 🤫 Event is ${result.event_state} for camera ${camId}. Suppressing database insert and email alert to prevent spam.`);
                    return; // Skip DB insert + email, but MATCH broadcast already fired above
                }

                // --- 4. Check User Alert Limits (gate DB insert + email only) ---
                const profile = await getCachedProfile(userId);
                const planStr = (profile?.subscription_plan || 'Free').toLowerCase();
                const alertLimit = getPlanAlertLimit(planStr);

                const todayStr = new Date().toISOString().split('T')[0];
                let dailyAlertsCount = 0;

                if (planStr === 'free') {
                    const weekKey = getWeekKey();
                    dailyAlertsCount = await redisConnection.incr(`alerts_usage:user:${userId}:weekly:${weekKey}`);
                    await redisConnection.expire(`alerts_usage:user:${userId}:weekly:${weekKey}`, 86400 * 8);
                } else {
                    dailyAlertsCount = await redisConnection.incr(`alerts_usage:user:${userId}:daily:${todayStr}`);
                    await redisConnection.expire(`alerts_usage:user:${userId}:daily:${todayStr}`, 86400 * 2);
                }

                if (dailyAlertsCount > alertLimit) {
                    if (planStr === 'free') {
                        console.warn(`[GeminiWorker] User ${userId} hit weekly free trial alert limit (${alertLimit}). Blocking DB insert until next week.`);
                    } else {
                        console.warn(`[GeminiWorker] User ${userId} has exhausted their daily alerts limit (${alertLimit}). Dropping positive detection.`);
                    }
                    await healthController.recordApiSuccess(camId);
                    return; // Skip DB insert + email, but cooldown & MATCH broadcast already fired above
                }

                // --- 4.5 Generate Snapshot and Embedding ---
                let snapshotUrl = null;
                try {
                    const buffer = Buffer.from(base64Image, 'base64');
                    const fileName = `${camId}/${Date.now()}.jpg`;
                    const { data: uploadData, error: uploadError } = await supabase.storage.from('snapshots').upload(fileName, buffer, { contentType: 'image/jpeg' });
                    if (!uploadError && uploadData) {
                        const { data: publicUrlData } = supabase.storage.from('snapshots').getPublicUrl(fileName);
                        snapshotUrl = publicUrlData.publicUrl;
                    } else {
                        console.error('[GeminiWorker] Storage upload error:', uploadError?.message);
                        if (uploadError?.message?.includes('Bucket not found') || uploadError?.message?.includes('bucket_id')) {
                            console.log('[GeminiWorker] Attempting to create missing bucket "snapshots"...');
                            await supabase.storage.createBucket('snapshots', { public: true });
                            const { data: retryData, error: retryError } = await supabase.storage.from('snapshots').upload(fileName, buffer, { contentType: 'image/jpeg' });
                            if (!retryError && retryData) {
                                const { data: publicUrlData } = supabase.storage.from('snapshots').getPublicUrl(fileName);
                                snapshotUrl = publicUrlData.publicUrl;
                            }
                        }
                    }
                } catch (e) {
                    console.error('[GeminiWorker] Storage exception:', e.message);
                }
                if (!snapshotUrl) snapshotUrl = `data:image/jpeg;base64,${base64Image}`;

                // Generate rich search description
                const yoloLabels = (metadata.yolo_boxes || []).map(b => b.label).join(', ');
                const searchDescription = `[Camera: ${cameraName || 'Unknown Camera'}] - Event: ${eventType || 'Detection'}. AI Analysis: ${result.reason}. Detected objects: ${yoloLabels || 'None'}.`;

                // Generate Embedding for semantic search
                let embeddingArray = null;
                try {
                    const embedPipeline = await getEmbedder();
                    const out = await embedPipeline(searchDescription, { pooling: 'mean', normalize: true });
                    embeddingArray = Array.from(out.data);
                } catch (embErr) {
                    console.error('[GeminiWorker] Embedding error:', embErr.message);
                }

                // --- 5. Parallelize heavy tasks (DB Insert and Email Dispatch) ---
                const dbTask = supabase.from('detections').insert([{
                    camera_id: camId,
                    user_id: userId,
                    reason: result.reason,
                    search_description: searchDescription,
                    confidence: result.confidence || 95,
                    metadata: alertMetadata,
                    snapshot_url: snapshotUrl,
                    embedding: embeddingArray
                }]).then(({ error }) => {
                    if (error) {
                        if (error.code === '23503' || (error.message && error.message.includes('foreign key constraint'))) {
                            console.warn(`[GeminiWorker] Camera ${camId} was deleted mid-processing. Discarding detection.`);
                        } else {
                            console.error('[GeminiWorker] Error saving detection:', error.message);
                        }
                    }
                });

                const emailTask = (async () => {
                    try {
                        const emailCooldownKey = `cam_email_cooldown:${camId}`;
                        const gotEmailLock = await redisConnection.set(emailCooldownKey, '1', 'NX', 'EX', 60);

                        if (!gotEmailLock) {
                            console.log(`[GeminiWorker] 🚨 Email cooldown active for camera ${camId}. Skipping email to prevent spam.`);
                            return;
                        }

                        const settings = await getCachedSettings(userId);
                        const emailEnabled = settings ? settings.email_notifications : true;

                        if ((planStr === 'starter' || planStr === 'pro') && profile?.email && emailEnabled !== false) {
                            const sent = await sendAlertEmail(
                                profile.email,
                                cameraName || 'Unknown Camera',
                                result.reason,
                                snapshotUrl
                            );
                            if (sent) {
                                console.log(`[GeminiWorker] ✉️  Email sent for Gemini detection for camera ${camId}.`);
                            }
                        } else if (!profile?.email) {
                            console.log(`[GeminiWorker] Skipping email alert for ${userId} — no email on record.`);
                        } else if (emailEnabled === false) {
                            console.log(`[GeminiWorker] Skipping email alert for ${userId} — email_notifications is disabled.`);
                        } else {
                            console.log(`[GeminiWorker] Skipping email alert for ${userId} (Plan: ${planStr || 'free'})`);
                        }
                    } catch (emailErr) {
                        console.error('[GeminiWorker] Error triggering email alert:', emailErr.message);
                    }
                })();

                // Await both tasks so BullMQ marks job complete only when finished, but they run in parallel!
                await Promise.allSettled([dbTask, emailTask]);
            } else {
                await redisConnection.incr('events_rejected').catch(() => { });
                console.log(`[GeminiWorker] Event rejected for camera ${camId}. Reason: ${result.reason || 'None provided'}`);

                // Broadcast NO_MATCH result for local memory tracking in camera-worker
                // (The in-memory objectStates cooldown with escalating backoff handles rejection silence.)
                if (metadata && metadata.tracked_ids) {
                    await redisConnection.publish('gemini_results', JSON.stringify({
                        camId,
                        trackedIds: metadata.tracked_ids,
                        eventIds: metadata.event_ids,
                        status: 'NO_MATCH',
                        semantic_state: result.semantic_state
                    }));
                }
            }
        } catch (e) {
            console.error(`[GeminiWorker] Job failed for camera ${camId}:`, e.message);
            await healthController.recordApiError(camId, e.message);

            // Broadcast ERROR result so camera-worker unblocks the 'Verifying' state
            if (metadata && metadata.tracked_ids) {
                try {
                    await redisConnection.publish('gemini_results', JSON.stringify({
                        camId,
                        trackedIds: metadata.tracked_ids,
                        eventIds: metadata.event_ids,
                        status: 'ERROR'
                    }));
                } catch (pubErr) {
                    console.error(`[GeminiWorker] Could not publish ERROR status:`, pubErr.message);
                }
            }
            throw e; // Let BullMQ fail the job (we intentionally do not retry, allowing the camera to fetch a fresh frame)
        } finally {
            try {
                await redisConnection.del(`gemini_processing:${camId}`);
            } catch (delErr) {
                console.error(`[GeminiWorker] Error releasing lock:`, delErr.message);
            }
            // Track successful processing latency
            stats.processed++;
            stats.totalLatency += (Date.now() - start);

            // Fix disk leak: Clean up the temporary image file
            try {
                if (imagePath) {
                    await fs.unlink(imagePath).catch(() => { });
                }
            } catch (unlinkErr) {
                console.error(`[GeminiWorker] Error deleting temp image:`, unlinkErr.message);
            }
        }
    }, {
        connection: redisConnection,
        concurrency: 10
    });

    worker.on('failed', (job, err) => {
        if (err.message && err.message.includes('429')) {
            stats.errors429++;
        }
        console.error(`[GeminiWorker] Job ${job.id} failed:`, err.message);
    });

    // --- QUEUE MONITORING TELEMETRY ---
    setInterval(async () => {
        try {
            const waiting = await geminiQueue.getWaitingCount();
            const active = await geminiQueue.getActiveCount();
            const avgLatency = stats.processed > 0 ? (stats.totalLatency / stats.processed).toFixed(0) : 0;

            console.log(`[Queue Monitor] Active Jobs: ${active}/10 | Waiting: ${waiting} | Avg Latency: ${avgLatency}ms | 429s: ${stats.errors429} | Retries: ${stats.retries}`);

            // Reset interval stats
            stats = { processed: 0, totalLatency: 0, errors429: 0, retries: 0 };
        } catch (err) {
            console.error('[Queue Monitor] Error fetching stats:', err.message);
        }
    }, 10000); // Run every 10 seconds
}

module.exports = { startGeminiWorkers };
