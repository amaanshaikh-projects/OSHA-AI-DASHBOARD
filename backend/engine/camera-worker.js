const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { YoloDetector } = require('./yolo-detector.js');
const { geminiQueue, redisConnection } = require('./queue-manager.js');
const healthController = require('./health-controller.js');
const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = require('../config.js');
const { ObjectTracker } = require('./tracker.js');
const sharp = require('sharp');
const { AdaptiveFrameController } = require('./adaptive-sampler');
sharp.cache(false); // Disable sharp cache to prevent memory leaks from unique frames
const { sendAlertEmail } = require('./email-service.js');
const cryptoUtils = require('../utils/crypto.js');
const { getPlanAlertLimit, getWeekKey, getPlanApiLimit } = require('../utils/shared-utils');
const quotaManager = require('./quota-manager.js');

// ── ROI Configuration ──
// Threshold of 50 represents approx 20% change on a 0-255 scale.
// Raised from 38 → 50 to prevent RTSP compression artifacts (H.264/H.265 quantization noise)
// from falsely triggering "meaningful change" re-evaluations and causing excessive Gemini API calls.
const PIXEL_INTENSITY_THRESHOLD = 50;

// ── Zone Check Configuration ──
function pointInPolygon(point, vs) {
    var x = point.x, y = point.y;
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        var xi = vs[i].x, yi = vs[i].y;
        var xj = vs[j].x, yj = vs[j].y;
        var intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function boxIntersectsPolygon(box, polygon) {
    if (!polygon || polygon.length < 3) return true; // No valid polygon = anywhere is fine
    // Check if bottom-center of box is in polygon
    const cx = (box.x1 + box.x2) / 2;
    const cy = box.y2;
    return pointInPolygon({ x: cx, y: cy }, polygon);
}

// Helper to generate a lightweight 32x32 blurred grayscale signature of a specific bounding box
async function generateRoiSignature(buffer, box) {
    if (!buffer || !box) return null;
    try {
        const meta = await sharp(buffer).metadata();
        if (!meta.width || !meta.height) return null;

        const c1 = (v) => Math.max(0, Math.min(1, v));
        const left = Math.floor(c1(box.x1) * meta.width);
        const top = Math.floor(c1(box.y1) * meta.height);
        const w = Math.floor(c1(box.x2 - box.x1) * meta.width);
        const h = Math.floor(c1(box.y2 - box.y1) * meta.height);

        const sw = Math.min(w, meta.width - left);
        const sh = Math.min(h, meta.height - top);

        if (sw > 0 && sh > 0) {
            return await sharp(buffer)
                .extract({ left, top, width: sw, height: sh })
                .resize(32, 32)
                .grayscale()
                .blur(1.5) // Slight blur to eliminate noise
                .raw()
                .toBuffer();
        }
    } catch (e) {
        console.error('[CameraWorker] ROI Signature Error:', e.message);
    }
    return null;
}

// calculateMotionPercent replaced by checkMotion inside CameraWorker

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const detector = new YoloDetector();
const ZoneEngine = require('./zone-engine.js');
const reverificationEngine = require('./reverification-engine.js');
const negativeMemoryEngine = require('./negative-memory.js');

const globalCameraWorkers = new Map();

class CameraWorkerPool {
    constructor() {
        this.workers = new Map();
        this.syncPromises = new Map();
        detector.init();

        // Setup Redis PubSub for Gemini results
        this.redisSubscriber = redisConnection.duplicate();
        this.redisSubscriber.subscribe('gemini_results', (err) => {
            if (err) console.error('[CameraWorkerPool] PubSub subscribe error:', err);
        });
        this.redisSubscriber.on('message', (channel, message) => {
            if (channel === 'gemini_results') {
                try {
                    const data = JSON.parse(message);
                    const worker = this.workers.get(data.camId);
                    if (worker && worker.handleGeminiResult) {
                        worker.handleGeminiResult(data);
                    }
                } catch (e) {
                    console.error('[CameraWorkerPool] PubSub message error:', e);
                }
            }
        });
    }

    async startWorker(cameraConfig) {
        if (this.workers.has(cameraConfig.id)) {
            await this.stopWorker(cameraConfig.id);
        }

        try {
            const { data: profile } = await supabase
                .from('profiles')
                .select('subscription_plan, subscription_status, email')
                .eq('id', cameraConfig.user_id)
                .single();
            cameraConfig.subscription_plan = profile?.subscription_plan || 'Free';
            cameraConfig.subscription_status = profile?.subscription_status || 'Active';
            cameraConfig.user_email = profile?.email || null;
        } catch (e) {
            console.error(`[CameraWorkerPool] Error fetching subscription_plan for user ${cameraConfig.user_id}:`, e.message);
            cameraConfig.subscription_plan = 'Free';
            cameraConfig.subscription_status = 'Active';
            cameraConfig.user_email = null;
        }

        if (cameraConfig.subscription_status === 'Trial Expired') {
            console.warn(`[CameraWorkerPool] User ${cameraConfig.user_id} trial is expired. Refusing to start camera ${cameraConfig.id}.`);
            return;
        }

        const worker = new CameraWorker(cameraConfig);
        this.workers.set(cameraConfig.id, worker);
        worker.start();
    }

    async stopWorker(camId) {
        const worker = this.workers.get(camId);
        if (worker) {
            worker.stop();
            this.workers.delete(camId);
        }
    }

    async syncCamera(camId) {
        let p = this.syncPromises.get(camId) || Promise.resolve();
        // Catch any previous errors so the chain can continue
        p = p.catch(e => console.error(`[CameraWorker] Previous sync error for ${camId}:`, e)).then(async () => {
            console.log(`[CameraWorker] syncCamera executing for ${camId}...`);
            const { data, error } = await supabase.from('cameras').select('*').eq('id', camId).maybeSingle();
            if (error) console.error(`[CameraWorker] Error fetching camera ${camId}:`, error.message);
            if (!data) {
                console.log(`[CameraWorker] Camera ${camId} not found in DB. Stopping worker.`);
                await this.stopWorker(camId);
                return;
            }
            if (data && data.status === 'Online') {
                if (data.type === 'rtsp' && data.rtsp_url) {
                    try {
                        data.rtsp_url = cryptoUtils.decrypt(data.rtsp_url);
                        if (data.username) data.username = cryptoUtils.decrypt(data.username);
                        if (data.password) data.password = cryptoUtils.decrypt(data.password);
                    } catch (e) {
                        console.error(`[CameraWorker] Error decrypting RTSP details for ${camId}:`, e.message);
                    }
                }

                // Load latest rules from Redis
                let newRules = [];
                try {
                    const cachedRules = await redisConnection.get(`user:${data.user_id}:camera:${camId}:rules`);
                    if (cachedRules) {
                        newRules = JSON.parse(cachedRules);
                    }
                    data.rules = newRules;
                } catch (e) {
                    console.error(`[CameraWorker] Error fetching rules for ${camId}`, e);
                }

                // Load latest zones from Redis
                let newZones = [];
                try {
                    const cachedZones = await redisConnection.get(`user:${data.user_id}:camera:${camId}:zones`);
                    if (cachedZones) {
                        newZones = JSON.parse(cachedZones);
                    }
                    data.zones = newZones;
                } catch (e) {
                    console.error(`[CameraWorker] Error fetching zones for ${camId}`, e);
                }

                const existingWorker = this.workers.get(camId);
                const existingMeta = existingWorker?.config?.rules ? JSON.stringify(existingWorker.config.rules) : '[]';
                const newMeta = JSON.stringify(newRules);
                const existingZonesMeta = existingWorker?.config?.zones ? JSON.stringify(existingWorker.config.zones) : '[]';
                const newZonesMeta = JSON.stringify(newZones);

                if (existingWorker && existingWorker.isRunning) {
                    if (existingMeta !== newMeta || existingZonesMeta !== newZonesMeta) {
                        console.log(`[CameraWorker] Camera ${camId} rules/zones changed. Hot-swapping config without restarting FFMPEG.`);
                        existingWorker.updateConfig(data);
                    } else {
                        console.log(`[CameraWorker] Camera ${camId} already running with same rules/zones. Skipping restart.`);
                    }
                    return;
                }

                console.log(`[CameraWorker] Camera ${camId} is Online. Starting worker.`);
                await this.startWorker(data);
            } else {
                console.log(`[CameraWorker] Camera ${camId} is NOT Active (status: ${data?.status}). Stopping worker.`);
                await this.stopWorker(camId);
            }
        });
        this.syncPromises.set(camId, p);

        try {
            await p;
        } catch (e) {
            console.error(`[CameraWorker] syncCamera failed for ${camId}:`, e);
        }
    }

    async shutdownAll() {
        for (const [id, worker] of this.workers.entries()) {
            worker.stop();
        }
        this.workers.clear();
    }
}

class CameraWorker {
    constructor(config) {
        this.config = config;
        this.ffmpegProcess = null;
        this.isRunning = false;

        this.fps = 1; // Initial default, soon managed by adaptive sampler
        this.frameController = new AdaptiveFrameController(this.config.id);
        this.lastFrameTime = 0;

        // Configure object tracker (Camera ID, 3 frames to confirm, 0.05 IoU, 30 frame memory)
        this.tracker = new ObjectTracker(this.config.id, 3, 0.05, 30);

        // Configure Zone Engine
        this.zoneEngine = new ZoneEngine();
        if (this.config.zones) {
            this.zoneEngine.loadZones(this.config.zones);
        }

        // Object-Level State Machine Map
        // Key: TrackerID_RuleID, Value: { id, rule_id, status: 'Pending'|'Verified'|'Rejected', ... }
        this.objectStates = new Map();

        // Initialized here (not lazily in processFrame) to avoid per-frame guard checks
        this.objectCooldowns = new Map();
        this.rejectedObjectBoxes = new Map();
        this.acceptedObjectBoxes = new Map();
        this.cachedSignatures = new Map();
        this.verifiedObjects = new Map();
        this.rejectedObjects = new Map();
        this.pendingObjects = new Map();

        this.lastDbUpdateTime = 0;

        // Smart Filtering & Snapshot Upgrade Window State
        this.isBuffering = false;
        this.bufferStartTime = 0;

        // Ring Buffer for Trigger Frame Freezing (stores last 30 frames / ~3 seconds at 10fps)
        this.frameBuffer = [];
        this.maxBufferSize = 30;

        // Frozen trigger frame / candidate snapshot
        this.bestFrame = null;
        this.lastYoloMatchCount = 0;

        // Motion Detection State
        this.bgFrame = null; // Float32Array for Exponential Moving Average background
        this.consecutiveMotionFrames = 0;

        // Watchdog: Force a YOLO check every 3 seconds even with no motion,
        // so slow-moving objects RTSP background subtraction misses are still caught.
        this.lastForcedYoloTime = 0;

        // In-memory stats aggregation for Camera Profile Engine
        this.statsBuffer = { motion: [], lighting: [] };
        this.lastStatsPushTime = Date.now();

        this.rules = this.config.rules || [];
        this.anyRuleRequiresAll = this.rules.some(r => r.local_conditions.objects.length === 0);
        this.requiredClasses = new Set();
        this.rules.forEach(r => r.local_conditions.objects.forEach(obj => this.requiredClasses.add(obj.toLowerCase())));
        this.ignoreClasses = new Set(); // Deprecated in new compiler, kept for safety
    }

    updateConfig(newConfig) {
        console.log(`[CameraWorker] Hot-swapping config for ${this.config.name} (Camera ${this.config.id})...`);
        this.config = newConfig;

        this.rules = this.config.rules || [];
        this.anyRuleRequiresAll = this.rules.some(r => r.local_conditions.objects.length === 0);
        this.requiredClasses = new Set();
        this.rules.forEach(r => r.local_conditions.objects.forEach(obj => this.requiredClasses.add(obj.toLowerCase())));
        this.ignoreClasses = new Set();
        
        if (this.config.zones) {
            this.zoneEngine.loadZones(this.config.zones);
        }

        // Wipe all tracking states and cooldowns so the new prompt evaluates fresh immediately.
        this.objectStates.clear();
        this.objectCooldowns.clear();
        this.rejectedObjectBoxes.clear();
        this.acceptedObjectBoxes.clear();
        this.cachedSignatures.clear();
        this.verifiedObjects.clear();
        this.rejectedObjects.clear();
        this.pendingObjects.clear();
        this.tracker = new ObjectTracker(this.config.id, 3, 0.05, 30); // Reset tracker IDs
        this.frameController = new AdaptiveFrameController(this.config.id);

        // Reset frame buffers
        this.bestFrame = null;
        this.consecutiveMotionFrames = 0;
        this.lastYoloMatchCount = 0;

        console.log(`[CameraWorker] Tracking memory wiped for seamless prompt hot-swap.`);
    }

    async handleGeminiResult(data) {
        if (data.status === 'MATCH') {
            const matchedIds = data.matchedIds || [];
            const rejectedIds = data.rejectedIds || [];
            const processedEventIds = data.eventIds || [];

            const isContinuing = data.event_state === 'continuing';
            const cooldownMs = isContinuing ? 120000 : 30000; // 2 minutes if continuing, 30s if new

            for (const id of matchedIds) {
                const state = this.objectStates.get(id);
                if (state && processedEventIds.includes(state.eventId)) {
                    if (state.firstVerifiedTime === 0) state.firstVerifiedTime = Date.now();
                    state.lastVerificationTime = Date.now();
                    state.lastSeen = Date.now();
                    state.status = 'Verified';
                    state.semantic_state_version += 1;
                    if (data.semantic_state) {
                        state.last_verified_state = data.semantic_state;
                    }
                    console.log(`[EVENT] Event ${state.eventId} → Gemini VERIFIED (version ${state.semantic_state_version})`);
                }
            }
            for (const id of rejectedIds) {
                const state = this.objectStates.get(id);
                if (state && processedEventIds.includes(state.eventId)) {
                    state.lastVerificationTime = Date.now();
                    state.lastSeen = Date.now();
                    state.status = 'Rejected';
                }
            }
        } else if (data.status === 'NO_MATCH') {
            const processedEventIds = data.eventIds || [];
            for (const id of data.trackedIds || []) {
                const state = this.objectStates.get(id);
                if (state && processedEventIds.includes(state.eventId)) {
                    state.lastVerificationTime = Date.now();
                    state.lastSeen = Date.now();
                    state.status = 'Rejected';
                    state.consecutiveRejections = (state.consecutiveRejections || 0) + 1;
                    if (data.semantic_state) {
                        state.last_verified_state = data.semantic_state; // Store negative semantics
                    }

                    console.log(`[NEGATIVE_MEMORY] Event ${state.eventId} / Track ${id} / Rule ${state.rule_id} → Gemini REJECTED`);
                    
                    const rule = this.rules.find(r => r.rule_id === state.rule_id);
                    if (rule) {
                        const cooldownUntil = await negativeMemoryEngine.setMemory(
                            rule.user_id, this.config.id, rule.rule_id, rule.rule_version, state.eventId, id, state
                        );
                        state.cooldownExpiresAt = cooldownUntil;
                    }
                }
            }
        } else if (data.status === 'ERROR') {
            const processedEventIds = data.eventIds || [];
            for (const id of data.trackedIds || []) {
                const state = this.objectStates.get(id);
                if (state && processedEventIds.includes(state.eventId)) {
                    state.status = 'Rejected';
                    state.cooldownExpiresAt = Date.now() + 10000;
                    state.lastVerificationTime = Date.now();
                }
            }
        }
    }

    async start() {
        console.log(`[CameraWorker] Starting Gemini-Centric Stream for ${this.config.name}`);
        this.isRunning = true;
        this.startFfmpeg();

        // Enforce Free Tier 20 minute live limit
        try {
            const { data: profile } = await supabase.from('profiles').select('subscription_plan').eq('id', this.config.user_id).single();
            if (profile && profile.subscription_plan === 'Free') {
                this.usageInterval = setInterval(async () => {
                    if (!this.isRunning) return;
                    try {
                        const weekKey = getWeekKey();
                        const key = `live_minutes:user:${this.config.user_id}:weekly:${weekKey}`;
                        const current = await redisConnection.incr(key);
                        await redisConnection.expire(key, 86400 * 8); // Auto reset every week
                        console.log(`[CameraWorker] Free Plan user ${this.config.user_id} used ${current}/20 minutes.`);
                        if (current > 20) {
                            console.log(`[CameraWorker] Free Plan user ${this.config.user_id} exceeded 20 minute limit. Stopping camera ${this.config.id}`);
                            this.stop();
                            await supabase.from('cameras').update({ status: 'Paused' }).eq('id', this.config.id);
                            await supabase.from('profiles').update({ subscription_status: 'Trial Expired' }).eq('id', this.config.user_id);
                        }
                    } catch (e) {
                        console.error('[CameraWorker] Error tracking free tier usage:', e);
                    }
                }, 60 * 1000); // Check every minute
            }
        } catch (e) {
            console.error('[CameraWorker] Error setting up free tier usage tracking:', e);
        }
    }

    stop() {
        console.log(`[CameraWorker] Stopping stream for ${this.config.name}`);
        this.isRunning = false;
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGKILL');
            this.ffmpegProcess = null;
        }
        if (this.usageInterval) {
            clearInterval(this.usageInterval);
            this.usageInterval = null;
        }
        if (this.ffmpegWatchdog) {
            clearInterval(this.ffmpegWatchdog);
            this.ffmpegWatchdog = null;
        }
    }

    startFfmpeg() {
        if (this.config.rtsp_url.startsWith('webcam://')) {
            console.log(`[CameraWorker] Camera ${this.config.name} is a browser webcam. Waiting for frames via HTTP...`);
            return;
        }

        const args = [
            '-loglevel', 'error',
            '-rtsp_transport', 'tcp',
            '-threads', '1',          // FIX: Prevent thread-choking
            '-i', this.config.rtsp_url,
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            '-q:v', '5',              // FIX: Lower JPEG compression overhead
            '-r', '10', // Dynamically controlled by processFrame up to 10 FPS
            '-vf', 'scale=640:-2',    // FIX: Downscale to 640px (75% less CPU)
            'pipe:1'
        ];

        this.ffmpegProcess = spawn(ffmpegPath, args);
        let chunks = [];
        let chunksLen = 0;
        this.lastFrameReceivedAt = Date.now();

        if (this.ffmpegWatchdog) {
            clearInterval(this.ffmpegWatchdog);
        }
        this.ffmpegWatchdog = setInterval(() => {
            if (this.isRunning && this.ffmpegProcess) {
                const elapsed = Date.now() - this.lastFrameReceivedAt;
                if (elapsed > 30000) { // 30 seconds
                    console.error(`[CameraWorker] 🚨 Watchdog Triggered: No frames received from ${this.config.name} for 30s. Force killing zombie FFmpeg process.`);
                    try {
                        this.ffmpegProcess.kill('SIGKILL');
                    } catch (e) {
                        console.error('[CameraWorker] Watchdog kill error:', e);
                    }
                }
            }
        }, 10000); // Check every 10 seconds

        this.ffmpegProcess.on('error', (err) => {
            console.error(`[CameraWorker] FFmpeg spawn error for ${this.config.name}:`, err.message);
        });

        this.ffmpegProcess.stdout.on('data', (chunk) => {
            chunks.push(chunk);
            chunksLen += chunk.length;

            const eoiIndex = chunk.indexOf(Buffer.from([0xff, 0xd9]));
            if (eoiIndex === -1 && chunksLen < 1024 * 512) {
                return;
            }

            let buffer = Buffer.concat(chunks, chunksLen);

            let startIdx = buffer.indexOf(Buffer.from([0xff, 0xd8]));
            let endIdx = buffer.indexOf(Buffer.from([0xff, 0xd9]));

            let latestFrame = null;

            // Extract all complete frames in the buffer, but only keep the most recent one
            while (startIdx !== -1 && endIdx !== -1) {
                if (endIdx > startIdx) {
                    latestFrame = buffer.subarray(startIdx, endIdx + 2);
                    buffer = buffer.subarray(endIdx + 2);
                } else {
                    // Trailing garbage (EOI before SOI). Slice to SOI to recover stream sync.
                    buffer = buffer.subarray(startIdx);
                }

                startIdx = buffer.indexOf(Buffer.from([0xff, 0xd8]));
                endIdx = buffer.indexOf(Buffer.from([0xff, 0xd9]));
            }

            if (latestFrame) {
                this.lastFrameReceivedAt = Date.now();
            }

            // Emergency buffer reset to prevent massive latency/memory spikes on corrupted streams
            if (startIdx === -1 && buffer.length > 1024 * 512) {
                // No start marker found in >500KB of data. Keep last byte in case FF D8 is split across chunks.
                buffer = buffer.slice(-1);
            } else if (buffer.length > 1024 * 1024 * 5) {
                // Absolute fallback (5MB) if end markers are missing
                buffer = Buffer.alloc(0);
            }

            chunks = [buffer];
            chunksLen = buffer.length;

            // Only process the freshest frame, and completely drop frames if YOLO is currently busy processing one.
            // This guarantees absolutely 0 lag and prevents memory/CPU spirals.
            if (latestFrame && !this.isProcessingRTSP) {
                this.isProcessingRTSP = true;
                this.processFrame(latestFrame).catch(e => {
                    console.error('[CameraWorker] processFrame error:', e.message);
                }).finally(() => {
                    this.isProcessingRTSP = false;
                });
            }
        });

        this.ffmpegProcess.stderr.on('data', (d) => { console.log(`[CameraWorker] FFmpeg error: ${d.toString()}`) });

        this.ffmpegProcess.on('close', () => {
            if (this.isRunning) {
                console.log(`[CameraWorker] Stream closed for ${this.config.name}. Restarting in 5s...`);
                setTimeout(() => this.startFfmpeg(), 5000);
            }
        });
    }

    /**
     * Highly optimized motion detection using:
     * 1. Background Subtraction (EMA)
     * 2. Spatial Masking (Ignore timestamps)
     * 3. Block-Based Density (Quadrants)
     */
    async checkMotion(frameBuffer) {
        if (!frameBuffer) return { percent: 0, boxes: [] };
        try {
            const SIZE = 128;
            const bNew = await sharp(frameBuffer).resize(SIZE, SIZE).grayscale().blur(2.5).raw().toBuffer();

            // Initialize background frame on first run
            if (!this.bgFrame || this.bgFrame.length !== bNew.length) {
                this.bgFrame = new Float32Array(bNew.length);
                for (let i = 0; i < bNew.length; i++) this.bgFrame[i] = bNew[i];
                return { percent: 0, boxes: [] }; // No motion on first frame
            }

            const alpha = 0.1; // 10% blend for moving average
            const profile = this.config.camera_profile || {};
            const threshold = profile.noise_floor !== undefined && profile.noise_floor !== null
                ? profile.noise_floor
                : 45;
            const activePixels = new Uint8Array(SIZE * SIZE);
            let activeCount = 0;
            let totalLightingChange = 0;
            let lightingPixels = 0;

            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    const i = y * SIZE + x;
                    const newPixel = bNew[i];

                    // Spatial Masking: Ignore top-right and bottom-right corners (timestamps)
                    // Scaled for 128x128: Right 40%, Top 20%, Bottom 20%
                    if (x > (SIZE * 0.6) && (y < (SIZE * 0.2) || y > (SIZE * 0.8))) {
                        this.bgFrame[i] = newPixel; // Update bg but don't check motion
                        continue;
                    }

                    const bgPixel = this.bgFrame[i];
                    const diff = Math.abs(bgPixel - newPixel);
                    totalLightingChange += diff;
                    lightingPixels++;

                    if (diff > threshold) {
                        activePixels[i] = 1;
                        activeCount++;
                    }

                    // Update background with Exponential Moving Average
                    this.bgFrame[i] = bgPixel * (1 - alpha) + newPixel * alpha;
                }
            }

            const avgLighting = lightingPixels > 0 ? (totalLightingChange / lightingPixels) : 0;

            if (activeCount === 0) return { percent: 0, boxes: [] };

            // Connected Component Labeling (BFS) to find contours
            const visited = new Uint8Array(SIZE * SIZE);
            let blobs = [];
            const dx = [-1, 1, 0, 0, -1, -1, 1, 1];
            const dy = [0, 0, -1, 1, -1, 1, -1, 1];

            for (let i = 0; i < SIZE * SIZE; i++) {
                if (activePixels[i] && !visited[i]) {
                    let minX = SIZE, maxX = 0, minY = SIZE, maxY = 0;
                    let area = 0;

                    const queue = [i];
                    visited[i] = 1;

                    let qIdx = 0;
                    while (qIdx < queue.length) {
                        const curr = queue[qIdx++];
                        const cx = curr % SIZE;
                        const cy = Math.floor(curr / SIZE);

                        if (cx < minX) minX = cx;
                        if (cx > maxX) maxX = cx;
                        if (cy < minY) minY = cy;
                        if (cy > maxY) maxY = cy;
                        area++;

                        for (let d = 0; d < 8; d++) {
                            const nx = cx + dx[d];
                            const ny = cy + dy[d];
                            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
                                const ni = ny * SIZE + nx;
                                if (activePixels[ni] && !visited[ni]) {
                                    visited[ni] = 1;
                                    queue.push(ni);
                                }
                            }
                        }
                    }

                    if (area >= 20) { // minimum contour area
                        blobs.push({ minX, minY, maxX, maxY, area });
                    }
                }
            }

            // Merge nearby bounding boxes
            let merged = true;
            const MERGE_DIST = 8; // Distance to merge (out of 128)
            while (merged) {
                merged = false;
                for (let i = 0; i < blobs.length; i++) {
                    for (let j = i + 1; j < blobs.length; j++) {
                        const b1 = blobs[i];
                        const b2 = blobs[j];

                        // Check if inflated boxes overlap
                        if (
                            b1.minX - MERGE_DIST <= b2.maxX + MERGE_DIST &&
                            b1.maxX + MERGE_DIST >= b2.minX - MERGE_DIST &&
                            b1.minY - MERGE_DIST <= b2.maxY + MERGE_DIST &&
                            b1.maxY + MERGE_DIST >= b2.minY - MERGE_DIST
                        ) {
                            // Merge b2 into b1
                            b1.minX = Math.min(b1.minX, b2.minX);
                            b1.maxX = Math.max(b1.maxX, b2.maxX);
                            b1.minY = Math.min(b1.minY, b2.minY);
                            b1.maxY = Math.max(b1.maxY, b2.maxY);
                            b1.area += b2.area;

                            blobs.splice(j, 1);
                            merged = true;
                            break;
                        }
                    }
                    if (merged) break;
                }
            }

            // Expand by 20% and normalize to 0.0 - 1.0 range
            const finalBoxes = blobs.map(b => {
                const w = Math.max(1, b.maxX - b.minX);
                const h = Math.max(1, b.maxY - b.minY);
                const expandX = w * 0.20;
                const expandY = h * 0.20;

                return {
                    x1: Math.max(0, (b.minX - expandX) / SIZE),
                    y1: Math.max(0, (b.minY - expandY) / SIZE),
                    x2: Math.min(1, (b.maxX + expandX) / SIZE),
                    y2: Math.min(1, (b.maxY + expandY) / SIZE),
                    area: b.area
                };
            });

            return { percent: activeCount / (SIZE * SIZE), boxes: finalBoxes, avgLighting };
        } catch (e) {
            console.error('[CameraWorker] checkMotion error:', e.message);
            return { percent: 0, boxes: [] };
        }
    }

    async processFrame(frameBuffer) {
        const now = Date.now();
        const isRTSP = !this.config.rtsp_url.startsWith('webcam://');

        // Cleanup old tracking states to prevent memory leaks (15s expiry for Lost Objects)
        // Moved to the top of processFrame so it doesn't get bypassed by idle early-returns.
        for (const [stateKey, state] of this.objectStates.entries()) {
            if (now - state.lastSeen > 15000) {
                console.log(`[EVENT] Event ${state.eventId} → Object missing`);
                console.log(`[EVENT] Event ${state.eventId} → ENDED`);
                redisConnection.incr('events_ended').catch(()=>{});

                this.objectStates.delete(stateKey);
                this.objectCooldowns.delete(stateKey);
                this.rejectedObjectBoxes.delete(stateKey);
                this.acceptedObjectBoxes.delete(stateKey);
                this.cachedSignatures.delete(stateKey);
                this.verifiedObjects.delete(stateKey);
                this.rejectedObjects.delete(stateKey);
                this.pendingObjects.delete(stateKey);
            }
        }


        // Motion Detection & Debouncing
        const motionData = await this.checkMotion(frameBuffer);
        const motionPercent = motionData.percent;
        const avgLighting = motionData.avgLighting || 0;
        const motionBoxes = motionData.boxes || [];

        // --- IN-MEMORY STATS AGGREGATION ---
        // Collect samples every ~1 second (when active) or idle
        if (now - (this.lastTelemetryTime || 0) >= 1000) {
            this.lastTelemetryTime = now;
            if (motionPercent > 0) this.statsBuffer.motion.push(motionPercent);
            if (avgLighting > 0) this.statsBuffer.lighting.push(avgLighting);

            // Push hourly aggregated stats to Redis
            if (now - this.lastStatsPushTime >= 3600000) {
                this.lastStatsPushTime = now;
                const camId = this.config.id;

                const calculatePercentile = (data, p) => {
                    if (data.length === 0) return 0;
                    const sorted = [...data].sort((a, b) => a - b);
                    return sorted[Math.ceil((p / 100) * sorted.length) - 1];
                };

                const p95Motion = calculatePercentile(this.statsBuffer.motion, 95);
                const p90Lighting = calculatePercentile(this.statsBuffer.lighting, 90);

                // Send aggregated stats for the past hour to Redis
                try {
                    const pipeline = redisConnection.pipeline();
                    pipeline.lpush(`profile_stats:cam:${camId}:motion`, p95Motion);
                    pipeline.ltrim(`profile_stats:cam:${camId}:motion`, 0, 24); // Keep 24 hours of hourly stats
                    pipeline.lpush(`profile_stats:cam:${camId}:lighting`, p90Lighting);
                    pipeline.ltrim(`profile_stats:cam:${camId}:lighting`, 0, 24);
                    pipeline.exec().catch(() => { });
                } catch (e) { }

                // Reset buffers
                this.statsBuffer = { motion: [], lighting: [] };
            }
        }

        // BUG FIX: Raised from 0.0018 → 0.004 to filter RTSP compression noise.
        // On a 128×128 grid (16,384 pixels), 0.0018 = ~30 pixels — easily exceeded by
        // H.264/H.265 compression artifacts alone, keeping the motion gate permanently open.
        // 0.004 = ~65 pixels — well above the RTSP compression noise floor.
        const defaultMotionThreshold = isRTSP ? 0.004 : 0.0018;
        const profile = this.config.camera_profile || {};
        const motionThreshold = profile.motion_baseline !== undefined && profile.motion_baseline !== null
            ? profile.motion_baseline
            : defaultMotionThreshold;
        const hasMotionNow = motionPercent >= motionThreshold;

        if (hasMotionNow) {
            this.consecutiveMotionFrames++;
            this.noMotionFrames = 0;
        } else {
            this.noMotionFrames = (this.noMotionFrames || 0) + 1;
            // 10-frame grace period: if motion stops for just a moment, don't clear boxes immediately
            if (this.noMotionFrames > 10) {
                this.consecutiveMotionFrames = 0;
            }
        }

        // BUG FIX: Raised from 1 → 3 for RTSP streams. A single frame of compression noise
        // was keeping hasGlobalMotion permanently true, defeating the critical motion gate at
        // line ~869 that prevents stationary objects from spamming Gemini API calls.
        // Webcams keep threshold at 1 since they don't have compression noise.
        const motionFrameThreshold = isRTSP ? 3 : 1;
        const hasGlobalMotion = this.consecutiveMotionFrames >= motionFrameThreshold;

        // Watchdog: Force YOLO every 3s regardless of motion to catch slow/still objects
        // that background subtraction misses in compressed RTSP streams.
        const timeSinceForced = now - this.lastForcedYoloTime;
        const forceYolo = isRTSP && timeSinceForced >= 3000;
        if (forceYolo) this.lastForcedYoloTime = now;

        // ADAPTIVE FRAME SAMPLING:
        // Update FPS based on current scene state (Motion, Tracker, Events)
        this.fps = this.frameController.getTargetFPS({
            hasMotion: hasGlobalMotion,
            activeTracks: this.tracker.objects,
            activeEvents: this.objectStates.size > 0
        });

        // Dynamic FPS Throttling
        const interval = 1000 / this.fps;
        if (now - this.lastFrameTime < interval) return;
        this.lastFrameTime = now;

        // YOLO Gating: Skip heavy YOLO inference only if no motion AND watchdog hasn't fired.
        // This keeps CPU usage low when idle but ensures objects are never permanently missed.
        if (isRTSP && !hasGlobalMotion && !this.isBuffering && !forceYolo) {
            this.tracker.update([]); // Clear UI bounding boxes
            return;
        }

        // YOLO as an Optional Pre-Filter
        let rawBoxes = await detector.detect(frameBuffer);

        // Log confidence telemetry if boxes were found
        if (rawBoxes && rawBoxes.length > 0 && now - (this.lastConfTelemetryTime || 0) >= 60000) {
            this.lastConfTelemetryTime = now;
            try {
                const avgConf = rawBoxes.reduce((acc, b) => acc + b.confidence, 0) / rawBoxes.length;
                const pipeline = redisConnection.pipeline();
                pipeline.lpush(`telemetry:cam:${this.config.id}:confidence`, avgConf);
                pipeline.ltrim(`telemetry:cam:${this.config.id}:confidence`, 0, 1440);
                pipeline.exec().catch(() => { });
            } catch (e) { }
        }

        // Check if any rule allows open-ended detection (empty objects list)
        const isModeB = this.anyRuleRequiresAll;

        if (isModeB && motionPercent > 0.002 && rawBoxes.length === 0) {
            // Mode B: Motion detected but YOLO found nothing. Feed localized motion boxes to trigger Gemini.
            if (motionBoxes.length > 0) {
                motionBoxes.forEach(box => {
                    rawBoxes.push({ x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, confidence: 0.5, classId: 999, label: 'motion' });
                });
            } else {
                rawBoxes.push({ x1: 0, y1: 0, x2: 1, y2: 1, confidence: 0.5, classId: 999, label: 'motion' });
            }
        }

        // --- EMERGENCY FIRE/SMOKE HEURISTIC BYPASS ---
        // Fire/smoke creates massive, continuous motion but is not in YOLO's dataset.
        // If we see large sustained motion and YOLO is blind, inject an emergency box to force Gemini to check.
        const isEmergencyMotion = motionPercent > 0.01 && this.consecutiveMotionFrames > 10;
        if (!isModeB && rawBoxes.length === 0 && isEmergencyMotion) {
            console.log(`[CameraWorker] ${this.config.name} - MASSIVE UNKNOWN MOTION DETECTED. Bypassing YOLO for Fire Check.`);
            rawBoxes.push({ x1: 0, y1: 0, x2: 1, y2: 1, confidence: 0.99, classId: 999, label: 'Unknown Motion' });
        }

        if (rawBoxes.length === 0 && !this.isBuffering) {
            this.tracker.update([]);
            return;
        }

        const filteredBoxes = rawBoxes.filter(box => {
            const boxLabel = box.label.toLowerCase();

            // AGGRESSIVE YOLO PRE-FILTERING
            if (!this.anyRuleRequiresAll && this.requiredClasses.size > 0) {
                return boxLabel === 'unknown motion' || this.requiredClasses.has(boxLabel);
            }
            return true;
        });

        // If YOLO found nothing relevant, drop the frame entirely. Do NOT hit Gemini. Do NOT update tracker.
        if (filteredBoxes.length === 0) {
            if (!this.isBuffering) {
                this.tracker.update([]);
            }
            return;
        }

        let priority = 5;
        for (const box of filteredBoxes) {
            if (box.label === 'Unknown Motion') priority = 1;
            else if (box.label === 'person') priority = Math.min(priority, 2);
            else if (['car', 'truck', 'bus', 'motorcycle'].includes(box.label)) priority = Math.min(priority, 3);
            else if (['dog', 'cat', 'bird', 'horse'].includes(box.label)) priority = Math.min(priority, 4);
        }

        // Tracking updates
        const trackedObjects = this.tracker.update(filteredBoxes);
        this.zoneEngine.updateStates(this.tracker.objects, 320, 180);
        this.zoneEngine.cleanup(Array.from(this.tracker.objects.keys()));
        const activeIds = Array.from(trackedObjects.keys());
        const activeBoxes = trackedObjects;

        let needsAnalysisRules = []; // Stores { trackerId, rule }
        for (const id of activeIds) {
            const currentBox = activeBoxes.get(id);
            
            // First-Class Tracking: Ignore TENTATIVE tracks. Only trigger Gemini for CONFIRMED tracks.
            if (currentBox.status === 'TENTATIVE') {
                continue;
            }

            for (const rule of this.rules) {
                const required = rule.local_conditions.objects || [];
                const label = currentBox.label.toLowerCase();
                
                // Rule specifically cares about objects, and this box is not one of them
                if (required.length > 0 && !required.includes(label) && label !== 'unknown motion') {
                    continue;
                }

                // Zone Check
                if (rule.local_conditions.zones && rule.local_conditions.zones.length > 0) {
                    let matchesAnyZone = false;
                    for (const zoneId of rule.local_conditions.zones) {
                        if (this.zoneEngine.isInside(id, zoneId)) {
                            matchesAnyZone = true;
                            break;
                        }
                    }
                    if (!matchesAnyZone) {
                        // The object is NOT inside any of the required zones. Skip rule evaluation entirely.
                        continue;
                    }
                    
                    // If the rule strictly requires a trigger like ENTER_ZONE, we can enforce it.
                    // But typically, simply entering the zone creates the first tracker state for this rule,
                    // which naturally acts as an 'ENTER' event for the state machine.
                }

                const stateKey = `${id}_${rule.rule_id}`;
                let state = this.objectStates.get(stateKey);

                if (!state) {
                    // Normal brand new object initialization for this rule
                    const sig = await generateRoiSignature(frameBuffer, currentBox.box);
                    const generation = 1;
                    const eventId = `event:${this.config.id}:${rule.rule_id}:${id}:${generation}`;
                    console.log(`[EVENT] Camera ${this.config.id} Rule ${rule.rule_id}: New track ${id} → Event ${eventId} created`);
                    redisConnection.incr('events_created').catch(()=>{});

                    state = {
                        id: id,
                        rule_id: rule.rule_id,
                        rule_version: rule.rule_version,
                        user_id: rule.user_id,
                        eventId: eventId,
                        generation: generation,
                        status: 'Pending', // Pending | Verifying | Verified | Reverifying | Rejected
                        lastVerificationTime: 0,
                        firstVerifiedTime: 0,
                        lastGeminiResult: null,
                        semantic_state_version: 0,
                        last_verified_state: {},
                        baselineBox: currentBox.box,
                        baselineRoiSignature: sig,
                        lastSeen: now,
                        lastLogTime: 0
                    };
                    this.objectStates.set(stateKey, state);
                    needsAnalysisRules.push({ trackerId: id, rule, stateKey, verificationType: 'initial' });
                    continue;
                }

                // Always update lastSeen since the object is being tracked
                state.lastSeen = now;

                if (state.status === 'Verifying' || state.status === 'Reverifying') {
                    if (state.lastVerificationTime && now - state.lastVerificationTime > 30000) {
                        console.warn(`[CameraWorker] ⏰ Verifying timeout for Tracker ID ${id} Rule ${rule.rule_id}. Stuck for >30s. Forcing to Rejected.`);
                        state.status = 'Rejected';
                        state.consecutiveRejections = (state.consecutiveRejections || 0) + 1;
                    }
                    continue;
                } else if (state.status === 'Pending') {
                    needsAnalysisRules.push({ trackerId: id, rule, stateKey, verificationType: 'initial' });
                } else if (state.status === 'Verified' || state.status === 'Rejected') {
                    // Check local L1 cooldown before expensive evaluation
                    if (state.status === 'Rejected' && state.cooldownExpiresAt && now < state.cooldownExpiresAt) {
                        // Check if we have rule-relevant changes anyway
                        const { hasMeaningfulChange } = reverificationEngine.evaluateChange(
                            state, currentBox.box, state.baselineBox, this.zoneEngine, rule
                        );
                        if (!hasMeaningfulChange) {
                            continue; // Valid suppression
                        }
                    }

                    const { hasMeaningfulChange, score, reasons } = reverificationEngine.evaluateChange(
                        state, 
                        currentBox.box, 
                        state.baselineBox, 
                        this.zoneEngine, 
                        rule
                    );

                    if (hasMeaningfulChange) {
                        console.log(`[EVENT] Event ${state.eventId} → Reverification required (Score: ${score.toFixed(2)}, Reasons: ${reasons.join(',')})`);
                        redisConnection.incr('events_reverified').catch(()=>{});
                        state.generation += 1;
                        state.eventId = `event:${this.config.id}:${rule.rule_id}:${id}:${state.generation}`;
                        
                        if (state.status === 'Rejected') {
                            console.log(`[NEGATIVE_MEMORY] Event ${state.eventId} → negative evidence invalidated`);
                            negativeMemoryEngine.invalidateMemory(rule.user_id, this.config.id, rule.rule_id, rule.rule_version, state.eventId, id);
                        }

                        console.log(`[CameraWorker] Tracker ID ${id} Rule ${rule.rule_id} (${state.status}) moved significantly. Resetting to Reverifying.`);
                        const sig = await generateRoiSignature(frameBuffer, currentBox.box);
                        state.status = 'Reverifying';
                        state.baselineBox = currentBox.box;
                        state.baselineRoiSignature = sig;
                        needsAnalysisRules.push({ trackerId: id, rule, stateKey, verificationType: 'reverification', changeReasons: reasons, changeScore: score });
                    } else {
                        if (now - (state.lastLogTime || 0) > 10000) {
                            if (state.status === 'Rejected') {
                                console.log(`[NEGATIVE_MEMORY] Event ${state.eventId} → suppression active (no relevant change)`);
                                redisConnection.incr('gemini_calls_saved_by_negative_memory').catch(()=>{});
                            } else {
                                console.log(`[EVENT] Event ${state.eventId} → Monitoring stable. Gemini skipped.`);
                                redisConnection.incr('gemini_calls_saved_by_adaptive_reverification').catch(()=>{});
                            }
                            state.lastLogTime = now;
                        }
                    }
                }
            }
        }

        if (!hasGlobalMotion) {
            needsAnalysisRules = [];
        }

        if (needsAnalysisRules.length === 0) {
            // All objects are in cooldown or rejected. Do not trigger Gemini!
            // However, we want to update the DB locally so the UI tracking boxes keep moving.
            if (now - this.lastDbUpdateTime > 1000) {
                this.lastDbUpdateTime = now;
                this.updateLocalTrackingToDatabase(filteredBoxes);
            }

            // BUG FIX: If we were in the middle of an upgrade window when motion stopped,
            // we must allow the window to close, otherwise we get permanently stuck in high-FPS mode.
            if (this.isBuffering && now - this.bufferStartTime > 300) {
                await this.flushBufferToGemini(this.bestFrame, "new");
            }
            return;
        }

        // Calculate a crude "Clarity Score" based on sum of YOLO confidences
        const confidenceScore = filteredBoxes.reduce((acc, b) => acc + b.confidence, 0);

        // Correctly map tracking IDs to YOLO boxes for Gemini's context
        // This ensures bestFrame.boxes and bestFrame.trackedIds align perfectly 1-to-1.
        const mappedBoxes = [];
        const mappedTrackedIds = [];
        for (const [id, trackedObj] of activeBoxes.entries()) {
            mappedBoxes.push({
                label: trackedObj.label,
                confidence: trackedObj.box.confidence,
                x1: trackedObj.box.x1, y1: trackedObj.box.y1, x2: trackedObj.box.x2, y2: trackedObj.box.y2
            });
            mappedTrackedIds.push(id);
        }

        const incoming = {
            buffer: frameBuffer,
            confidenceScore,
            boxes: mappedBoxes,
            priority,
            trackedIds: mappedTrackedIds,
            triggeringRules: needsAnalysisRules,
            timestamp: now
        };

        // Maintain the rolling frame buffer (memory only)
        this.frameBuffer.push(incoming);
        if (this.frameBuffer.length > this.maxBufferSize) {
            this.frameBuffer.shift();
        }

        if (!this.isBuffering) {
            // Event Trigger: Freeze Candidate Snapshot
            console.log(`[CameraWorker] Event triggered. Initiating 300ms Snapshot Upgrade Window for ${this.config.name}...`);
            this.isBuffering = true;
            this.bufferStartTime = now;

            // Search backwards for the event trigger frame (250-500ms before now)
            let bestPastFrame = null;
            let highestConf = -1;

            for (const f of this.frameBuffer) {
                const age = now - f.timestamp;
                if (age >= 250 && age <= 500) {
                    if (f.confidenceScore > highestConf) {
                        highestConf = f.confidenceScore;
                        bestPastFrame = f;
                    }
                }
            }

            // Fallback to current frame if no frame found in the strict time slice
            this.bestFrame = bestPastFrame || incoming;
        } else {
            // During the Upgrade Window (300ms)
            if (now - this.bufferStartTime <= 300) {
                // Check if incoming is a valid upgrade
                // 1. Must contain all the original tracking IDs that triggered the event
                const originalIds = (this.bestFrame.triggeringRules || []).map(r => r.trackerId);
                const incomingIds = incoming.trackedIds || [];
                const hasSameObjects = originalIds.length > 0 && originalIds.every(id => incomingIds.includes(id));

                // 2. Must have significantly higher confidence (+10% better visually)
                const isSignificantUpgrade = incoming.confidenceScore >= (this.bestFrame.confidenceScore * 1.10);

                if (hasSameObjects && isSignificantUpgrade) {
                    console.log(`[CameraWorker] Snapshot upgraded! (Conf: ${this.bestFrame.confidenceScore.toFixed(2)} -> ${incoming.confidenceScore.toFixed(2)})`);
                    this.bestFrame = incoming;
                }
            }
        }

        // Lock Snapshot & Gemini Evaluation
        // After the 300ms upgrade window expires, lock permanently and send to Gemini.
        if (this.isBuffering && now - this.bufferStartTime > 300) {
            await this.flushBufferToGemini(this.bestFrame, "new");
        }
    }

    async calculateBlur(buffer) {
        try {
            const laplacianKernel = {
                width: 3,
                height: 3,
                kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0]
            };
            const { data: edges } = await sharp(buffer)
                .greyscale()
                .convolve(laplacianKernel)
                .raw()
                .toBuffer({ resolveWithObject: true });

            let sum = 0;
            for (let i = 0; i < edges.length; i++) sum += edges[i];
            const mean = sum / edges.length;

            let variance = 0;
            for (let i = 0; i < edges.length; i++) {
                variance += (edges[i] - mean) ** 2;
            }
            return variance / edges.length;
        } catch (e) {
            console.error('[CameraWorker] Error calculating blur:', e.message);
            return 1000; // fail open (assume not blurry) if error
        }
    }

    async flushBufferToGemini(bestFrame, eventType) {
        if (!bestFrame || !bestFrame.buffer) return;

        // --- EXTREME BLUR DETECTION GATE ---
        const blurVariance = await this.calculateBlur(bestFrame.buffer);
        // User requested "Extreme blur rejection" so we only discard completely ruined frames
        const EXTREME_BLUR_THRESHOLD = 20;

        if (blurVariance < EXTREME_BLUR_THRESHOLD) {
            console.log(`[CameraWorker] 🌫️ Frame REJECTED due to EXTREME blur. Variance: ${blurVariance.toFixed(2)} (Threshold: ${EXTREME_BLUR_THRESHOLD})`);

            // Allow retry quickly since we discarded this frame
            for (const id of (bestFrame.triggeringIds || [])) {
                const state = this.objectStates.get(id);
                if (state) {
                    state.status = 'Rejected';
                    state.cooldownExpiresAt = Date.now() + 500; // brief cooldown to let the camera focus
                }
            }
            this.isBuffering = false;
            return;
        } else {
            console.log(`[CameraWorker] 👁️ Frame passed extreme blur check. Variance: ${blurVariance.toFixed(2)}`);
        }

        // === PRE-QUEUE GATEKEEPER (Event-level deduplication lock) ===
        const lockedEventIds = [];
        let anyLocked = false;
        const validTriggeringRules = bestFrame.triggeringRules || [];

        for (const item of validTriggeringRules) {
            const state = this.objectStates.get(item.stateKey);
            if (state) {
                const lockKey = `gemini_lock:${state.eventId}`;
                const isLocked = await redisConnection.set(lockKey, "1", "NX", "EX", 60);
                if (isLocked) {
                    lockedEventIds.push(state.eventId);
                    anyLocked = true;
                    console.log(`[LOCK] Event ${state.eventId} → Verification lock acquired`);
                } else {
                    console.log(`[DEDUP] Event ${state.eventId} → Gemini job already pending, skipped`);
                    console.log(`[LOCK] Event ${state.eventId} → Duplicate verification prevented`);
                    redisConnection.incr('gemini_calls_prevented_by_deduplication').catch(()=>{});
                }
            }
        }

        if (!anyLocked) {
            console.log(`[CameraWorker] Camera ${this.config.id} has no new events to verify (all deduplicated). Skipping.`);
            for (const item of validTriggeringRules) {
                const state = this.objectStates.get(item.stateKey);
                if (state) {
                    state.status = 'Rejected'; // Generic backoff
                    state.cooldownExpiresAt = Date.now() + 100;
                    state.lastVerificationTime = Date.now();
                }
            }
            this.isBuffering = false;
            return;
        }

        let jobEnqueued = false;
        let imagePath = null;

        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs').promises;
            const crypto = require('crypto');
            imagePath = path.join(os.tmpdir(), `vision_ai_${crypto.randomUUID()}.jpg`);
            await fs.writeFile(imagePath, bestFrame.buffer);
            // Group triggers by rule to dispatch separate isolated jobs
            const jobsByRule = new Map();
            for (const item of validTriggeringRules) {
                const state = this.objectStates.get(item.stateKey);
                if (!state || !lockedEventIds.includes(state.eventId)) continue;

                if (!jobsByRule.has(item.rule.rule_id)) {
                    jobsByRule.set(item.rule.rule_id, {
                        rule: item.rule,
                        trackedIds: [],
                        yoloBoxes: [],
                        eventIds: []
                    });
                }
                
                const group = jobsByRule.get(item.rule.rule_id);
                group.trackedIds.push(item.trackerId);
                group.eventIds.push(state.eventId);

                const boxIdx = bestFrame.trackedIds.indexOf(item.trackerId);
                if (boxIdx !== -1) {
                    const b = bestFrame.boxes[boxIdx];
                    group.yoloBoxes.push({
                        label: b.label,
                        box: [b.x1 * 320, b.y1 * 180, b.x2 * 320, b.y2 * 180]
                    });
                }
            }

            if (jobsByRule.size === 0) {
                console.log(`[CameraWorker] All relevant objects for ${this.config.name} are locked or cooled down. Dropping.`);
                for (const id of (bestFrame.triggeringIds || [])) {
                    const state = this.objectStates.get(id);
                    if (state) {
                        state.status = 'Verified';
                        state.lastVerificationTime = Date.now();
                    }
                }
                return;
            }

            const safeMode = await redisConnection.get(`quota:safemode:${this.config.id}`);
            if (safeMode) {
                console.log(`[CameraWorker] Camera ${this.config.id} is in Safe Mode. Bypassing Gemini queue.`);
                return;
            }

            for (const [ruleId, group] of jobsByRule.entries()) {
                const rule = group.rule;

                // Ensure semantic conditions exist. If not, it's just a YOLO rule that doesn't need Gemini.
                if (!rule.semantic_conditions || rule.semantic_conditions.length === 0) {
                    console.log(`[CameraWorker] Rule ${ruleId} has no semantic conditions. Evaluates to True locally.`);
                    // We should trigger the alert/webhook directly here, but for now we skip Gemini.
                    // Emulate local passing by setting state to Verified
                    for (const eid of group.eventIds) {
                        const item = validTriggeringRules.find(r => this.objectStates.get(r.stateKey)?.eventId === eid);
                        if (item) {
                            const state = this.objectStates.get(item.stateKey);
                            if (state) {
                                state.status = 'Verified';
                                state.lastVerificationTime = Date.now();
                            }
                        }
                    }
                    continue; // Skip queuing
                }

                await geminiQueue.add('analyze-frame', {
                    camId: this.config.id,
                    cameraName: this.config.name,
                    userId: rule.user_id,
                    ruleId: rule.rule_id,
                    ruleVersion: rule.rule_version,
                    semanticConditions: rule.semantic_conditions,
                    imagePath,
                    metadata: {
                        yolo_boxes: group.yoloBoxes.slice(0, 10),
                        tracked_ids: group.trackedIds.slice(0, 10),
                        event_ids: group.eventIds.slice(0, 10)
                    },
                    eventType,
                    verificationType: group.ruleMeta?.verificationType || 'initial',
                    changeReasons: group.ruleMeta?.changeReasons || [],
                    changeScore: group.ruleMeta?.changeScore || 0,
                    previousState: null
                }, {
                    priority: bestFrame.priority,
                    removeOnComplete: true,
                    removeOnFail: true,
                    timeout: 15000,
                    attempts: 5,
                    backoff: {
                        type: 'exponential',
                        delay: 2000
                    }
                });
                
                jobEnqueued = true;
            }

            jobEnqueued = true;

            // BUG FIX: Reset buffering state so we don't infinitely enqueue the same event 
            // every time the Gemini processing lock is freed.
            this.isBuffering = false;
            this.bestFrame = null;
            this.bufferStartTime = 0;
        } finally {
            if (!jobEnqueued) {
                try { await fs.unlink(imagePath); } catch (err) { }
                for (const eid of lockedEventIds) {
                    try { await redisConnection.del(`gemini_lock:${eid}`); } catch (err) { }
                }
                
                // BUG FIX: Ensure failure path safely resets state without locking camera
                this.isBuffering = false;
                this.bestFrame = null;
                this.bufferStartTime = 0;
            }
        }

        // Apply cooldowns to tracked objects
        for (const item of validTriggeringRules) {
            const state = this.objectStates.get(item.stateKey);
            if (state) {
                if (lockedEventIds.includes(state.eventId)) {
                    state.status = 'Verifying';
                    state.lastVerificationTime = Date.now();
                } else {
                    state.status = 'Verified';
                    state.lastVerificationTime = Date.now();
                }
            }
            const obj = this.tracker.objects.get(item.trackerId);
            if (obj) {
                const sig = await generateRoiSignature(bestFrame.buffer, obj.box);
                this.rejectedObjectBoxes.set(item.stateKey, { box: obj.box, roiSignature: sig });
                this.acceptedObjectBoxes.set(item.stateKey, { box: obj.box, roiSignature: sig });
            }
            this.objectCooldowns.set(item.stateKey, Date.now());
        }
    }

    async updateLocalTrackingToDatabase(filteredBoxes) {
        // just to move bounding boxes on the UI.
        // Live UI bounding boxes are now strictly handled by the 500ms WebSocket broadcast in index.js.
        // Supabase is now ONLY used for the initial detection insert (saving massive DB I/O).
    }

}

module.exports = { CameraWorkerPool };

// Periodic Temp File Cleanup to ensure no orphaned frames leak disk space over time
setInterval(async () => {
    try {
        const tempDir = path.join(__dirname, 'temp');
        const files = await fs.readdir(tempDir).catch(() => []);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = await fs.stat(filePath).catch(() => null);
            // Delete files older than 10 minutes
            if (stats && now - stats.mtimeMs > 10 * 60 * 1000) {
                await fs.unlink(filePath).catch(() => { });
            }
        }
    } catch (e) {
        console.error('[CameraWorker] Periodic temp file cleanup error:', e.message);
    }
}, 5 * 60 * 1000); // Every 5 minutes
