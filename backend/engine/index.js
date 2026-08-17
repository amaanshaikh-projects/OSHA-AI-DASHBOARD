const http = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../config.js');
const { compilePrompt } = require('./prompt-compiler.js');
const { CameraWorkerPool } = require('./camera-worker.js');
const { startGeminiWorkers } = require('./gemini-worker.js');
const { startProfileEngine } = require('./profile-engine.js');
const { redisConnection, geminiQueue } = require('./queue-manager.js');
const CameraManager = require('../camera-manager.js');
const cryptoUtils = require('../utils/crypto.js');
const quotaManager = require('./quota-manager.js');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const PORT = 8001;

const cameraPool = new CameraWorkerPool();
const cameraManager = new CameraManager();

const server = http.createServer(async (req, res) => {
    // API Route for syncing camera (called when prompt is saved)
    if (req.method === 'POST' && req.url === '/api/engine/sync') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { camId } = JSON.parse(body);
                if (camId) {
                    await handleCameraSync(camId);

                    // Fetch userId and trigger quota redistribution
                    const { data: cam } = await supabase.from('cameras').select('user_id').eq('id', camId).single();
                    if (cam?.user_id) {
                        await quotaManager.recalculateAllocation(cam.user_id);
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // API Route for deleting camera
    if (req.method === 'POST' && req.url === '/api/engine/delete') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { camId, userId } = JSON.parse(body);
                if (camId) {
                    console.log(`[Engine] Stopping worker for deleted camera: ${camId}`);
                    cameraPool.stopWorker(camId);

                    if (userId) {
                        await quotaManager.recalculateAllocation(userId);
                    } else {
                        // Fallback: If frontend didn't send userId in delete, try fetching before it's gone
                        // (Though if it's already deleted in DB, this might fail, but let's try)
                        const { data: cam } = await supabase.from('cameras').select('user_id').eq('id', camId).single();
                        if (cam?.user_id) await quotaManager.recalculateAllocation(cam.user_id);
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // API Route for receiving webcam frames from frontend
    if (req.method === 'POST' && req.url === '/api/engine/analyze-frame') {
        // Since base64 frames can be large, we need to accumulate chunks
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);

                // Route webcam frames through the CameraWorker's YOLO pipeline
                const worker = cameraPool.workers.get(data.cameraId);

                let activeBoxes = [];
                if (worker) {
                    const buffer = Buffer.from(data.frameBase64, 'base64');
                    // We must convert the raw JPEG into the format ffmpeg would output if needed, or directly pass it.
                    // Actually, processFrame expects a JPEG buffer! (starting with 0xff 0xd8)
                    worker.processFrame(buffer).catch(e => console.error('[Engine] Webcam processFrame error:', e.message));

                    // Get the camera's required objects from its AI metadata (set by prompt extraction)
                    const aiMeta = worker.config.ai_metadata || {};
                    const requiredObjects = (aiMeta.objects || []).map(o => o.toLowerCase());
                    const ignoreObjects = (aiMeta.ignore_objects || []).map(o => o.toLowerCase());

                    for (const [id, obj] of worker.tracker.objects.entries()) {
                        const b = obj.box;
                        if (!b || obj.disappearedFrames > 0) continue;

                        // Only show boxes with >= 55% confidence — filters out YOLO noise/hallucinations
                        if (b.confidence < 0.55) continue;

                        // Skip objects the prompt says to ignore
                        const labelLower = (obj.label || '').toLowerCase();
                        if (ignoreObjects.some(ig => labelLower.includes(ig))) continue;

                        // If the prompt has specific required objects, only show matching boxes.
                        // If requiredObjects is empty (vague prompt), show all above-threshold boxes.
                        if (requiredObjects.length > 0) {
                            const isRelevant = requiredObjects.some(req => labelLower.includes(req) || req.includes(labelLower));
                            if (!isRelevant) continue;
                        }

                        // YOLO boxes are normalized 0-1 — scale to 320x180 capture-canvas space
                        activeBoxes.push({
                            id,
                            box: [
                                b.x1 * 320,
                                b.y1 * 180,
                                b.x2 * 320,
                                b.y2 * 180
                            ],
                            label: obj.label,
                            confidence: Math.round(b.confidence * 100)
                        });
                    }
                } else {
                    console.warn(`[Engine] No active CameraWorker found for webcam ${data.cameraId}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Frame queued for analysis', activeBoxes }));
            } catch (err) {
                console.error('[Engine] Error queuing frame:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

// WebSocket Server for High-Performance Webcam Streaming & RTSP Live Box Sync
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    // Basic Auth Check
    const urlParts = new URL(req.url, `http://${req.headers.host}`);
    const token = urlParts.searchParams.get('token');
    // If the frontend doesn't supply a token yet, allow it to prevent breaking, but flag it
    if (token) {
        ws.userId = token; // simplified auth
    }

    // Keep track of which cameras this specific client wants to receive tracking boxes for
    ws.subscribedCameras = new Set();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Handle subscription to camera rooms
            if (data.action === 'subscribe' && data.cameraId) {
                if (ws.userId) {
                    const { data: cam } = await supabase.from('cameras').select('user_id').eq('id', data.cameraId).single();
                    if (cam && cam.user_id === ws.userId) {
                        ws.subscribedCameras.add(data.cameraId);
                    } else {
                        ws.send(JSON.stringify({ error: 'Unauthorized camera subscription' }));
                    }
                } else {
                    // Fallback to allow unauthenticated legacy clients during transition
                    ws.subscribedCameras.add(data.cameraId);
                }
                return;
            }
            if (data.action === 'unsubscribe' && data.cameraId) {
                ws.subscribedCameras.delete(data.cameraId);
                return;
            }
            if (data.action === 'update_prompt' && data.cameraId && data.promptText !== undefined) {
                const worker = cameraPool.workers.get(data.cameraId);
                if (worker) {
                    worker.applyInstantPrompt(data.promptText);
                }
                return;
            }

            const worker = cameraPool.workers.get(data.cameraId);
            let activeBoxes = [];

            if (worker) {
                if (data.frameBase64) {
                    const buffer = Buffer.from(data.frameBase64, 'base64');
                    worker.processFrame(buffer).catch(e => console.error('[Engine] WS Webcam processFrame error:', e.message));
                }

                const aiMeta = worker.config.ai_metadata || {};
                const requiredObjects = (aiMeta.objects || []).map(o => o.toLowerCase());
                const ignoreObjects = (aiMeta.ignore_objects || []).map(o => o.toLowerCase());

                for (const [id, obj] of worker.tracker.objects.entries()) {
                    const b = obj.box;
                    if (!b || obj.disappearedFrames > 0) continue;

                    if (b.confidence < 0.55) continue;

                    const labelLower = (obj.label || '').toLowerCase();
                    if (ignoreObjects.some(ig => labelLower.includes(ig))) continue;

                    if (requiredObjects.length > 0) {
                        const isRelevant = requiredObjects.some(req => labelLower.includes(req) || req.includes(labelLower));
                        if (!isRelevant) continue;
                    }

                    activeBoxes.push({
                        id,
                        box: [b.x1 * 320, b.y1 * 180, b.x2 * 320, b.y2 * 180],
                        label: obj.label,
                        confidence: Math.round(b.confidence * 100)
                    });
                }
            }

            ws.send(JSON.stringify({ cameraId: data.cameraId, activeBoxes }));
        } catch (err) {
            console.error('[Engine] WS Error processing frame:', err.message);
            ws.send(JSON.stringify({ error: err.message }));
        }
    });
});

// Broadcast all active tracker boxes to Redis PubSub for horizontal scaling
setInterval(() => {
    for (const [camId, worker] of cameraPool.workers.entries()) {
        const aiMeta = worker.config.ai_metadata || {};
        const requiredObjects = (aiMeta.objects || []).map(o => o.toLowerCase());
        const ignoreObjects = (aiMeta.ignore_objects || []).map(o => o.toLowerCase());

        let activeBoxes = [];
        for (const [id, obj] of worker.tracker.objects.entries()) {
            const b = obj.box;
            if (!b || obj.disappearedFrames > 0) continue;

            if (b.confidence < 0.55) continue;

            const labelLower = (obj.label || '').toLowerCase();
            if (ignoreObjects.some(ig => labelLower.includes(ig))) continue;

            if (requiredObjects.length > 0) {
                const isRelevant = requiredObjects.some(req => labelLower.includes(req) || req.includes(labelLower));
                if (!isRelevant) continue;
            }

            activeBoxes.push({
                id,
                box: [b.x1 * 320, b.y1 * 180, b.x2 * 320, b.y2 * 180],
                label: obj.label,
                confidence: Math.round(b.confidence * 100)
            });
        }

        if (wss.clients.size > 0) {
            const msg = JSON.stringify({ cameraId: camId, activeBoxes });
            redisConnection.publish('camera_tracking_updates', msg).catch(e => console.error('[Engine] PubSub Publish Error:', e.message));
        }
    }
}, 500);

// Subscribe to Redis PubSub and forward to connected WebSocket clients
const wsRedisSubscriber = redisConnection.duplicate();
wsRedisSubscriber.on('ready', () => {
    wsRedisSubscriber.subscribe('camera_tracking_updates', (err) => {
        if (err) console.error('[Engine] PubSub subscribe error:', err.message);
    });
});
wsRedisSubscriber.on('reconnecting', () => {
    console.log('[Engine] PubSub subscriber reconnecting...');
});

wsRedisSubscriber.on('message', (channel, message) => {
    if (channel === 'camera_tracking_updates') {
        if (wss.clients.size === 0) return;
        
        try {
            const data = JSON.parse(message);
            for (const client of wss.clients) {
                if (client.readyState === 1 && client.subscribedCameras && client.subscribedCameras.has(data.cameraId)) { 
                    client.send(message);
                }
            }
        } catch (e) {
            console.error('[Engine] WS PubSub processing error:', e.message);
        }
    }
});

async function handleCameraSync(camId) {
    console.log(`[Engine] Syncing camera ${camId}...`);
    console.trace('[Engine] handleCameraSync stack trace:');

    const { data: cam } = await supabase
        .from('cameras')
        .select('user_id')
        .eq('id', camId)
        .single();
        
    const userId = cam?.user_id || 'unknown';

    // Fetch ALL active zones for this camera
    const { data: zones } = await supabase
        .from('camera_zones')
        .select('*')
        .eq('camera_id', camId)
        .eq('enabled', true);

    const availableZones = (zones || []).map(z => ({
        id: z.id,
        name: z.name
    }));

    // Cache zones in Redis for the CameraWorker
    try {
        if (zones && zones.length > 0) {
            await redisConnection.set(`user:${userId}:camera:${camId}:zones`, JSON.stringify(zones));
        } else {
            await redisConnection.del(`user:${userId}:camera:${camId}:zones`);
        }
    } catch (error) {
        console.error(`[Engine] Failed to cache camera zones in Redis:`, error.message);
    }

    // Fetch ALL active prompts/rules for this camera
    const { data: prompts } = await supabase
        .from('camera_prompts')
        .select('*')
        .eq('camera_id', camId);

    if (prompts && prompts.length > 0) {
        const compiledRules = [];
        
        for (const promptRow of prompts) {
            const ruleId = promptRow.id;
            const version = promptRow.version || 1;
            const promptText = promptRow.prompt_text;
            
            console.log(`[Engine] Compiling rule ${ruleId} for camera ${camId}...`);
            const compiledRule = await compilePrompt(userId, camId, ruleId, version, promptText, availableZones);
            
            if (compiledRule.compilation_status === 'SUCCESS') {
                compiledRules.push(compiledRule);
            }
        }

        // Store array of compiled rules in Redis with tenant isolation
        try {
            await redisConnection.set(`user:${userId}:camera:${camId}:rules`, JSON.stringify(compiledRules));
            console.log(`[Engine] Successfully cached ${compiledRules.length} compiled rules in Redis for camera ${camId}`);
        } catch (error) {
            console.error(`[Engine] Failed to cache camera rules in Redis:`, error.message);
        }
    } else {
        // Clear any old rules if none exist
        await redisConnection.del(`user:${userId}:camera:${camId}:rules`);
    }

    await cameraPool.syncCamera(camId);
}


async function startEngine() {
    console.log('[Engine] Starting Hybrid Detection Engine...');

    quotaManager.startDailyResetLoop();

    try {
        console.log('[Engine] Bypassing geminiQueue.obliterate() to preserve pending background tasks.');
    } catch (e) { }

    startGeminiWorkers();
    startProfileEngine();

    const crypto = require('crypto');
    const SERVER_ID = crypto.randomUUID();
    console.log(`[Engine] Server ID: ${SERVER_ID}`);

    async function claimCamera(camId) {
        const lockKey = `lock:camera:${camId}`;
        const acquired = await redisConnection.set(lockKey, SERVER_ID, 'EX', 15, 'NX');
        if (acquired === 'OK') return true;
        
        const owner = await redisConnection.get(lockKey);
        if (owner === SERVER_ID) {
            await redisConnection.expire(lockKey, 15);
            return true;
        }
        return false;
    }

    async function runHeartbeat() {
        try {
            const { data: cameras, error } = await supabase
                .from('cameras')
                .select('id, rtsp_url, username, password_encrypted, status, user_id')
                .eq('status', 'Online');

            if (error) {
                console.error('[Engine] runHeartbeat DB Error:', error.message);
                return;
            }
            if (!cameras) return;
            // console.log(`[Engine] runHeartbeat found ${cameras.length} Online cameras.`);
            const activeCamIds = new Set(cameras.map(c => c.id));

            for (const cam of cameras) {
                const isClaimed = await claimCamera(cam.id);
                const isRunningLocally = cameraPool.workers.has(cam.id);

                if (isClaimed) {
                    if (!isRunningLocally) {
                        console.log(`[Engine] Claimed camera ${cam.id}. Starting worker on this server...`);
                        try {
                            const isWebcam = cam.rtsp_url && cam.rtsp_url.startsWith('webcam://');
                            if (!isWebcam && cam.rtsp_url) {
                                cam.connectionType = 'rtsp';
                                cam.rtsp_url = cryptoUtils.decrypt(cam.rtsp_url);
                                if (cam.username) cam.username = cryptoUtils.decrypt(cam.username);
                                if (cam.password_encrypted) cam.password = cryptoUtils.decrypt(cam.password_encrypted);
                                await cameraManager.addCamera(cam);
                            }

                            const cachedMetadata = await redisConnection.get(`camera:${cam.id}:ai_metadata`);
                            if (cachedMetadata) {
                                cam.ai_metadata = JSON.parse(cachedMetadata);
                                await cameraPool.startWorker(cam);
                            } else {
                                await handleCameraSync(cam.id);
                            }
                        } catch (err) {
                            console.error(`[Engine] Error starting claimed camera ${cam.id}:`, err.message);
                        }
                    }
                } else {
                    if (isRunningLocally) {
                        console.warn(`[Engine] Lost lock for camera ${cam.id}. Stopping worker.`);
                        await cameraPool.stopWorker(cam.id);
                    }
                }
            }

            for (const [camId, worker] of cameraPool.workers.entries()) {
                if (!activeCamIds.has(camId)) {
                    console.log(`[Engine] Camera ${camId} no longer online. Stopping worker.`);
                    await cameraPool.stopWorker(camId);
                    await redisConnection.del(`lock:camera:${camId}`);
                }
            }
        } catch (e) {
            console.error('[Engine] Heartbeat error:', e.message);
        }
    }

    runHeartbeat();
    setInterval(runHeartbeat, 5000);

    server.listen(PORT, () => {
        console.log(`[Engine] Orchestrator running on port ${PORT}`);
    });

    // Start hourly background storage cleanup
    setInterval(() => {
        cleanupOrphanedStorage().catch(err => console.error('[Storage Cleanup] Error:', err.message));
    }, 60 * 60 * 1000);
    // Run it once on startup after 5 minutes
    setTimeout(() => {
        cleanupOrphanedStorage().catch(err => console.error('[Storage Cleanup] Error:', err.message));
    }, 5 * 60 * 1000);

}

async function cleanupOrphanedStorage() {
    try {
        console.log('[Storage Cleanup] Checking for orphaned files...');
        const { data, error } = await supabase.from('pending_storage_deletions').select('id, file_path').limit(500);
        
        if (error) {
            console.error('[Storage Cleanup] Error fetching pending deletions:', error.message);
            return;
        }

        if (!data || data.length === 0) {
            console.log('[Storage Cleanup] No orphaned files to delete.');
            return;
        }

        const filePaths = data.map(d => d.file_path);
        const ids = data.map(d => d.id);

        console.log(`[Storage Cleanup] Deleting ${filePaths.length} orphaned files from storage...`);
        
        const { error: storageErr } = await supabase.storage.from('snapshots').remove(filePaths);
        if (storageErr) {
            console.error('[Storage Cleanup] Error deleting files from storage:', storageErr.message);
            return;
        }

        // Clean up the pending table
        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            await supabase.from('pending_storage_deletions').delete().in('id', chunk);
        }
        
        console.log(`[Storage Cleanup] Successfully removed ${filePaths.length} orphaned files.`);
    } catch (err) {
        console.error('[Storage Cleanup] Unhandled error during storage cleanup:', err.message);
    }
}

async function releaseLocks() {
    console.log('[Engine] Releasing camera locks...');
    for (const camId of cameraPool.workers.keys()) {
        await redisConnection.del(`lock:camera:${camId}`);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('[Engine] Shutting down...');
    await releaseLocks();
    await cameraPool.shutdownAll();
    process.exit(0);
});
process.on('SIGINT', async () => {
    console.log('[Engine] Shutting down...');
    await releaseLocks();
    await cameraPool.shutdownAll();
    process.exit(0);
});

startEngine();
