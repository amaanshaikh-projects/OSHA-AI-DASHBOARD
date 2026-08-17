const fs = require('fs');
const path = require('path');
const file = fs.readFileSync(path.join(__dirname, 'engine', 'camera-worker_original.js'), 'utf8');

const flushStart = file.indexOf('    async flushBufferToGemini(bestFrame, metadata, promptText, eventType) {');
const updateStart = file.indexOf('        // just to move bounding boxes on the UI.');

const part1 = file.substring(0, flushStart);
const part2 = file.substring(updateStart);

const perfectFlush = `    async flushBufferToGemini(bestFrame, metadata, promptText, eventType) {
        if (!bestFrame || !bestFrame.buffer) return;

        // === PRE-QUEUE GATEKEEPER (One pending job per camera) ===
        const isLocked = await redisConnection.set(\`gemini_processing:\${this.config.id}\`, "1", "NX", "EX", 30);
        if (!isLocked) {
            console.log(\`[CameraWorker] Camera \${this.config.id} already has a pending Gemini job. Skipping.\`);

            // Removed 5s cooldown at user request to avoid delay
            for (const id of (bestFrame.triggeringIds || [])) {
                const state = this.objectStates.get(id);
                if (state) {
                    state.status = 'Rejected'; // Use Rejected state as a generic backoff
                    state.cooldownExpiresAt = Date.now() + 100; // 100ms instead of 5000ms
                    state.lastVerificationTime = Date.now();
                }
            }
            return;
        }

        const needsTemporal = metadata.actions && metadata.actions.length > 0;
        let finalBuffer = bestFrame.buffer;
        let temporalHint = "";

        if (needsTemporal && this.frameBuffer.length > 0) {
            console.log(\`[CameraWorker] Action detected in prompt. Stitching multi-frame collage...\`);
            // We want 4 frames spaced ~500ms apart, ending at bestFrame
            const targetFrames = [];
            const nowTime = bestFrame.timestamp;
            const targetOffsets = [1500, 1000, 500, 0];
            
            for (const offset of targetOffsets) {
                const targetTime = nowTime - offset;
                let closest = this.frameBuffer[0];
                let minDiff = Math.abs(closest.timestamp - targetTime);
                for (const f of this.frameBuffer) {
                    const diff = Math.abs(f.timestamp - targetTime);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = f;
                    }
                }
                targetFrames.push(closest.buffer);
            }

            try {
                // Determine dimensions from the first frame
                const meta = await sharp(targetFrames[0]).metadata();
                const w = meta.width || 640;
                const h = meta.height || 480;

                const bg = await sharp({ create: { width: w * 2, height: h * 2, channels: 3, background: { r: 0, g: 0, b: 0 } } })
                    .jpeg()
                    .toBuffer();

                finalBuffer = await sharp(bg)
                    .composite([
                        { input: targetFrames[0], top: 0, left: 0 },
                        { input: targetFrames[1], top: 0, left: w },
                        { input: targetFrames[2], top: h, left: 0 },
                        { input: targetFrames[3], top: h, left: w }
                    ])
                    .toBuffer();
                
                temporalHint = "[TEMPORAL SEQUENCE: This image is a 2x2 grid of 4 frames captured over 1.5 seconds. Read Left-to-Right, Top-to-Bottom to infer motion.]\\n\\n";
            } catch (e) {
                console.error('[CameraWorker] Error stitching multi-frame collage, falling back to single frame:', e.message);
            }
        }

        // Write image to disk to avoid storing base64 in Redis
        const tempDir = path.join(__dirname, 'temp');
        await fs.mkdir(tempDir, { recursive: true });
        const imagePath = path.join(tempDir, \`frame_\${this.config.id}_\${Date.now()}.jpg\`);
        await fs.writeFile(imagePath, finalBuffer);

        let jobEnqueued = false;
        try {
            // Fetch missing quota variables
            const userPlan = this.config.subscription_plan || 'Free';
            const apiDailyLimit = getPlanApiLimit(userPlan);
            const alertLimit = getPlanAlertLimit(userPlan);
            let alertsUsed = 0;

            if (userPlan.toLowerCase() === 'free') {
                const weekKey = getWeekKey();
                const alertStr = await redisConnection.get(\`alerts_usage:user:\${this.config.user_id}:weekly:\${weekKey}\`);
                alertsUsed = alertStr ? parseInt(alertStr, 10) : 0;
            } else {
                const todayStr = new Date().toISOString().split('T')[0];
                const alertStr = await redisConnection.get(\`alerts_usage:user:\${this.config.user_id}:daily:\${todayStr}\`);
                alertsUsed = alertStr ? parseInt(alertStr, 10) : 0;
            }

            // BUG FIX: Use checkApiLimits() (read-only) instead of recordApiRequest() (increments counters).
            const { score, level } = await healthController.checkApiLimits(this.config.id, apiDailyLimit, userPlan, this.config.user_id);

            if (level === 'TRIAL_EXPIRED') {
                console.warn(\`[CameraWorker] User \${this.config.user_id} hit weekly free trial API limit. Blocking until next week.\`);
                return;
            }

            if (level === 'SAFE_MODE') {
                const lastSafeModeTestStr = await redisConnection.get(\`safemode_test:cam:\${this.config.id}\`);
                const lastSafeModeTest = lastSafeModeTestStr ? parseInt(lastSafeModeTestStr) : 0;

                const isAlertLimitExhausted = alertsUsed >= alertLimit;

                if (!isAlertLimitExhausted && Date.now() - lastSafeModeTest > 300000) { // 5 minutes
                    console.warn(\`[CameraWorker] 🔄 Camera \${this.config.id} in SAFE_MODE sending ONE test frame for recovery...\`);
                    await redisConnection.set(\`safemode_test:cam:\${this.config.id}\`, Date.now().toString(), 'EX', 600);
                } else {
                    if (isAlertLimitExhausted) {
                        console.warn(\`[CameraWorker] ⚠️ Camera \${this.config.id} is in SAFE_MODE (Alerts Exhausted). Dropping frame completely.\`);
                    } else {
                        console.warn(\`[CameraWorker] ⚠️ Camera \${this.config.id} is in SAFE_MODE (Health: \${score}). Dropping frame to protect API budget.\`);
                    }
                    return;
                }
            }

            const filteredYoloBoxes = [];
            const filteredTrackedIds = [];

            for (let i = 0; i < bestFrame.boxes.length; i++) {
                const b = bestFrame.boxes[i];
                const label = b.label.toLowerCase();
                const reqObjs = metadata.objects || [];
                const priObjs = metadata.primary_objects || [];
                const secObjs = metadata.secondary_objects || [];

                if (metadata.mode === 'B' ||
                    req ||
                    reqObjs.some(req => label.includes(req.toLowerCase())) ||
                    priObjs.some(req => label.includes(req.toLowerCase())) ||
                    secObjs.some(req => label.includes(req.toLowerCase()))) {

                    const cooldownKey = \`accepted_class:cam:\${this.config.id}:class:\${b.label}\`;
                    const isCooldown = await redisConnection.get(cooldownKey);
                    if (isCooldown) {
                        console.log(\`[CameraWorker] 🤫 Skipping box '\${b.label}' — class is on cooldown.\`);
                        continue;
                    }

                    let maskedLabel = b.label;
                    if (metadata.mode === 'B') {
                        maskedLabel = 'Candidate Object';
                    }

                    filteredYoloBoxes.push({
                        label: maskedLabel,
                        box: [b.x1 * 320, b.y1 * 180, b.x2 * 320, b.y2 * 180]
                    });
                    filteredTrackedIds.push(bestFrame.trackedIds[i]);
                }
            }

            if (filteredYoloBoxes.length === 0 && metadata.mode !== 'B') {
                console.log(\`[CameraWorker] All relevant objects for \${this.config.name} are on class-level cooldown. Dropping Gemini job.\`);
                for (const id of (bestFrame.triggeringIds || [])) {
                    const state = this.objectStates.get(id);
                    if (state) {
                        state.status = 'Verified';
                        state.cooldownExpiresAt = Date.now() + 30000;
                        state.lastVerificationTime = Date.now();
                    }
                }
                return;
            }

            const fireDetectionInstruction = "\\n\\nCRITICAL SYSTEM INSTRUCTION: Regardless of the user's prompt above, you must ALSO thoroughly scan the entire image for any signs of FIRE or SMOKE. If you detect fire or smoke, you must instantly flag it and describe the fire/smoke in the response.";

            await geminiQueue.add('analyze-frame', {
                camId: this.config.id,
                cameraName: this.config.name,
                userId: this.config.user_id,
                promptText: temporalHint + promptText + fireDetectionInstruction,
                imagePath,
                metadata: {
                    yolo_boxes: filteredYoloBoxes.slice(0, 10),
                    tracked_ids: filteredTrackedIds.slice(0, 10)
                },
                eventType,
                previousState: null
            }, {
                priority: bestFrame.priority,
                removeOnComplete: true,
                removeOnFail: true,
                timeout: 15000
            });
            
            jobEnqueued = true;
        } finally {
            if (!jobEnqueued) {
                try { await fs.unlink(imagePath); } catch (err) { }
                try { await redisConnection.del(\`gemini_processing:\${this.config.id}\`); } catch (err) { }
            }
        }

        // Apply cooldowns to tracked objects
        for (const id of (bestFrame.triggeringIds || [])) {
            this.objectCooldowns.set(id, Date.now());
            const state = this.objectStates.get(id);
            if (state) {
                state.status = 'Verifying';
            }
            const obj = this.tracker.objects.get(id);
            if (obj) {
                const sig = await generateRoiSignature(bestFrame.buffer, obj.box);
                this.rejectedObjectBoxes.set(id, { box: obj.box, roiSignature: sig });
                this.acceptedObjectBoxes.set(id, { box: obj.box, roiSignature: sig });
            }
        }
    }

    async updateLocalTrackingToDatabase(filteredBoxes) {
`;

fs.writeFileSync(path.join(__dirname, 'engine', 'camera-worker_original.js'), part1 + perfectFlush + part2);
