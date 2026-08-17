/* ==========================================================================
   OSHA AI Client Console - Dashboard Application Logic (2026 Edition)
   ========================================================================== */

if (typeof fetch === 'undefined') {
    globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
}


import { State, updateState } from './state.js';
import { showToast, showModal, closeModal } from './ui.js';
import { API } from './api.js';
import { WebRTC } from './webrtc.js';

// Bind to window for any stray onclick events or external calls
window.showModal = showModal;
window.closeModal = closeModal;
window.showToast = showToast;
window.API = API;
window.WebRTC = WebRTC;

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initial Icon parsing
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    // 2. Global State Variables

    // Modal Control Flags

    // High-Performance WebSocket for Webcams

    WebRTC.initWebSocket();
    window.addEventListener('webrtc_message', (e) => {
        const result = e.detail;
        if (result.cameraId) {
            if (result.activeBoxes && result.activeBoxes.length > 0) {
                State.cameraLiveBoxes[result.cameraId] = result.activeBoxes;
            } else if (result.activeBoxes && result.activeBoxes.length === 0) {
                State.cameraLiveBoxes[result.cameraId] = [];
            }
            if (result.decision === 'MATCH') {
                showToast(`🚨 Event Logged!`, 'success');
            }
        }
    });
    // Toast Notification utility
    window.legacyShowToast = (message, type = 'success') => {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast-msg ${type}`;

        const iconName = type === 'success' ? 'check-circle' : 'alert-circle';

        toast.innerHTML = `
            <div class="toast-ico-box">
                <i data-lucide="${iconName}"></i>
            </div>
            <span class="toast-text">${message}</span>
            <button class="toast-close-btn" aria-label="Close toast">
                <i data-lucide="x"></i>
            </button>
        `;

        container.appendChild(toast);
        if (typeof lucide !== 'undefined') lucide.createIcons();

        // Close action
        const closeBtn = toast.querySelector('.toast-close-btn');
        closeBtn.addEventListener('click', () => {
            toast.classList.add('closing');
            setTimeout(() => toast.remove(), 300);
        });

        // Auto remove
        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.add('closing');
                setTimeout(() => toast.remove(), 300);
            }
        }, 4000);
    };

    // 3. Routing & Navigation Control
    const views = document.querySelectorAll('.tab-view');
    const menuLinks = document.querySelectorAll('.sidebar-menu .menu-item');

    // Store canvas animation frame handles
    // Store active webcam video stream elements
    // Store HLS.js instances + hidden video elements for RTSP cameras
    // Store browser-side detection interval handles per camera
    // Tracks live Gemini detection state per camera: null = no match, else { label, confidence, expiresAt }
    const cameraMatchState = {};
    // Tracks live YOLO bounding boxes per camera (updated every frame from backend response)
    // cameraLiveBoxes is now in State

    window.getMaxCamerasAllowed = (planStr) => {
        return '∞';
    };

    window.syncCameraUsageUI = (cameraCount, planStr) => {
        const usageText = `${cameraCount} Cameras Active`;
        const topbarUsage = document.getElementById('topbar-camera-usage');
        if (topbarUsage) topbarUsage.textContent = usageText;
    };

    class CameraRateLimiter {
        constructor() {
            this.requestLogs = {};
            this.WINDOW_MS = 1000;
            this.MAX_REQUESTS = 20;
        }

        async checkRateLimit(camera) {
            const now = Date.now();
            if (!this.requestLogs[camera.id]) {
                this.requestLogs[camera.id] = [];
            }

            this.requestLogs[camera.id] = this.requestLogs[camera.id].filter(t => now - t < this.WINDOW_MS);
            this.requestLogs[camera.id].push(now);

            if (this.requestLogs[camera.id].length > this.MAX_REQUESTS) {
                console.warn(`[RateLimiter] Camera ${camera.name} (${camera.id}) exceeded API rate limit! Pausing feed.`);

                await dbClient.updateCamera(camera.id, State.currentUser.id, { status: 'Paused' });
                camera.status = 'Paused';
                this.requestLogs[camera.id] = [];

                const card = document.querySelector(`.camera-card[data-id="${camera.id}"]`);
                if (card) {
                    const pauseBtn = card.querySelector('.action-pause i');
                    if (pauseBtn) pauseBtn.setAttribute('data-lucide', 'play');
                    card.classList.add('paused');
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                }

                // Add to Warnings Tab
                const list = document.getElementById('warnings-list');
                const empty = document.getElementById('warnings-empty-state');
                const badge = document.getElementById('sidebar-warning-badge');

                if (list && empty && badge) {
                    empty.style.display = 'none';
                    list.style.display = 'flex';

                    const warningEl = document.createElement('div');
                    warningEl.style.cssText = 'padding: 20px; background: rgba(239, 68, 68, 0.1); border-left: 4px solid var(--text-red); border-radius: 8px; display: flex; flex-direction: column; gap: 8px;';
                    warningEl.innerHTML = `
                        <div style="font-weight: bold; color: var(--text-primary); font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
                            <i data-lucide="alert-triangle" style="color: var(--text-red); width: 20px; height: 20px;"></i>
                            Camera Auto-Paused: ${camera.name}
                        </div>
                        <div style="color: var(--text-secondary); font-size: 0.95rem;">
                            The system detected an abnormally high volume of API requests (>20 req/s) originating from this camera. 
                            To protect your account from excessive billing and ensure overall system stability, this feed has been automatically paused.
                        </div>
                        <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 4px;">
                            Time: ${new Date().toLocaleTimeString()}
                        </div>
                    `;
                    list.prepend(warningEl);

                    let count = parseInt(badge.textContent || '0') + 1;
                    badge.textContent = count;
                    badge.classList.add('visible');

                    if (typeof lucide !== 'undefined') lucide.createIcons();
                }

                return false;
            }
            return true;
        }
    }
    const apiRateLimiter = new CameraRateLimiter();


    const startBrowserDetectionLoop = (cam, videoEl) => {
        // Stop any existing loop first so prompt changes restart cleanly
        stopBrowserDetectionLoop(cam.id);

        // Hide the "CONNECTING..." loading overlay immediately when the stream is ready
        const loadingEl = document.getElementById(`canvas-loading-${cam.id}`);
        if (loadingEl) loadingEl.style.display = 'none';

        // Guard: ONLY capture local frames for webcam feeds. RTSP feeds are handled headlessly by backend workers.
        if (!cam.rtsp_url.startsWith('webcam://')) {
            console.log(`[BrowserDetector] Skipping continuous streaming for RTSP camera "${cam.name}" (Headless processing active)`);
            return;
        }

        // Frontend streams continuously (2 FPS). The backend Adaptive Scheduler handles actual capture throttling.
        const intervalMs = 500;
        console.log(`[BrowserDetector] Registering continuous streaming for "${cam.name}" | prompt: "${cam.activePromptText}"`);

        // MEMORY LEAK FIX: Create offscreen canvas ONCE per camera loop and reuse it
        const offscreen = document.createElement('canvas');
        offscreen.width = 320;
        offscreen.height = 180;
        const octx = offscreen.getContext('2d', { willReadFrequently: true });

        const detectFrame = async () => {
            if (document.hidden) return;

            // Guard: video must be playing
            if (!videoEl || videoEl.readyState < 2) {
                console.log(`[BrowserDetector] "${cam.name}" — video not ready (readyState=${videoEl ? videoEl.readyState : 'null'}), skipping.`);
                return;
            }
            if (cam.status === 'Paused') {
                console.log(`[BrowserDetector] "${cam.name}" — camera paused, skipping.`);
                return;
            }
            if (!cam.activePromptText || cam.activePromptText.trim() === '') {
                console.log(`[BrowserDetector] "${cam.name}" — no prompt set, skipping.`);
                return;
            }

            // Rate Limiting Manager check
            const allowed = await apiRateLimiter.checkRateLimit(cam);
            if (!allowed) return;

            console.log(`[BrowserDetector] "${cam.name}" — capturing frame...`);

            if (!octx) return;

            const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
            if (!vw || !vh) {
                console.log(`[BrowserDetector] "${cam.name}" — video dimensions not available yet.`);
                return;
            }

            // Squish-fill: draw the entire video frame into the 320x180 canvas without cropping.
            // This ensures YOLO bounding boxes perfectly map back to the full display canvas.
            octx.fillStyle = '#000';
            octx.fillRect(0, 0, offscreen.width, offscreen.height);
            octx.drawImage(videoEl, 0, 0, offscreen.width, offscreen.height);

            const frameBase64 = offscreen.toDataURL('image/jpeg', 0.65).split(',')[1];
            console.log(`[BrowserDetector] "${cam.name}" — frame captured (${Math.round(frameBase64.length / 1024)}KB), sending to Gemini...`);

            try {
                if (State.wsConnected && State.engineWebSocket && State.engineWebSocket.readyState === WebSocket.OPEN) {
                    State.engineWebSocket.send(JSON.stringify({
                        cameraId: cam.id,
                        cameraName: cam.name,
                        userId: State.currentUser ? State.currentUser.id : null,
                        promptText: cam.activePromptText,
                        frameBase64
                    }));
                } else {
                    console.warn(`[BrowserDetector] WebSocket not connected. Dropping frame for "${cam.name}".`);
                }
            } catch (e) {
                console.error(`[BrowserDetector] WebSocket send error for "${cam.name}":`, e);
            }
        };

        // Fire immediately, then on interval
        stopBrowserDetectionLoop(cam.id);
        detectFrame();
        State.activeBrowserDetectors[cam.id] = setInterval(detectFrame, intervalMs);
        console.log(`[BrowserDetector] Loop started for "${cam.name}" (id=${cam.id}), interval=${intervalMs}ms`);

        // Legacy pollState was removed, relying entirely on Supabase realtime events
    };

    const stopBrowserDetectionLoop = (camId) => {
        if (State.activeBrowserDetectors[camId]) {
            clearInterval(State.activeBrowserDetectors[camId]);
            delete State.activeBrowserDetectors[camId];
            console.log(`[BrowserDetector] Stopped detection loop for camera ${camId}`);
        }

    };

    const cancelAllCameraPreviews = async () => {
        // Stop all browser-side detection loops
        Object.keys(State.activeBrowserDetectors).forEach(camId => {
            stopBrowserDetectionLoop(camId);
        });

        // Soft navigation: pause HLS videos to prevent browser decoder stall
        Object.keys(State.activeHlsStreams).forEach(camId => {
            const hlsEntry = State.activeHlsStreams[camId];
            if (hlsEntry && hlsEntry.videoEl) {
                hlsEntry.videoEl.pause();
            }
        });
    };

    const parseObjectsFromPromptText = (promptText) => {
        if (!promptText) return ["motion"];

        const clean = promptText.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
        const words = clean.split(/\s+/).map(w => w.trim()).filter(Boolean);

        const stopWords = new Set([
            'a', 'an', 'the', 'notify', 'alert', 'when', 'if', 'is', 'are', 'was', 'were',
            'shows', 'showing', 'detected', 'detect', 'on', 'in', 'at', 'with', 'about',
            'someone', 'somebody', 'anybody', 'anyone', 'something', 'anything',
            'to', 'for', 'of', 'and', 'or', 'but', 'by', 'up', 'down', 'left', 'right',
            'no', 'yes', 'this', 'that', 'these', 'those'
        ]);

        const objects = [];
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (!isNaN(w) && i + 1 < words.length) {
                const combined = `${w} ${words[i + 1]}`;
                if (!stopWords.has(words[i + 1])) {
                    objects.push(combined);
                    i++;
                    continue;
                }
            }
            if (!stopWords.has(w)) {
                objects.push(w);
            }
        }

        return objects.length > 0 ? objects : ["motion"];
    };

    const getDynamicObjectFromLabel = (label) => {
        let hash = 0;
        for (let i = 0; i < label.length; i++) {
            hash = label.charCodeAt(i) + ((hash << 5) - hash);
        }

        const getPct = (salt) => {
            const h = Math.abs(hash + salt);
            return (h % 1000) / 1000;
        };

        const w = Math.floor(30 + getPct(100) * 60);
        const h = Math.floor(30 + getPct(200) * 60);
        const x = Math.floor(30 + getPct(300) * (260 - w));
        const y = Math.floor(20 + getPct(400) * (130 - h));

        const confidence = (90 + getPct(500) * 9.9).toFixed(1);

        return {
            label: label.toUpperCase(),
            x,
            y,
            w,
            h,
            confidence
        };
    };

    const getPromptSimulatedObjects = (promptText, metadata) => {
        let labels = [];
        if (metadata && Array.isArray(metadata.objects) && metadata.objects.length > 0) {
            labels = metadata.objects;
        } else {
            labels = parseObjectsFromPromptText(promptText);
        }
        return labels.map(label => getDynamicObjectFromLabel(label));
    };

    // drawImageContain: shows the FULL frame — no cropping, letterboxes if aspect ratios differ
    const drawImageContain = (ctx, img, w, h) => {
        const iw = img.videoWidth || img.width;
        const ih = img.videoHeight || img.height;
        if (!iw || !ih) return;

        const scale = Math.min(w / iw, h / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        const dx = (w - dw) / 2;
        const dy = (h - dh) / 2;

        // Black background for letterbox bars
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
    };

    /**
     * Draw real-time YOLO detection boxes on a canvas.
     * Boxes are in 320x180 capture-canvas space; we scale to the display canvas size.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Array} boxes  - from cameraLiveBoxes[camId]
     * @param {number} canvasW - display canvas width
     * @param {number} canvasH - display canvas height
     * @param {number} frameCount - for pulsing animation
     */
    const drawLiveYoloBoxes = (ctx, boxes, canvasW, canvasH, frameCount) => {
        if (!boxes || boxes.length === 0) return;

        // Boxes match the capture resolution in startBrowserDetectionLoop
        const CAPTURE_W = 320, CAPTURE_H = 180;
        const scaleX = canvasW / CAPTURE_W;
        const scaleY = canvasH / CAPTURE_H;
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(frameCount * 0.1));

        boxes.forEach(obj => {
            const [x1, y1, x2, y2] = obj.box;
            const bx = Math.round(x1 * scaleX);
            const by = Math.round(y1 * scaleY);
            const bw = Math.round((x2 - x1) * scaleX);
            const bh = Math.round((y2 - y1) * scaleY);

            if (bw < 4 || bh < 4) return; // Skip noise

            // Dashed bounding box in cyan/teal
            ctx.save();
            ctx.setLineDash([5, 3]);
            ctx.strokeStyle = `rgba(6, 182, 212, ${pulse})`; // cyan-500
            ctx.lineWidth = 2;
            ctx.strokeRect(bx, by, bw, bh);
            ctx.restore();

            // Corner accents (solid)
            const cs = Math.min(10, Math.min(bw, bh) * 0.25);
            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 2.5;
            [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]].forEach(([cx, cy], i) => {
                ctx.beginPath();
                const sx = i % 2 === 0 ? 1 : -1;
                const sy = i < 2 ? 1 : -1;
                ctx.moveTo(cx + sx * cs, cy);
                ctx.lineTo(cx, cy);
                ctx.lineTo(cx, cy + sy * cs);
                ctx.stroke();
            });

            // Label chip
            const labelText = obj.label ? `${obj.label.toUpperCase()}  ${obj.confidence || ''}%` : '';
            if (labelText) {
                ctx.font = 'bold 9px monospace';
                const tw = ctx.measureText(labelText).width;
                const lx = bx;
                const ly = by > 14 ? by - 14 : by + bh + 2;
                ctx.fillStyle = 'rgba(6, 182, 212, 0.85)';
                ctx.fillRect(lx - 1, ly, tw + 8, 12);
                ctx.fillStyle = '#000';
                ctx.fillText(labelText, lx + 3, ly + 9);
            }
        });
    };


    // Resize canvas to match webcam's native aspect ratio so nothing is cropped
    const autoResizeCanvasToVideo = (canvas, videoEl) => {
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (!vw || !vh) return;

        // Get the CSS display width and compute the correct height
        const displayWidth = canvas.offsetWidth || canvas.parentElement.offsetWidth || 320;
        const aspectRatio = vw / vh;
        const displayHeight = Math.round(displayWidth / aspectRatio);

        // Update canvas buffer resolution
        canvas.width = vw;
        canvas.height = vh;
    };

    const initCameraCanvasPreview = (canvas, cam) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const camId = cam.id;

        if (cam.status === 'Trial Expired') {
            const loadingEl = document.getElementById(`canvas-loading-${camId}`);
            if (loadingEl) loadingEl.style.display = 'none';
            return;
        }

        // Cancel previous canvas animation loop (the old canvas element is gone after re-render)
        if (State.activeCanvasLoops[camId]) {
            cancelAnimationFrame(State.activeCanvasLoops[camId]);
            delete State.activeCanvasLoops[camId];
        }

        // If the loading overlay exists and the HLS stream is already ready, hide it immediately
        const existingHls = State.activeHlsStreams[camId];
        if (existingHls && existingHls.ready) {
            const loadingEl = document.getElementById(`canvas-loading-${camId}`);
            if (loadingEl) loadingEl.style.display = 'none';
        }

        let videoEl = State.activeWebcamStreams[camId];
        let hlsVideoEl = existingHls ? existingHls.videoEl : null;

        if (cam.rtsp_url.startsWith('webcam://') && !videoEl) {
            // ── WEBCAM: getUserMedia ──────────────────────────────────────────
            videoEl = document.createElement('video');
            videoEl.classList.add('backend-video-stream');
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.muted = true;
            videoEl.style.display = 'none';
            document.body.appendChild(videoEl);
            State.activeWebcamStreams[camId] = videoEl;

            const deviceId = cam.rtsp_url.replace('webcam://', '');
            const constraints = deviceId && deviceId !== 'local'
                ? { video: { deviceId: { exact: deviceId } } }
                : { video: true };

            navigator.mediaDevices.getUserMedia(constraints)
                .then(stream => {
                    videoEl.srcObject = stream;
                    videoEl.play().catch(e => console.warn("Failed to play webcam stream:", e));
                    const onReady = () => {
                        console.log(`[BrowserDetector] Webcam ready for "${cam.name}", starting detection.`);
                        startBrowserDetectionLoop(cam, videoEl);
                        videoEl.removeEventListener('canplay', onReady);
                    };
                    if (videoEl.readyState >= 2) {
                        startBrowserDetectionLoop(cam, videoEl);
                    } else {
                        videoEl.addEventListener('canplay', onReady);
                    }
                })
                .catch(err => {
                    console.warn(`Webcam access failed for device ${deviceId}:`, err);
                });
        } else if (cam.rtsp_url.startsWith('webcam://') && videoEl) {
            // Webcam already running — only restart detection loop if it's not already active
            if (!State.activeBrowserDetectors[camId]) {
                startBrowserDetectionLoop(cam, videoEl);
            }

        } else if (!cam.rtsp_url.startsWith('webcam://') && !State.activeHlsStreams[camId]) {
            // ── RTSP/ONVIF: Start HLS stream → draw on canvas ────────────────
            console.log(`[HLS-Card] Starting HLS stream for camera "${cam.name}" (${cam.rtsp_url})`);

            hlsVideoEl = document.createElement('video');
            hlsVideoEl.classList.add('backend-video-stream');
            hlsVideoEl.autoplay = true;
            hlsVideoEl.playsInline = true;
            hlsVideoEl.muted = true;
            hlsVideoEl.style.display = 'none';
            document.body.appendChild(hlsVideoEl);

            const streamId = `card-${camId}`;
            State.activeHlsStreams[camId] = { videoEl: hlsVideoEl, hls: null, streamId, ready: false };

            fetch(window.API_BASE_URL + '/api/hls/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rtspUrl: cam.rtsp_url, streamId })
            })
                .then(r => r.json())
                .then(result => {
                    if (!result.ok || !result.streamUrl) {
                        console.warn(`[HLS-Card] Stream start failed for ${cam.name}:`, result.error);
                        return;
                    }
                    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                        const hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, lowLatencyMode: true });
                        State.activeHlsStreams[camId].hls = hls;
                        hls.loadSource(window.API_BASE_URL + result.streamUrl);
                        hls.attachMedia(hlsVideoEl);
                        hls.on(Hls.Events.MANIFEST_PARSED, () => hlsVideoEl.play().catch(() => { }));
                        hls.on(Hls.Events.FRAG_BUFFERED, () => {
                            if (State.activeHlsStreams[camId] && !State.activeHlsStreams[camId].ready) {
                                State.activeHlsStreams[camId].ready = true;
                                // Hide the "CONNECTING..." loading overlay
                                const loadingEl = document.getElementById(`canvas-loading-${camId}`);
                                if (loadingEl) loadingEl.style.display = 'none';
                                // Feed HLS frames into browser detection loop ONLY ONCE
                                startBrowserDetectionLoop(cam, hlsVideoEl);
                            }
                        });

                        hls.on(Hls.Events.ERROR, (e, d) => {
                            if (d.fatal) {
                                console.warn(`[HLS-Card] Fatal error for ${cam.name}:`, d.details);
                                if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
                                    hls.startLoad();
                                } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
                                    hls.recoverMediaError();
                                } else {
                                    hls.destroy();
                                }
                            }
                        });
                    } else if (hlsVideoEl.canPlayType('application/vnd.apple.mpegurl')) {
                        hlsVideoEl.src = window.API_BASE_URL + result.streamUrl;
                        hlsVideoEl.play().catch(() => { });
                        if (State.activeHlsStreams[camId]) State.activeHlsStreams[camId].ready = true;
                        startBrowserDetectionLoop(cam, hlsVideoEl);
                    }
                })
                .catch(err => console.warn(`[HLS-Card] Fetch error for ${cam.name}:`, err));

        } else if (!cam.rtsp_url.startsWith('webcam://') && State.activeHlsStreams[camId]) {
            // Already have an HLS stream — reuse it, only start detection if not already running
            hlsVideoEl = State.activeHlsStreams[camId].videoEl;
            if (State.activeHlsStreams[camId].ready && !State.activeBrowserDetectors[camId]) {
                startBrowserDetectionLoop(cam, hlsVideoEl);
            }
        }

        let frameCount = 0;
        const loc = cam.location.toLowerCase();

        let objects = getPromptSimulatedObjects(cam.activePromptText, cam.activePromptMetadata);
        let lastPromptText = cam.activePromptText;
        let lastPromptMetadata = cam.activePromptMetadata;
        let roomLines = [];

        if (loc.includes('gate') || loc.includes('door') || loc.includes('yard') || loc.includes('garden')) {
            roomLines = [
                { x1: 20, y1: 140, x2: 300, y2: 140 },
                { x1: 60, y1: 40, x2: 60, y2: 140 },
                { x1: 260, y1: 40, x2: 260, y2: 140 },
                { x1: 60, y1: 80, x2: 260, y2: 80 },
                { x1: 60, y1: 110, x2: 260, y2: 110 }
            ];
        } else if (loc.includes('nursery') || loc.includes('room') || loc.includes('nanny') || loc.includes('crib')) {
            roomLines = [
                { x1: 40, y1: 140, x2: 280, y2: 140 },
                { x1: 80, y1: 90, x2: 240, y2: 90 },
                { x1: 80, y1: 130, x2: 240, y2: 130 },
                { x1: 80, y1: 90, x2: 80, y2: 140 },
                { x1: 240, y1: 90, x2: 240, y2: 140 },
                { x1: 120, y1: 90, x2: 120, y2: 130 },
                { x1: 160, y1: 90, x2: 160, y2: 130 },
                { x1: 200, y1: 90, x2: 200, y2: 130 }
            ];
        } else if (loc.includes('warehouse') || loc.includes('dock') || loc.includes('stock')) {
            roomLines = [
                { x1: 10, y1: 150, x2: 310, y2: 150 },
                { x1: 30, y1: 20, x2: 30, y2: 150 },
                { x1: 150, y1: 20, x2: 150, y2: 150 },
                { x1: 270, y1: 20, x2: 270, y2: 150 },
                { x1: 30, y1: 60, x2: 270, y2: 60 },
                { x1: 30, y1: 110, x2: 270, y2: 110 }
            ];
        } else {
            roomLines = [
                { x1: 0, y1: 140, x2: 320, y2: 140 },
                { x1: 100, y1: 20, x2: 60, y2: 140 },
                { x1: 220, y1: 20, x2: 260, y2: 140 },
                { x1: 100, y1: 20, x2: 220, y2: 20 },
                { x1: 60, y1: 60, x2: 100, y2: 60 }
            ];
        }

        const renderLoop = () => {
            if (!document.getElementById(`canvas-${camId}`)) {
                // Canvas removed — clean up webcam
                if (State.activeWebcamStreams[camId]) {
                    const v = State.activeWebcamStreams[camId];
                    if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
                    v.remove();
                    delete State.activeWebcamStreams[camId];
                }
                // Clean up HLS stream for this card
                if (State.activeHlsStreams[camId]) {
                    const h = State.activeHlsStreams[camId];
                    if (h.hls) { try { h.hls.destroy(); } catch (e) { } }
                    if (h.videoEl) h.videoEl.remove();
                    if (h.streamId) {
                        fetch(window.API_BASE_URL + '/api/hls/stop', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ streamId: h.streamId })
                        }).catch(() => { });
                    }
                    delete State.activeHlsStreams[camId];
                }
                delete State.activeCanvasLoops[camId];
                return;
            }
            frameCount++;

            if (cam.activePromptText !== lastPromptText || cam.activePromptMetadata !== lastPromptMetadata) {
                lastPromptText = cam.activePromptText;
                lastPromptMetadata = cam.activePromptMetadata;
                objects = getPromptSimulatedObjects(cam.activePromptText, cam.activePromptMetadata);
            }

            // Determine which video source to draw
            const webcamReady = cam.rtsp_url.startsWith('webcam://') && videoEl && videoEl.readyState >= 2;
            const hlsEntry = State.activeHlsStreams[camId];
            const hlsReady = hlsEntry && hlsEntry.ready && hlsEntry.videoEl && hlsEntry.videoEl.readyState >= 2;

            if (webcamReady) {
                // Live webcam frame
                if (videoEl.videoWidth && canvas.width !== videoEl.videoWidth) {
                    autoResizeCanvasToVideo(canvas, videoEl);
                }
                drawImageContain(ctx, videoEl, canvas.width, canvas.height);
            } else if (hlsReady) {
                // Live RTSP→HLS frame
                drawImageContain(ctx, hlsEntry.videoEl, canvas.width, canvas.height);
            } else {
                // Fallback: animated grid (stream loading or offline)
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = 'rgba(6, 10, 19, 0.4)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
                ctx.lineWidth = 1;
                for (let i = 20; i < canvas.width; i += 20) {
                    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
                }
                for (let j = 20; j < canvas.height; j += 20) {
                    ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(canvas.width, j); ctx.stroke();
                }

                // Show loading text if HLS is initialising
                if (hlsEntry && !hlsEntry.ready) {
                    ctx.fillStyle = 'rgba(96, 165, 250, 0.7)';
                    ctx.font = 'bold 10px monospace';
                    ctx.textAlign = 'center';
                    ctx.fillText('⏳ STREAM LOADING...', canvas.width / 2, canvas.height / 2 + 20);
                    ctx.textAlign = 'left';
                } else {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                    ctx.lineWidth = 1.5;
                    roomLines.forEach(line => {
                        ctx.beginPath(); ctx.moveTo(line.x1, line.y1); ctx.lineTo(line.x2, line.y2); ctx.stroke();
                    });
                }
            }

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(canvas.width / 2 - 10, canvas.height / 2); ctx.lineTo(canvas.width / 2 + 10, canvas.height / 2);
            ctx.moveTo(canvas.width / 2, canvas.height / 2 - 10); ctx.lineTo(canvas.width / 2, canvas.height / 2 + 10);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(15, 25); ctx.lineTo(15, 15); ctx.lineTo(25, 15);
            ctx.moveTo(canvas.width - 25, 15); ctx.lineTo(canvas.width - 15, 15); ctx.lineTo(canvas.width - 15, 25);
            ctx.moveTo(15, canvas.height - 25); ctx.lineTo(15, canvas.height - 15); ctx.lineTo(25, canvas.height - 15);
            ctx.moveTo(canvas.width - 25, canvas.height - 15); ctx.lineTo(canvas.width - 15, canvas.height - 15); ctx.lineTo(canvas.width - 15, canvas.height - 25);
            ctx.stroke();

            if (cam.status !== 'Paused') {
                const matchState = cameraMatchState[camId];
                // Only draw detection box when Gemini confirmed a MATCH and it hasn't expired
                if (matchState && Date.now() < matchState.expiresAt) {
                    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(frameCount * 0.08));
                    const CAPTURE_W = 320;
                    const CAPTURE_H = 180;
                    const scaleX = canvas.width / CAPTURE_W;
                    const scaleY = canvas.height / CAPTURE_H;

                    const reason = (matchState.label || '').toLowerCase();

                    if (matchState) {
                        // Match active - no bounding box drawn as requested by user
                    } else {
                        // No Gemini match active - no bounding box drawn as requested by user
                    }
                } // Added missing brace here
            } else {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.fillRect(canvas.width / 2 - 12, canvas.height / 2 - 18, 8, 36);
                ctx.fillRect(canvas.width / 2 + 4, canvas.height / 2 - 18, 8, 36);
            }

            const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.font = '8px monospace';
            ctx.fillText(dateStr, 12, canvas.height - 8);

            State.activeCanvasLoops[camId] = requestAnimationFrame(renderLoop);
        };

        renderLoop();
    };

    let _lastPage = null;
    const router = async () => {
        const hash = window.location.hash || '#dashboard';
        let pageName = hash.replace('#', '');
        
        if (pageName === 'google-login' || pageName === 'login') {
            pageName = 'dashboard';
        }

        // Only tear down camera streams when navigating AWAY from the cameras page
        if (_lastPage === 'cameras' && pageName !== 'cameras') {
            cancelAllCameraPreviews();
        }
        _lastPage = pageName;

        // Trial Enforcement Override
        

        // Deactivate all views & menus
        views.forEach(v => v.classList.remove('active'));
        menuLinks.forEach(l => {
            if (l.getAttribute('data-page') === pageName) {
                l.classList.add('active');
            } else {
                l.classList.remove('active');
            }
        });

        const targetView = document.getElementById(`view-${pageName}`);
        if (targetView) {
            targetView.classList.add('active');
        }

        // Trigger loading scoped page data
        if (State.currentUser) {
            await loadPageData(pageName);
        }
    };

    window.addEventListener('hashchange', router);

    // Fix: Resume RTSP streams and force jump to live edge when shifting tabs back
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            Object.values(State.activeHlsStreams).forEach(entry => {
                // Force HLS to resume fetching and recover from potential background stall
                if (entry.hls) {
                    try {
                        entry.hls.startLoad();
                        entry.hls.recoverMediaError();
                    } catch (e) {
                        console.warn('[HLS] Recovery on visibilitychange failed:', e);
                    }
                }
                if (entry.videoEl) {
                    entry.videoEl.play().catch(() => { });
                    // Jump to live sync edge if lagging behind
                    if (entry.hls && entry.hls.liveSyncPosition) {
                        const delta = Math.abs(entry.videoEl.currentTime - entry.hls.liveSyncPosition);
                        if (delta > 3) entry.videoEl.currentTime = entry.hls.liveSyncPosition;
                    }
                }
            });
        }
    });

    const loadPageData = async (pageName) => {
        switch (pageName) {
            case 'dashboard':
                await loadDashboardStats();
                startDashboardPolling();
                break;
            case 'cameras':
                await renderCamerasGrid();
                break;
            case 'alerts':
                await renderAlertsTimeline();
                break;
            case 'analytics':
                // Calculations calculated dynamically via SVG paths
                break;
            case 'notifications':
                await loadNotificationsForm();
                break;
            break;
            case 'settings':
                await loadSettingsForm();
                break;
            case 'metrics':
                await loadSystemMetrics();
                startMetricsPolling();
                break;
        }
    };

    // ── Live Dashboard Polling ──────────────────────────────────────────────
    // Refreshes Live Activity stats every 10s while the user is on #dashboard
    let dashboardPoller = null;
    const startDashboardPolling = () => {
        if (dashboardPoller) clearInterval(dashboardPoller);
        dashboardPoller = setInterval(async () => {
            if (document.hidden) return;
            const activeHash = window.location.hash || '#dashboard';
            if (activeHash === '#dashboard') {
                await loadDashboardStats();
            } else {
                clearInterval(dashboardPoller);
                dashboardPoller = null;
            }
        }, 10000); // Every 10 seconds

        if (typeof dbClient !== 'undefined' && dbClient.supabase) {
            try {
                if (window.dashboardRealtimeChannel) {
                    window.dashboardRealtimeChannel.unsubscribe();
                }
                window.dashboardRealtimeChannel = dbClient.supabase
                    .channel('live-dashboard')
                    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'detections', filter: `user_id=eq.${State.currentUser.id}` }, async () => {
                        const activeHash = window.location.hash || '#dashboard';
                        if (activeHash === '#dashboard') await loadDashboardStats();
                    })
                    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cameras', filter: `user_id=eq.${State.currentUser.id}` }, async () => {
                        const activeHash = window.location.hash || '#dashboard';
                        if (activeHash === '#dashboard') await loadDashboardStats();
                    })
                    .subscribe();
            } catch (e) {
                console.warn('[Realtime] Could not subscribe to live changes:', e.message);
            }
        }
    };
    // Auto trigger Google Login simulator or real OAuth if configured
    const checkGoogleLogin = async () => {
        if (window.location.hash === '#google-login' || window.location.hash === '#login') {
            if (isSupabaseConfigured()) {
                const { error } = await dbClient.auth.signInWithGoogle();
                if (error) {
                    showToast(error.message, 'error');
                }
            } else {
                const { data, error } = await dbClient.auth.signIn("demo@osha.ai", "password");
                if (!error) {
                    showToast("Logged in via Google OAuth!", 'success');
                    window.location.hash = '#dashboard';
                    // Trigger auth state change events
                    window.dispatchEvent(new CustomEvent('osha-auth-state-changed'));
                }
            }
        }
    };

    // 4. Authenticated Session Logic
    let authHandling = false; // Guard: prevent concurrent auth handler executions
    const initAuthListener = () => {
        dbClient.auth.onAuthStateChange(async (event, session) => {
            // Wait for any ongoing auth handling to complete instead of dropping events
            while (authHandling) { await new Promise(r => setTimeout(r, 50)); }
            authHandling = true;
            try {
                const authContainer = document.getElementById('auth-container');
                const consoleContainer = document.getElementById('console-container');

                if (session) {
                    // Strict 48-Hour Session Safety Limit
                    const TWO_DAYS_MS = 48 * 60 * 60 * 1000;
                    let loginTimestamp = localStorage.getItem('osha_auth_timestamp');

                    if (!loginTimestamp) {
                        // First time seeing this session, record timestamp
                        loginTimestamp = Date.now().toString();
                        localStorage.setItem('osha_auth_timestamp', loginTimestamp);
                    } else if (Date.now() - parseInt(loginTimestamp) > TWO_DAYS_MS) {
                        // Session exceeds 48 hours. Enforce strict logout for security.
                        console.log("[Auth] Security limit reached. Enforcing 48-hour logout.");
                        localStorage.removeItem('osha_auth_timestamp');
                        await dbClient.auth.signOut();
                        return; // Stop execution, auth listener will fire SIGNED_OUT
                    }

                    State.currentUser = session.user;

                    // Show/hide banners
                    const configured = isSupabaseConfigured();
                    const banner = document.getElementById('simulation-banner');
                    if (banner) {
                        banner.style.display = configured ? 'none' : 'flex';
                    }

                    // Show Admin Only Elements
                    const isAdmin = (State.currentUser.email === 'amaanshaikh.contact@gmail.com');

                    const navMetrics = document.getElementById('nav-metrics');
                    if (navMetrics) {
                        navMetrics.style.display = isAdmin ? 'flex' : 'none';
                    }

                    const adminEmailPanel = document.getElementById('admin-email-config-panel');
                    if (adminEmailPanel) {
                        adminEmailPanel.style.display = isAdmin ? 'block' : 'none';
                    }

                    // Retrieve Profile, Subscription, & Settings
                    let profileRes = await dbClient.getProfile(State.currentUser.id);

                    // Explicitly persist Free Trial by default in Supabase if profile is missing
                    if (!profileRes.data) {
                        console.log("[Billing] Missing profile. Upserting default Free plan to Supabase.");
                        await dbClient.updateProfile(State.currentUser.id, {
                            full_name: State.currentUser.email ? State.currentUser.email.split('@')[0] : 'Workspace User',
                            email: State.currentUser.email || 'user@osha.ai',
                            subscription_plan: 'Free',
                            subscription_status: 'Active'
                        });
                        profileRes = await dbClient.getProfile(State.currentUser.id);
                    }
                    State.userProfile = profileRes.data || { subscription_plan: 'Free', full_name: 'User' };

                    // Sync Google OAuth avatar & name into profile if missing
                    const authMeta = session.user.user_metadata || {};
                    const googleAvatar = authMeta.avatar_url || authMeta.picture || null;
                    const googleName = authMeta.full_name || authMeta.name || null;
                    const profileUpdates = {};
                    if (googleAvatar && !State.userProfile.avatar_url) {
                        profileUpdates.avatar_url = googleAvatar;
                    }
                    if (googleName && !State.userProfile.full_name) {
                        profileUpdates.full_name = googleName;
                    }
                    if (Object.keys(profileUpdates).length > 0) {
                        console.log('[Auth] Syncing Google OAuth data to profile:', profileUpdates);
                        await dbClient.updateProfile(State.currentUser.id, profileUpdates);
                        // Refresh profile
                        const refreshed = await dbClient.getProfile(State.currentUser.id);
                        if (refreshed.data) State.userProfile = refreshed.data;
                    }

                    let subRes = await dbClient.getSubscription(State.currentUser.id);
                    if (!subRes.data || (subRes.data.plan_name === 'Free' && !subRes.data.id)) {
                        console.log("[Billing] Missing subscription row. Upserting default Free plan to Supabase.");
                        await dbClient.updateSubscription(State.currentUser.id, { plan_name: 'Free', subscription_status: 'active' });
                        subRes = await dbClient.getSubscription(State.currentUser.id);
                    }
                    const userSub = subRes.data || { plan: 'Free', status: 'active' };
                    const settingsRes = await dbClient.getSettings(State.currentUser.id);
                    State.userSettings = settingsRes.data || {
                        user_id: State.currentUser.id,
                        timezone: 'UTC',
                        theme: 'light',
                        email_notifications: true,
                        notification_cooldown: 60,
                        daily_summary: false
                    };

                    // Expiration & Downgrade Enforcement
                    if (userSub) {
                        const currentPlan = userSub.plan_name || userSub.plan || 'Free';
                        const currentStatus = userSub.subscription_status || userSub.status || 'active';
                        const currentEndDate = userSub.end_date || userSub.current_period_end;

                        if (currentPlan !== 'Free') {
                            let isExpired = false;
                            // Check if the expiration date has passed (add a 3-day grace period for Stripe webhook delays)
                            const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
                            if (currentEndDate && (new Date(currentEndDate).getTime() + GRACE_PERIOD_MS) < Date.now()) {
                                isExpired = true;
                            }
                            // Check if Stripe reported a payment failure or cancellation
                            if (currentStatus === 'Past Due' || currentStatus === 'Cancelled' || currentStatus === 'canceled' || currentStatus === 'Unpaid' || currentStatus === 'past_due' || currentStatus === 'expired') {
                                isExpired = true;
                            }

                            if (isExpired) {
                                console.log("[Billing] Subscription expired or payment failed. Auto-downgrading to Free tier.");
                                userSub.plan_name = 'Free';
                                userSub.subscription_status = 'expired';
                                // Auto-correct the cloud database immediately
                                dbClient.updateSubscription(State.currentUser.id, { plan_name: 'Free', subscription_status: 'expired' });
                                dbClient.updateProfile(State.currentUser.id, { subscription_plan: 'Free', subscription_status: 'expired' });
                            }
                        }
                    }

                    // Defensive Fallbacks if database trigger lags or fails
                    if (!State.userProfile) {
                        State.userProfile = {
                            id: State.currentUser.id,
                            full_name: State.currentUser.email ? State.currentUser.email.split('@')[0] : 'Workspace User',
                            email: State.currentUser.email || 'user@osha.ai',
                            subscription_plan: userSub ? (userSub.plan_name || userSub.plan || 'Free') : 'Free',
                            subscription_status: userSub ? (userSub.subscription_status || userSub.status || 'active') : 'Active'
                        };
                    } else if (userSub) {
                        // Force profile to mirror the official subscriptions table
                        State.userProfile.subscription_plan = userSub.plan_name || userSub.plan || 'Free';
                        State.userProfile.subscription_status = userSub.subscription_status || userSub.status || 'active';
                    }

                    // The 2-day free trial is replaced by a 20 live camera minute limit in the backend.
                    // We no longer automatically expire based on created_at date.

                    if (!State.userSettings) {
                        State.userSettings = {
                            user_id: State.currentUser.id,
                            timezone: 'UTC',
                            theme: 'light',
                            email_notifications: true,
                            notification_cooldown: 60,
                            daily_summary: false
                        };
                    }

                    // Handle mock checkout redirection (Simulate Stripe Webhook)
                    const urlParams = new URLSearchParams(window.location.search);
                    if (urlParams.get('mock_checkout') === 'true') {
                        const priceId = urlParams.get('priceId');
                        const newPlan = priceId.includes('pro') ? 'Pro' : 'Starter';
                        console.log(`[Mock Checkout] Upgrading to ${newPlan}...`);

                        // Update Profiles
                        const profileRes = await dbClient.updateProfile(State.currentUser.id, { subscription_plan: newPlan });
                        const subRes = await dbClient.updateSubscription(State.currentUser.id, { plan: newPlan });

                        if (profileRes.error || subRes.error) {
                            const errMsg = (profileRes.error && profileRes.error.message) || (subRes.error && subRes.error.message) || 'Unknown DB Error';
                            console.error("Mock Checkout Save Error:", profileRes.error || subRes.error);
                            showToast(`DB Error: ${errMsg}`, 'error');
                            // Clean URL anyway to prevent endless loop
                            const newUrl = window.location.pathname;
                            window.history.replaceState({}, document.title, newUrl);
                            return;
                        }
                        const oldPlan = State.userProfile.subscription_plan || 'Free Trial';
                        State.userProfile.subscription_plan = newPlan;
                        if (window.updateProfileRing) window.updateProfileRing(newPlan);
                        if (window.updateFeatureLocks) window.updateFeatureLocks(newPlan);

                        // Clean URL
                        const newUrl = window.location.pathname;
                        window.history.replaceState({}, document.title, newUrl);

                        setTimeout(() => {
                            showToast(`Successfully upgraded to ${newPlan} Plan!`, 'success');
                            // Trigger Purchase Walkthrough
                            if (typeof showPurchaseWalkthrough === 'function') {
                                showPurchaseWalkthrough(oldPlan, newPlan);
                            }
                        }, 1000);
                    }

                    // Sync workspace titles
                    if (State.userProfile) {
                        // Fallback to Google Auth metadata if the database profile only caught the email prefix
                        const actualName = (State.currentUser && State.currentUser.user_metadata && (State.currentUser.user_metadata.full_name || State.currentUser.user_metadata.name)) || State.userProfile.full_name || 'User';

                        document.getElementById('sidebar-username').textContent = actualName;
                        document.getElementById('topbar-welcome').textContent = `Welcome back, ${actualName.split(' ')[0]}`;

                        const avatarUrl = State.userProfile.avatar_url || (State.currentUser && State.currentUser.user_metadata ? (State.currentUser.user_metadata.avatar_url || State.currentUser.user_metadata.picture) : null);

                        if (avatarUrl) {
                            const initial = State.userProfile.full_name ? State.userProfile.full_name.charAt(0).toUpperCase() : 'U';
                            const imgHtml = `<img src="${avatarUrl}" alt="Profile" referrerpolicy="no-referrer" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.onerror=null; this.style.display='none'; this.parentElement.textContent='${initial}';">`;
                            document.getElementById('sidebar-avatar').innerHTML = imgHtml;
                            document.getElementById('topbar-avatar-btn').innerHTML = imgHtml;
                        } else {
                            const initial = State.userProfile.full_name ? State.userProfile.full_name.charAt(0).toUpperCase() : 'U';
                            document.getElementById('sidebar-avatar').textContent = initial;
                            document.getElementById('topbar-avatar-btn').textContent = initial;
                        }

                        // Premium Plan Profile Rings
                        window.updateProfileRing = function (plan) {
                            const p = (plan || 'Free').toLowerCase();
                            ['sidebar-avatar', 'topbar-avatar-btn'].forEach(id => {
                                const el = document.getElementById(id);
                                if (!el) return;
                                el.classList.remove('premium-starter', 'premium-pro');
                                if (p === 'starter') el.classList.add('premium-starter');
                                if (p === 'pro') el.classList.add('premium-pro');
                            });
                        };
                        window.updateProfileRing(State.userProfile.subscription_plan);

                        // UI Feature Locks based on Plan
                        window.updateFeatureLocks = function (plan) {
                            const p = (plan || 'Free').toLowerCase();
                            const aiSearchLockOverlay = document.getElementById('ai-search-lock-overlay');
                            const aiSearchInput = document.getElementById('ai-search-input');
                            const aiSearchBtn = document.getElementById('ai-search-btn');

                            if (aiSearchLockOverlay) {
                                if (p === 'free' || p === 'free trial') {
                                    aiSearchLockOverlay.style.display = 'flex';
                                    if (aiSearchInput) aiSearchInput.disabled = true;
                                    if (aiSearchBtn) aiSearchBtn.disabled = true;
                                } else {
                                    aiSearchLockOverlay.style.display = 'none';
                                    if (aiSearchInput) aiSearchInput.disabled = false;
                                    if (aiSearchBtn) aiSearchBtn.disabled = false;
                                }
                            }
                            
                            const notificationsLockOverlay = document.getElementById('notifications-lock-overlay');
                            const settingsForm = document.getElementById('settings-notifications-form');
                            if (notificationsLockOverlay) {
                                if (p === 'free' || p === 'free trial') {
                                    notificationsLockOverlay.style.display = 'flex';
                                    if (settingsForm) {
                                        const inputs = settingsForm.querySelectorAll('input, button');
                                        inputs.forEach(el => el.disabled = true);
                                    }
                                } else {
                                    notificationsLockOverlay.style.display = 'none';
                                    if (settingsForm) {
                                        const inputs = settingsForm.querySelectorAll('input, button');
                                        inputs.forEach(el => el.disabled = false);
                                    }
                                }
                            }
                        };
                        window.updateFeatureLocks(State.userProfile.subscription_plan);

                        // Sync global topbar and billing camera quota in realtime
                        const camsRes = await dbClient.getCameras(State.currentUser.id);
                        const cams = camsRes.data || [];
                        window.syncCameraUsageUI(cams.length, State.userProfile?.subscription_plan);
                    }

                    // Setup Real-time Supabase Subscription for instant counter/timeline updates
                    if (window.realtimeSub) {
                        try { window.realtimeSub.unsubscribe(); } catch (e) { }
                    }
                    window.realtimeSub = dbClient.subscribeToDetections(State.currentUser.id, (newDetection, eventType) => {
                        // Look up camera name instantly using local state instead of an HTTP round-trip
                        const cams = State.cameraList || [];
                        const cam = cams.find(c => c.id === newDetection.camera_id);
                        const cameraName = cam ? cam.name : 'Unknown Camera';

                        // Dispatch the local event which already drives UI updates
                        const ev = new CustomEvent('osha-live-detection', {
                            detail: { detection: newDetection, cameraName: cameraName, eventType: eventType }
                        });
                        window.dispatchEvent(ev);
                    });

                    // Render main viewport layout
                    authContainer.classList.remove('active');
                    consoleContainer.classList.add('active');

                    // Load initial page metrics
                    await router();
                    await syncNotificationsBellBadge();
                    setupProfileRealtime();
                    setupAlertBadgeRealtime();

                    // Request browser push notification permission on first user interaction (avoids browser silent block)
                    if ('Notification' in window && Notification.permission === 'default') {
                        const requestNotif = () => {
                            Notification.requestPermission();
                            document.removeEventListener('click', requestNotif);
                        };
                        document.addEventListener('click', requestNotif);
                    }

                } else {
                    localStorage.removeItem('osha_auth_timestamp');
                    State.currentUser = null;
                    State.userProfile = null;
                    State.userSettings = null;
                    consoleContainer.classList.remove('active');
                    authContainer.classList.add('active');

                    // Route back to default view if needed
                    if (window.location.hash === '#google-login') {
                        window.location.hash = '#dashboard';
                    }
                }
            } catch (err) {
                console.error("[Auth] Fatal error during session init:", err);
                // Force dashboard to render even if some database sync failed
                const authContainer = document.getElementById('auth-container');
                const consoleContainer = document.getElementById('console-container');
                authContainer.classList.remove('active');
                consoleContainer.classList.add('active');
                await router();
            } finally {
                authHandling = false;
            }
        });
    };

    window.addEventListener('hashchange', () => {
        if (window.location.hash === '#google-login' || window.location.hash === '#login') {
            checkGoogleLogin();
        }
    });

    // 5. Google Auth Submission
    const googleAuthBtn = document.getElementById('google-auth-btn');
    if (googleAuthBtn) {
        googleAuthBtn.addEventListener('click', async () => {
            if (isSupabaseConfigured()) {
                const { error } = await dbClient.auth.signInWithGoogle();
                if (error) {
                    showToast(error.message, 'error');
                }
            } else {
                const { data, error } = await dbClient.auth.signIn("demo@osha.ai", "password");
                if (!error) {
                    showToast("Logged in via Google OAuth!", 'success');
                    window.location.hash = '#dashboard';
                    window.dispatchEvent(new CustomEvent('osha-auth-state-changed'));
                }
            }
        });
    }

    const logoutTrigger = document.getElementById('logout-btn-trigger');
    logoutTrigger.addEventListener('click', async () => {
        const { error } = await dbClient.auth.signOut();
        if (!error) {
            window.location.reload();
        }
    });

    // Settings tab — Sign Out button
    const settingsLogoutBtn = document.getElementById('settings-logout-btn');
    if (settingsLogoutBtn) {
        settingsLogoutBtn.addEventListener('click', async () => {
            settingsLogoutBtn.disabled = true;
            settingsLogoutBtn.textContent = 'Signing out...';
            const { error } = await dbClient.auth.signOut();
            if (!error) {
                window.location.reload();
            } else {
                showToast("Sign out failed: " + error.message, 'error');
                settingsLogoutBtn.disabled = false;
                settingsLogoutBtn.innerHTML = '<i data-lucide="log-out"></i> Sign Out';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });
    }

    // Settings tab — Email Config form
    const emailConfigForm = document.getElementById('settings-email-config-form');
    const smtpUserInput = document.getElementById('settings-smtp-user');
    const smtpPassInput = document.getElementById('settings-smtp-pass');
    const smtpStatus = document.getElementById('settings-smtp-status');

    // Pre-fill with current saved values from the server
    if (emailConfigForm) {
        fetch(window.API_BASE_URL + '/api/settings/email')
            .then(r => r.json())
            .then(data => {
                if (smtpUserInput && data.gmailUser) smtpUserInput.value = data.gmailUser;
                if (smtpStatus) smtpStatus.textContent = data.gmailUser ? `✅ Connected as ${data.gmailUser}` : 'Not configured';
            })
            .catch(() => { });

        emailConfigForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const saveBtn = document.getElementById('settings-smtp-save-btn');
            const gmailUser = smtpUserInput.value.trim();
            const gmailPass = smtpPassInput.value.trim();

            if (!gmailUser || !gmailPass) {
                showToast('Please enter both Gmail address and App Password.', 'error');
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            if (smtpStatus) smtpStatus.textContent = '';

            try {
                const res = await fetch(window.API_BASE_URL + '/api/settings/email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gmailUser, gmailPass })
                });
                const result = await res.json();

                if (res.ok && result.ok) {
                    showToast('✅ Email settings saved and connection verified!', 'success');
                    if (smtpStatus) smtpStatus.textContent = `✅ Connected as ${gmailUser}`;
                    smtpPassInput.value = '';
                } else {
                    showToast('Gmail connection failed: ' + (result.error || 'Check credentials'), 'error');
                    if (smtpStatus) smtpStatus.textContent = '❌ Connection failed';
                }
            } catch (err) {
                showToast('Network error saving email settings.', 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i data-lucide="save"></i> Save & Reconnect';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });
    }

    // 6. Global Search Indexing Engine
    const searchInput = document.getElementById('global-search-input');
    const searchDropdown = document.getElementById('search-results');
    const searchResultsList = document.getElementById('search-results-list');

    searchInput.addEventListener('input', async () => {
        const query = searchInput.value.toLowerCase().trim();
        if (!query) {
            searchDropdown.classList.remove('active');
            return;
        }

        searchResultsList.innerHTML = '<div class="no-results-msg">Searching dynamically...</div>';

        let matchCount = 0;

        // 1. Fetch exact matching cameras
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const cameras = camsRes.data || [];

        cameras.forEach(cam => {
            if (cam.name.toLowerCase().includes(query) || cam.location.toLowerCase().includes(query)) {
                matchCount++;
                const item = document.createElement('a');
                item.href = '#cameras';
                item.className = 'search-result-item';
                item.innerHTML = `
                    <span class="result-title">📹 Camera: ${cam.name}</span>
                    <span class="result-desc">${cam.location}</span>
                `;
                item.addEventListener('click', () => {
                    searchDropdown.classList.remove('active');
                    searchInput.value = '';
                });
                searchResultsList.appendChild(item);
            }
        });

        // 2. Perform Semantic Search for events
        try {
            const semanticRes = await API.performSemanticSearch(query, State.currentUser.id);

            if (semanticRes && !semanticRes.error) {
                const results = semanticRes.results || [];
                results.forEach(alert => {
                    matchCount++;
                    const item = document.createElement('a');
                    item.href = '#alerts';
                    item.className = 'search-result-item';
                    item.innerHTML = `
                        <span class="result-title">🧠 Semantic Match (${Math.round(alert.similarity * 100)}%)</span>
                        <span class="result-desc">"${alert.reason}"</span>
                    `;
                    item.addEventListener('click', () => {
                        searchDropdown.classList.remove('active');
                        searchInput.value = '';
                    });
                    searchResultsList.appendChild(item);
                });
            }
        } catch (err) {
            console.error('[Search] Semantic search failed:', err);
        }

        if (matchCount === 0) {
            searchResultsList.innerHTML = `<div class="no-results-msg">No matching cameras or semantic events found.</div>`;
        } else {
            const loadingMsg = searchResultsList.querySelector('.no-results-msg');
            if (loadingMsg) loadingMsg.remove();
        }

        searchDropdown.classList.add('active');
    });

    // Close search dropdown on click outside
    document.addEventListener('click', (e) => {
        if (searchDropdown && searchInput && !searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
            searchDropdown.classList.remove('active');
        }
    });

    // 7. Notification Bell Dropdown List
    const bellTrigger = document.getElementById('bell-dropdown-trigger');
    const bellDropdown = document.getElementById('bell-dropdown');
    const bellAlertsList = document.getElementById('bell-alerts-list');

    bellTrigger.addEventListener('click', async (e) => {
        e.stopPropagation();
        bellDropdown.classList.toggle('show');
        if (bellDropdown.classList.contains('show')) {
            await syncNotificationsBellDropdown();
        }
    });

    document.addEventListener('click', () => {
        bellDropdown.classList.remove('show');
    });

    const syncSidebarCameraBadge = async () => {
        if (!State.currentUser) return;
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const cameras = camsRes.data || [];
        const count = cameras.length;
        const sidebarCamsBadge = document.getElementById('sidebar-cams-badge');
        if (sidebarCamsBadge) {
            sidebarCamsBadge.textContent = count;
            if (count > 0) {
                sidebarCamsBadge.classList.add('visible');
            } else {
                sidebarCamsBadge.classList.remove('visible');
            }
        }
    };

    const syncNotificationsBellBadge = async () => {
        if (!State.currentUser) return;
        const { data } = await dbClient.getDetections(State.currentUser.id);
        const alerts = data || [];
        const unreadCount = alerts.filter(d => d.status === 'Unread').length;
        const totalCount = alerts.length;

        const badge = document.getElementById('bell-badge');
        const sidebarBadge = document.getElementById('sidebar-alert-badge');

        // Bell icon: show unread count only
        if (badge) {
            if (unreadCount > 0) {
                badge.textContent = unreadCount;
                badge.classList.add('visible');
            } else {
                badge.classList.remove('visible');
            }
        }

        // Sidebar tab: show total alert count
        if (sidebarBadge) {
            sidebarBadge.textContent = totalCount;
            if (totalCount > 0) {
                sidebarBadge.classList.add('visible');
            } else {
                sidebarBadge.classList.remove('visible');
            }
        }

        // Keep camera counts synced as well
        await syncSidebarCameraBadge();
    };

    // Setup a persistent Supabase realtime channel that keeps the badge accurate in real-time
    // This is separate from the detection subscription and only tracks the count
    let alertBadgeChannel = null;
    const setupAlertBadgeRealtime = () => {
        if (!State.currentUser || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;
        if (alertBadgeChannel) {
            try { alertBadgeChannel.unsubscribe(); } catch (e) { }
        }
        // Use the raw Supabase client if available
        if (window.supabase && window.supabase.createClient) {
            const rawClient = window._globalSupabaseInstance || window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
            window._globalSupabaseInstance = rawClient;
            alertBadgeChannel = rawClient
                .channel('alert-badge-realtime-' + State.currentUser.id)
                .on('postgres_changes', {
                    event: '*', // INSERT, UPDATE, DELETE
                    schema: 'public',
                    table: 'detections',
                    filter: `user_id=eq.${State.currentUser.id}`
                }, () => {
                    // Any change to detections table → refresh badge immediately
                    syncNotificationsBellBadge();
                })
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'profiles',
                    filter: `id=eq.${State.currentUser.id}`
                }, (payload) => {
                    // Update Premium Ring on plan change
                    if (payload.new && payload.new.subscription_plan) {
                        if (State.userProfile) State.userProfile.subscription_plan = payload.new.subscription_plan;
                        if (window.updateProfileRing) window.updateProfileRing(payload.new.subscription_plan);
                        document.getElementById('sidebar-plan-label').textContent = `${payload.new.subscription_plan} Plan`;
                    }
                })
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'subscriptions',
                    filter: `user_id=eq.${State.currentUser.id}`
                }, (payload) => {
                    // Update Premium Ring when subscription changes directly
                    const newPlan = payload.new.plan_name || payload.new.plan;
                    if (newPlan) {
                        if (State.userProfile) State.userProfile.subscription_plan = newPlan;
                        if (window.updateProfileRing) window.updateProfileRing(newPlan);
                        document.getElementById('sidebar-plan-label').textContent = `${newPlan} Plan`;
                    }
                })
                .subscribe();

            // Ensure we don't leak the client if called multiple times
            if (window.alertBadgeRawClient) {
                try { window.alertBadgeRawClient.removeAllChannels(); } catch (e) { }
            }
            window.alertBadgeRawClient = rawClient;
        }
    };

    let profileRealtimeChannel = null;
    const setupProfileRealtime = () => {
        if (!State.currentUser || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) return;
        if (profileRealtimeChannel) {
            try { profileRealtimeChannel.unsubscribe(); } catch (e) { }
        }
        if (window.supabase && window.supabase.createClient) {
            const rawClient = window._globalSupabaseInstance || window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
            window._globalSupabaseInstance = rawClient;
            profileRealtimeChannel = rawClient
                .channel('profile-realtime-' + State.currentUser.id)
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'profiles',
                    filter: `id=eq.${State.currentUser.id}`
                }, async () => {
                    console.log("[Billing] Profile updated remotely. Refreshing state...");
                    const profileRes = await dbClient.getProfile(State.currentUser.id);
                    if (profileRes.data) {
                        State.userProfile = { ...State.userProfile, ...profileRes.data };
                        
                    }
                })
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'subscriptions',
                    filter: `user_id=eq.${State.currentUser.id}`
                }, async () => {
                    console.log("[Billing] Subscription updated remotely. Refreshing state...");
                    const subRes = await dbClient.getSubscription(State.currentUser.id);
                    if (subRes.data) {
                        State.userProfile.subscription_plan = subRes.data.plan_name || subRes.data.plan || State.userProfile.subscription_plan;
                        State.userProfile.subscription_status = subRes.data.subscription_status || subRes.data.status || State.userProfile.subscription_status;
                        
                    }
                })
                .subscribe();

            if (window.profileRealtimeRawClient) {
                try { window.profileRealtimeRawClient.removeAllChannels(); } catch (e) { }
            }
            window.profileRealtimeRawClient = rawClient;
        }
    };

    const syncNotificationsBellDropdown = async () => {
        const { data } = await dbClient.getDetections(State.currentUser.id);
        bellAlertsList.innerHTML = '';

        if (!data || data.length === 0) {
            bellAlertsList.innerHTML = `<div class="empty-bell-state">No recent detections.</div>`;
            return;
        }

        // Render first 4
        data.slice(0, 4).forEach(alert => {
            const item = document.createElement('div');
            item.className = `bell-alert-item ${alert.status === 'Unread' ? 'unread' : ''}`;

            // Format dynamic date
            const timeStr = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            item.innerHTML = `
                <span class="bell-item-status-dot"></span>
                <div class="bell-item-details">
                    <span class="bell-item-title">${alert.cameras ? alert.cameras.name : 'Unknown Camera'}</span>
                    <span class="bell-item-desc">${alert.reason}</span>
                    <span class="bell-item-time">${timeStr} (${alert.confidence}% confidence)</span>
                </div>
            `;

            item.addEventListener('click', async () => {
                if (alert.status === 'Unread') {
                    await dbClient.updateDetectionStatus(alert.id, State.currentUser.id, { status: 'Read' });
                    await syncNotificationsBellBadge();
                }
                window.location.hash = '#alerts';
            });

            bellAlertsList.appendChild(item);
        });
    };

    // Mark all as read button
    const markAllReadBtn = document.getElementById('mark-all-read');
    markAllReadBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const { data } = await dbClient.getDetections(State.currentUser.id);
        if (data) {
            for (let d of data) {
                if (d.status === 'Unread') {
                    await dbClient.updateDetectionStatus(d.id, State.currentUser.id, { status: 'Read' });
                }
            }
            showToast("Marked all logs as read.", 'success');
            await syncNotificationsBellBadge();
            await syncNotificationsBellDropdown();
        }
    });

    // 8. Tab View: Dashboard Overview
    const loadDashboardStats = async () => {
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const alertsRes = await dbClient.getDetections(State.currentUser.id);

        State.cameraList = camsRes.data || [];
        State.detectionList = alertsRes.data || [];

        // Count active feeds and alerts count
        const camerasCount = State.cameraList.length;
        const totalAlertsCount = State.detectionList.length;

        // Dynamic counts for today
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const eventsTodayCount = State.detectionList.filter(d => new Date(d.timestamp) >= startOfToday).length;

        // Render counts on Dashboard
        document.getElementById('metric-cams-count').textContent = camerasCount;
        document.getElementById('metric-events-count').textContent = eventsTodayCount;
        document.getElementById('metric-alerts-count').textContent = totalAlertsCount;
        const plan = State.userProfile.subscription_plan;
        window.syncCameraUsageUI(camerasCount, plan);

        // Populate Customer Dashboard UI
        const custCamsOnline = document.getElementById('cust-cameras-online');
        if (custCamsOnline) {
            const activeCams = State.cameraList.filter(c => c.status === 'Online').length;
            const plan = State.userProfile.subscription_plan;
            const maxCams = window.getMaxCamerasAllowed(plan);
            custCamsOnline.textContent = `${activeCams}/${maxCams}`;
        }
        const custAlertsToday = document.getElementById('cust-alerts-today');
        if (custAlertsToday) {
            custAlertsToday.textContent = eventsTodayCount;
        }
        const custLastDetection = document.getElementById('cust-last-detection');
        if (custLastDetection) {
            if (State.detectionList.length > 0) {
                custLastDetection.textContent = getRelativeTimeString(new Date(State.detectionList[0].timestamp));
            } else {
                custLastDetection.textContent = 'Never';
            }
        }

        // Setup Free Trial Tracker Banner if applicable
        const freeTrialBanner = document.getElementById('free-trial-banner');
        if (freeTrialBanner) {
            if (State.userProfile && State.userProfile.subscription_plan === 'Free') {
                freeTrialBanner.style.display = 'flex';
                // Fetch usage from backend
                try {
                    fetch(window.API_BASE_URL + `/api/user/usage?userId=${State.currentUser.id}`)
                        .then(r => r.json())
                        .then(data => {
                            const apiCalls = data.apiCallsUsed || 0;
                            const alertsUsed = data.alertsUsed || 0;

                            if (apiCalls >= 80 || alertsUsed >= 10 || (data.liveMinutesUsed || 0) >= 20) {
                                window.isFreeTrialExhausted = true;
                                showToast('Quota reached. It will reset next week.', 'error');
                            } else {
                                window.isFreeTrialExhausted = false;
                            }

                            document.getElementById('trial-days-text').textContent = `${apiCalls} / 80 Calls`;
                            document.getElementById('trial-days-bar').style.width = `${Math.max(0, Math.min(100, (apiCalls / 80) * 100))}%`;
                            const mins = data.liveMinutesUsed || 0;
                            const elText = document.getElementById('trial-minutes-text');
                            if (elText) elText.textContent = `${mins} / 20 Minutes`;
                            const elBar = document.getElementById('trial-minutes-bar');
                            if (elBar) elBar.style.width = `${Math.max(0, Math.min(100, (mins / 20) * 100))}%`;

                            // Real-time Reset Timer (Weekly Reset)
                            if (window._trialResetTimer) clearInterval(window._trialResetTimer);
                            window._trialResetTimer = setInterval(() => {
                                const now = new Date();
                                const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
                                const dayNum = d.getUTCDay() || 7; // Mon=1, Sun=7
                                // Next Monday at 00:00:00 UTC
                                const nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (8 - dayNum)));

                                const diff = nextMonday - now;
                                if (diff <= 0) {
                                    document.getElementById('trial-reset-timer').textContent = "00:00:00";
                                    return;
                                }
                                const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                                const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
                                const minsRemaining = Math.floor((diff / 1000 / 60) % 60);
                                const secs = Math.floor((diff / 1000) % 60);

                                const pad = (n) => n.toString().padStart(2, '0');
                                document.getElementById('trial-reset-timer').textContent =
                                    (days > 0 ? `${days}d ` : '') + `${pad(hours)}:${pad(minsRemaining)}:${pad(secs)}`;
                            }, 1000);
                        })
                        .catch(console.error);
                } catch (err) {
                    console.error('Failed fetching usage API:', err);
                }
            } else {
                freeTrialBanner.style.display = 'none';
            }
        }

        // Load Status Bars List
        const statusList = document.getElementById('dashboard-cameras-status-list');
        statusList.innerHTML = '';

        if (State.cameraList.length === 0) {
            statusList.innerHTML = `<div class="empty-state">No cameras connected. <a href="#cameras" class="auth-link">Add one now</a>.</div>`;
        } else {
            State.cameraList.forEach(cam => {
                const row = document.createElement('div');
                row.className = 'status-bar-row';

                row.innerHTML = `
                    <div class="bar-cam-info">
                        <span class="bar-cam-title">${cam.name}</span>
                        <span class="bar-quality-tag">Quality: ${cam.connection_quality}</span>
                    </div>
                    <span class="bar-status-text ${cam.status === 'Paused' ? 'paused' : ''}">
                        <span class="pulse-dot green"></span> ${cam.status.toUpperCase()}
                    </span>
                `;
                statusList.appendChild(row);
            });
        }

        // Render Recent Detections on Dashboard
        const recentDetectionsList = document.getElementById('dashboard-recent-detections-list');
        recentDetectionsList.innerHTML = '';

        if (State.detectionList.length === 0) {
            recentDetectionsList.innerHTML = `<div class="empty-state">No detections logged yet.</div>`;
        } else {
            State.detectionList.slice(0, 4).forEach(d => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.gap = '12px';
                item.style.padding = '12px';
                item.style.borderRadius = '8px';
                item.style.marginBottom = '8px';
                item.style.background = 'var(--bg-neutral)';
                item.style.border = '1px solid var(--border-light)';
                item.style.transition = 'transform 0.2s, box-shadow 0.2s';
                item.style.cursor = 'pointer';
                item.onmouseover = () => { item.style.transform = 'translateY(-2px)'; item.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; };
                item.onmouseout = () => { item.style.transform = 'translateY(0)'; item.style.boxShadow = 'none'; };

                const relativeTime = getRelativeTimeString(new Date(d.timestamp));
                const confidenceVal = parseFloat(d.confidence || 0).toFixed(1);

                const imgHtml = (d.snapshot_url)
                    ? `<img src="${d.snapshot_url}" style="width: 56px; height: 56px; object-fit: cover; border-radius: 8px; flex-shrink: 0; border: 1px solid var(--border-light);" alt="Snapshot" onerror="this.outerHTML='<div style=\\'width:56px;height:56px;border-radius:8px;flex-shrink:0;background:rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;border:1px solid var(--border-light);\\'><i data-lucide=\\'image-off\\' style=\\'width:24px;height:24px;color:var(--text-secondary);\\'></i></div>'; lucide.createIcons();">`
                    : `<div style="width: 56px; height: 56px; border-radius: 8px; flex-shrink: 0; background: rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-light);"><i data-lucide="scan-eye" style="width: 24px; height: 24px; color: var(--text-secondary);"></i></div>`;

                item.innerHTML = `
                    ${imgHtml}
                    <div style="display: flex; flex-direction: column; justify-content: center; overflow: hidden; width: 100%;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${d.cameras ? d.cameras.name : 'Unknown Camera'}</span>
                            <span style="font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; margin-left: 8px;">${relativeTime}</span>
                        </div>
                        <p style="margin: 0 0 6px 0; font-size: 0.8rem; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4;">${d.reason}</p>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="background: rgba(16,185,129,0.1); color: var(--accent-emerald); padding: 2px 6px; border-radius: 4px; font-size: 0.65rem; font-weight: 600; border: 1px solid rgba(16,185,129,0.2);">Match: ${confidenceVal}%</span>
                        </div>
                    </div>
                `;

                // Allow opening the alert directly from the dashboard
                item.addEventListener('click', () => {
                    if (d.snapshot_url) {
                        showImageModal(d);
                    } else {
                        window.location.hash = '#alerts';
                    }
                });

                recentDetectionsList.appendChild(item);
            });
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        renderAnalytics();
    };

    const renderAnalytics = () => {
        if (!State.detectionList) return;

        // 1. Weekly Detections Distribution Bar Chart
        // Map Mon-Sun. JavaScript getDay(): 0=Sun, 1=Mon, ..., 6=Sat
        const dayCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 0: 0 };
        State.detectionList.forEach(d => {
            const date = new Date(d.timestamp);
            dayCounts[date.getDay()]++;
        });

        const maxCount = Math.max(...Object.values(dayCounts), 1); // Avoid division by zero

        // Order: Mon(1), Tue(2), Wed(3), Thu(4), Fri(5), Sat(6), Sun(0)
        const orderedDays = [1, 2, 3, 4, 5, 6, 0];

        const barCols = document.querySelectorAll('.bar-chart-mock .bar-col .bar-val');
        if (barCols.length === 7) {
            orderedDays.forEach((day, index) => {
                const count = dayCounts[day];
                // Ensure at least 5% height so the bar is visible even with 0
                const percent = Math.max(5, (count / maxCount) * 100);
                barCols[index].style.height = `${percent}%`;
                // Add a tooltip for hovering
                barCols[index].title = `${count} detections`;
            });
        }

        // 2. AI Processing Velocity Line Chart
        // We'll bucket the last 7 days of detections (including today)
        const now = new Date();
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            d.setHours(0, 0, 0, 0);
            days.push({ start: d.getTime(), count: 0 });
        }

        State.detectionList.forEach(d => {
            const t = new Date(d.timestamp).getTime();
            // Find which day bucket it falls into
            for (let i = 0; i < days.length; i++) {
                const nextStart = (i === days.length - 1) ? Infinity : days[i + 1].start;
                if (t >= days[i].start && t < nextStart) {
                    days[i].count++;
                    break;
                }
            }
        });

        // Map these 7 data points to SVG coordinates (Width: 500, Height: 150)
        // Let's use X from 20 to 480, Y from 130 to 20
        const maxVelocity = Math.max(...days.map(d => d.count), 1);
        const svgPoints = days.map((day, i) => {
            const x = 20 + (i * (460 / 6)); // 6 intervals between 7 points
            const y = 130 - ((day.count / maxVelocity) * 110);
            return { x, y };
        });

        // Build the SVG path string using Bezier Curves for smooth rendering
        let pathD = `M ${svgPoints[0].x} ${svgPoints[0].y}`;
        for (let i = 1; i < svgPoints.length; i++) {
            const prev = svgPoints[i - 1];
            const curr = svgPoints[i];
            const cpX = (prev.x + curr.x) / 2;
            pathD += ` C ${cpX} ${prev.y}, ${cpX} ${curr.y}, ${curr.x} ${curr.y}`;
        }

        // Apply to the SVG element
        const svgContainer = document.querySelector('.interactive-chart-svg');
        if (svgContainer) {
            // First path is the gradient fill
            const fillPath = svgContainer.querySelector('path[fill^="url"]');
            // Second path is the stroke line
            const strokePath = svgContainer.querySelector('path[fill="none"]');

            if (fillPath && strokePath) {
                strokePath.setAttribute('d', pathD);
                // Fill path is the line + down to bottom corners to close the shape
                fillPath.setAttribute('d', `${pathD} L ${svgPoints[svgPoints.length - 1].x} 150 L ${svgPoints[0].x} 150 Z`);
            }
        }
    };

    // metricsPoller removed since it is in state.js

    const loadSystemMetrics = async () => {
        const refreshBtn = document.getElementById('metrics-refresh-btn');
        if (refreshBtn) refreshBtn.classList.add('spinning');

        try {
            const res = await fetch(window.API_BASE_URL + '/api/metrics');
            if (!res.ok) throw new Error("Metrics response not OK");
            const data = await res.json();

            // Populate fields
            document.getElementById('metric-yolo-queue').textContent = `${data.yoloQueueLength} Active Task(s)`;
            document.getElementById('metric-yolo-bar').style.width = `${Math.min(100, data.yoloQueueLength * 20)}%`;

            document.getElementById('metric-gemini-queue').textContent = `${data.geminiQueueLength} Pending Request(s)`;
            document.getElementById('metric-gemini-bar').style.width = `${Math.min(100, data.geminiQueueLength * 25)}%`;

            // Optimization percentage calculations
            const totalYoloProcessed = data.yoloSavingsCount + data.geminiRequests;
            const yoloSavingsPercent = totalYoloProcessed > 0
                ? ((data.yoloSavingsCount / totalYoloProcessed) * 100).toFixed(1) + "%"
                : "0.0%";
            document.getElementById('metric-yolo-savings').textContent = yoloSavingsPercent;

            const totalSceneProcessed = data.sceneSavingsCount + totalYoloProcessed;
            const sceneSavingsPercent = totalSceneProcessed > 0
                ? ((data.sceneSavingsCount / totalSceneProcessed) * 100).toFixed(1) + "%"
                : "0.0%";
            document.getElementById('metric-scene-savings').textContent = sceneSavingsPercent;

            document.getElementById('metric-avg-latency').textContent = `${data.avgProcessingTime} ms`;

            const totalGemini = data.geminiSuccess + data.geminiFailures;
            const successRate = totalGemini > 0
                ? ((data.geminiSuccess / totalGemini) * 100).toFixed(1) + "%"
                : "100.0%";
            document.getElementById('metric-success-rate').textContent = successRate;

            document.getElementById('metric-worker-health').textContent = data.workerHealth.toUpperCase();

            // Format uptime dynamically
            const hrs = Math.floor(data.uptimeSeconds / 3600);
            const mins = Math.floor((data.uptimeSeconds % 3600) / 60);
            const secs = data.uptimeSeconds % 60;
            const uptimeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m ${secs}s`;
            document.getElementById('metric-uptime').textContent = uptimeStr;

        } catch (e) {
            console.warn("Failed to load real-time metrics. Local simulator values loaded.");
            // Simulation Fallback values
            document.getElementById('metric-yolo-queue').textContent = "0 Active Task(s)";
            document.getElementById('metric-yolo-bar').style.width = "0%";
            document.getElementById('metric-gemini-queue').textContent = "0 Pending Request(s)";
            document.getElementById('metric-gemini-bar').style.width = "0%";
            document.getElementById('metric-yolo-savings').textContent = "84.2%";
            document.getElementById('metric-scene-savings').textContent = "76.8%";
            document.getElementById('metric-avg-latency').textContent = "1240 ms";
            document.getElementById('metric-success-rate').textContent = "100.0%";
            document.getElementById('metric-worker-health').textContent = "EXCELLENT";
            document.getElementById('metric-uptime').textContent = "Running (Offline)";
        } finally {
            if (refreshBtn) {
                setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
            }
        }
    };

    // Metrics refresh action listener
    document.addEventListener('click', (e) => {
        if (e.target.closest('#metrics-refresh-btn')) {
            loadSystemMetrics();
        }
    });

    // Start polling loop when Metrics page tab is loaded
    const startMetricsPolling = () => {
        if (State.metricsPoller) clearInterval(State.metricsPoller);
        State.metricsPoller = setInterval(async () => {
            if (document.hidden) return;
            const activeHash = window.location.hash || '#dashboard';
            if (activeHash === '#metrics') {
                await loadSystemMetrics();
            } else {
                clearInterval(State.metricsPoller);
                State.metricsPoller = null;
            }
        }, 3000);
    };

    const dashboardRefreshBtn = document.getElementById('dashboard-refresh-btn');
    if (dashboardRefreshBtn) {
        dashboardRefreshBtn.addEventListener('click', async () => {
            dashboardRefreshBtn.classList.add('spinning');
            await loadDashboardStats();
            setTimeout(() => dashboardRefreshBtn.classList.remove('spinning'), 600);
            showToast("Dashboard stats reloaded.", 'success');
        });
    }

    // 9. Tab View: Cameras Manageme    // 9. Tab View: Cameras Management (CRUD) & Sync Engine Configuration
    const _lastSyncTime = {}; // camId -> { time, promptText }
    const syncCameraWithEngine = async (cam) => {
        // Debounce: skip if synced in the last 30s with the SAME prompt.
        // This prevents grid re-renders and modal opens from spamming engine restarts.
        const now = Date.now();
        const lastSync = _lastSyncTime[cam.id];
        const currentPrompt = cam.activePromptText || '';
        if (lastSync && (now - lastSync.time < 5000) && lastSync.promptText === currentPrompt) {
            return; // Same prompt, synced recently — skip
        }
        _lastSyncTime[cam.id] = { time: now, promptText: currentPrompt };

        // Rate Limiting Manager check for manual syncs
        const allowed = await apiRateLimiter.checkRateLimit(cam);
        if (!allowed) return;

        try {
            const promptsRes = await dbClient.getPromptsForCamera(cam.id, State.currentUser.id);
            const prompt = promptsRes.data && promptsRes.data.length > 0 ? promptsRes.data[0] : null;

            await fetch(`${window.API_BASE_URL}/api/camera/${cam.id}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ camId: cam.id })
            });
        } catch (e) {
            console.warn("Failed to sync camera with engine:", e);
        }
    };

    const renderCamerasGrid = async () => {
        const grid = document.getElementById('cameras-grid-list');
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        State.cameraList = camsRes.data || [];

        // Subscribe to all cameras over WebSocket to receive active boxes
        if (State.wsConnected && State.engineWebSocket && State.engineWebSocket.readyState === WebSocket.OPEN) {
            State.cameraList.forEach(cam => {
                State.engineWebSocket.send(JSON.stringify({ action: 'subscribe', cameraId: cam.id }));
            });
        }

        // Clean up dead HLS streams for offline cameras so they automatically reconnect when they come back online
        State.cameraList.forEach(cam => {
            if (cam.status === 'Offline' && State.activeHlsStreams[cam.id]) {
                console.log(`[HLS] Cleaning up dead stream for offline camera: ${cam.name}`);
                const h = State.activeHlsStreams[cam.id];
                if (h.hls) { try { h.hls.destroy(); } catch (e) { } }
                if (h.videoEl) h.videoEl.remove();
                if (h.streamId) {
                    fetch(window.API_BASE_URL + '/api/hls/stop', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ streamId: h.streamId })
                    }).catch(() => { });
                }
                delete State.activeHlsStreams[cam.id];
            }
        });

        // Update sidebar cameras badge
        const sidebarCamsBadge = document.getElementById('sidebar-cams-badge');
        if (sidebarCamsBadge) {
            sidebarCamsBadge.textContent = State.cameraList.length;
            if (State.cameraList.length > 0) {
                sidebarCamsBadge.classList.add('visible');
            } else {
                sidebarCamsBadge.classList.remove('visible');
            }
        }

        // Update global topbar and billing camera usage in realtime
        window.syncCameraUsageUI(State.cameraList.length, State.userProfile?.subscription_plan);

        // Smart diff-render: only add/remove cards; preserve existing live streams
        const existingCardIds = new Set(
            [...grid.querySelectorAll('.camera-card')].map(c => c.dataset.camId).filter(Boolean)
        );
        const newCamIds = new Set(State.cameraList.map(c => c.id));

        // Remove cards for cameras that no longer exist
        for (const cardId of existingCardIds) {
            if (!newCamIds.has(cardId)) {
                const oldCard = grid.querySelector(`[data-cam-id="${cardId}"]`);
                if (oldCard) oldCard.remove();
            }
        }

        if (State.cameraList.length === 0) {
            grid.innerHTML = `<div class="empty-state">No cameras connected. Click "Connect Camera" above to get started.</div>`;
            return;
        }

        // Clear any leftover empty-state message before rendering cards
        const emptyState = grid.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        State.cameraList.forEach(cam => {
            // If this camera card already exists in the DOM, check if status changed
            const existingCard = grid.querySelector(`[data-cam-id="${cam.id}"]`);
            if (existingCard) {
                const oldStatus = existingCard.dataset.camStatus;
                if (oldStatus && oldStatus !== cam.status) {
                    // Status changed (e.g. to Trial Expired). Tear down old card so it rebuilds cleanly
                    existingCard.remove();
                    
                    if (State.activeCanvasLoops[cam.id]) {
                        cancelAnimationFrame(State.activeCanvasLoops[cam.id]);
                        delete State.activeCanvasLoops[cam.id];
                    }
                    if (State.activeWebcamStreams[cam.id]) {
                        const tracks = State.activeWebcamStreams[cam.id].srcObject?.getTracks() || [];
                        tracks.forEach(t => t.stop());
                        delete State.activeWebcamStreams[cam.id];
                    }
                    if (State.activeBrowserDetectors[cam.id]) {
                        clearInterval(State.activeBrowserDetectors[cam.id]);
                        delete State.activeBrowserDetectors[cam.id];
                    }
                    if (State.activeHlsStreams[cam.id]) {
                        State.activeHlsStreams[cam.id].destroy();
                        delete State.activeHlsStreams[cam.id];
                    }
                } else {
                    // Just update the prompt snippet if it changed
                    dbClient.getPromptsForCamera(cam.id, State.currentUser.id).then(res => {
                        const snippetEl = document.getElementById(`snippet-${cam.id}`);
                        if (snippetEl) {
                            snippetEl.textContent = res.data && res.data.length > 0 ? `"${res.data[0].prompt_text}"` : 'No prompt set.';
                        }
                    });
                    return; // Skip - stream is already running
                }
            }

            const card = document.createElement('div');
            let extraClass = '';
            if (cam.status === 'Paused') extraClass = 'paused';
            if (cam.status === 'Offline') extraClass = 'offline';
            card.className = `camera-card ${extraClass}`;
            card.dataset.camId = cam.id; // Tag card so we can find it later
            card.dataset.camStatus = cam.status;


            card.innerHTML = `
                <div class="camera-card-preview">
                    <!-- Black background while stream loads -->
                    <div id="canvas-bg-${cam.id}" style="position:absolute;inset:0;background:#000;z-index:0;"></div>
                    <!-- HLS loading overlay — shown until first frame arrives -->
                    <div id="canvas-loading-${cam.id}" style="position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;pointer-events:none;">
                        <div class="skeleton-loader pulsating"></div>
                        <svg style="width:28px;height:28px;animation:card-spin 1s linear infinite;opacity:0.5;position:relative;z-index:11;" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                        <span style="color:rgba(96,165,250,0.6);font-size:0.65rem;font-family:monospace;letter-spacing:.05em;position:relative;z-index:11;">CONNECTING...</span>
                    </div>
                    <canvas class="camera-stream-canvas" id="canvas-${cam.id}" width="320" height="180" style="position:relative;z-index:1;width:100%;height:100%;object-fit:cover;display:block;filter:brightness(0.95) contrast(1.05);background:#000;"></canvas>
                    <style>@keyframes card-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}</style>
                    <div class="camera-scan-line" style="position: absolute; top: 0; left: 0; width: 100%; height: 2px; background: linear-gradient(90deg, rgba(37,99,235,0) 0%, rgba(37,99,235,1) 50%, rgba(37,99,235,0) 100%); opacity: 0.7; pointer-events: none; z-index:3;"></div>
                    <div class="camera-card-badge" style="z-index:4;">${cam.location}</div>
                    <div class="camera-card-status" style="z-index:4;">
                        <span class="pulse-dot ${cam.status === 'Online' ? 'green' : (cam.status === 'Offline' || cam.status === 'Trial Expired' || (cam.status === 'Paused' && window.isFreeTrialExhausted) ? 'red' : '')}" style="${cam.status === 'Paused' && !window.isFreeTrialExhausted ? 'background:#f59e0b; box-shadow:none; animation:none;' : ''}"></span> ${(cam.status === 'Paused' && window.isFreeTrialExhausted) ? 'TRIAL EXPIRED' : cam.status.toUpperCase()}
                    </div>
                    <div id="health-badge-${cam.id}" style="z-index:4; position:absolute; top: 42px; right: 12px; background: rgba(9,9,11,0.7); padding: 4px 8px; border-radius: 4px; font-size: 0.65rem; font-family: monospace; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 6px; border: 1px solid rgba(255,255,255,0.1); cursor: help;" title="API Health">
                        <span class="health-dot" style="width:6px;height:6px;border-radius:50%;background:#9ca3af;box-shadow:0 0 4px #9ca3af;"></span> <span class="health-text">API: LOAD</span>
                    </div>
                    ${cam.status === 'Offline' ? '<div class="offline-overlay" style="z-index:5;">NO SIGNAL</div>' : ''}
                    ${cam.status === 'Trial Expired' || (cam.status === 'Paused' && window.isFreeTrialExhausted) ? '<div class="offline-overlay" style="z-index:5; background:rgba(220,38,38,0.2); backdrop-filter:blur(4px);"><div style="color:#ef4444; font-weight:bold; font-size:1.2rem; margin-bottom:8px;">QUOTA REACHED</div><div style="font-size:0.8rem; color:#fca5a5; font-weight: 500;">Upgrade to Pro to resume</div></div>' : ''}
                    <div style="position: absolute; bottom: 8px; right: 12px; font-family: monospace; font-size: 0.6rem; color: rgba(255,255,255,0.7); background: rgba(9,9,11,0.6); padding: 2px 6px; border-radius: 3px; z-index:4;">
                        1080P | 30 FPS
                    </div>
                </div>
                <div class="camera-card-body">
                    <h3 class="camera-card-title">${cam.name}</h3>
                    <div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 6px; font-weight: 500;">Active AI Prompt</div>
                        <div class="camera-card-prompt" id="snippet-${cam.id}" style="color:var(--accent-blue);">Loading prompt...</div>
                    </div>
                </div>
                <div class="camera-card-footer">
                    <button class="btn btn-secondary action-pause" style="padding: 6px 12px; font-size:0.8rem;" title="${cam.status === 'Paused' ? 'Resume' : 'Pause'} Monitoring">
                        <i data-lucide="${cam.status === 'Paused' ? 'play' : 'pause'}" style="width:14px; height:14px;"></i> ${cam.status === 'Paused' ? 'Resume' : 'Pause'}
                    </button>
                    <div style="display:flex; gap:8px;">
                        <button class="icon-btn action-edit" title="Edit Configurations">
                            <i data-lucide="edit-3"></i>
                        </button>
                        <button class="icon-btn text-red action-delete" title="Disconnect Feed">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (!e.target.closest('.camera-card-footer')) {
                    openCameraDetailsModal(cam);
                }
            });

            const pauseBtn = card.querySelector('.action-pause');
            pauseBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (window.isFreeTrialExhausted && cam.status === 'Paused') {
                    showToast('Quota reached. Please upgrade to continue using.', 'error');
                    return;
                }
                const newStatus = cam.status === 'Paused' ? 'Online' : 'Paused';
                await dbClient.updateCamera(cam.id, State.currentUser.id, { status: newStatus });

                try {
                    await fetch(`${window.API_BASE_URL}/api/camera/${cam.id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camId: cam.id }) });
                } catch (err) { }

                showToast(`Camera feed ${newStatus === 'Paused' ? 'paused' : 'resumed'}.`, 'success');
                await renderCamerasGrid();
            });

            const editBtn = card.querySelector('.action-edit');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openAddCameraModal(cam);
            });

            const deleteBtn = card.querySelector('.action-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openConfirmDialog("Disconnect Camera", `Are you sure you want to completely remove "${cam.name}"? This will also delete all its alert history.`, async () => {
                    // 1. Delete all alerts/detections for this camera first
                    await dbClient.deleteDetectionsForCamera(cam.id, State.currentUser.id);

                    // 2. Delete the camera itself
                    // Cleanup active streams and intervals
                    if (State.activeBrowserDetectors[cam.id]) {
                        clearInterval(State.activeBrowserDetectors[cam.id]);
                        delete State.activeBrowserDetectors[cam.id];
                    }
                    if (State.activeWebcamStreams[cam.id]) {
                        const tracks = State.activeWebcamStreams[cam.id].srcObject?.getTracks() || [];
                        tracks.forEach(t => t.stop());
                        delete State.activeWebcamStreams[cam.id];
                    }
                    if (State.activeCanvasLoops[cam.id]) {
                        cancelAnimationFrame(State.activeCanvasLoops[cam.id]);
                        delete State.activeCanvasLoops[cam.id];
                    }

                    await dbClient.deleteCamera(cam.id, State.currentUser.id);

                    try {
                        await fetch(`${window.API_BASE_URL}/api/engine/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camId: cam.id }) });
                    } catch (err) { }

                    // 3. Refresh badge & grid
                    await syncNotificationsBellBadge();
                    showToast(`"${cam.name}" and all its alerts have been removed.`, 'success');
                    await renderCamerasGrid();
                });
            });

            grid.appendChild(card);

            dbClient.getPromptsForCamera(cam.id, State.currentUser.id).then(res => {
                const promptSnippet = document.getElementById(`snippet-${cam.id}`);
                if (promptSnippet) {
                    promptSnippet.textContent = res.data && res.data.length > 0 ? `"${res.data[0].prompt_text}"` : 'No prompt set.';
                }
            });
        });

        // Start live canvas preview loops for each camera card after fetching prompt settings and syncing with engine
        State.cameraList.forEach(cam => {
            // Skip cameras whose cards already existed (streams are live)
            if (grid.querySelector(`[data-cam-id="${cam.id}"]`) &&
                (State.activeCanvasLoops[cam.id] || State.activeHlsStreams[cam.id] || State.activeWebcamStreams[cam.id])) {
                return;
            }
            const canvas = document.getElementById(`canvas-${cam.id}`);
            if (canvas) {
                dbClient.getPromptsForCamera(cam.id, State.currentUser.id).then(res => {
                    const prompt = res.data && res.data.length > 0 ? res.data[0] : null;
                    cam.activePromptText = prompt ? prompt.prompt_text : '';
                    cam.activePromptMetadata = prompt ? prompt.extracted_metadata : null;

                    // Sync with engine in the background
                    syncCameraWithEngine(cam);

                    initCameraCanvasPreview(canvas, cam);
                });
            }
        });

        if (camerasGridList.classList.contains('command-center-mode')) {
            updateGridSizeClass();
        }

        if (typeof lucide !== 'undefined') lucide.createIcons();
    };



    // toggleCameraSourceInputs replaced by new wizard UI logic

    let modalWebcamStream = null;

    async function startWebcamPreview(deviceId = 'local') {
        const video = document.getElementById('modal-webcam-preview');
        const placeholder = document.getElementById('modal-network-preview');
        if (!video || !placeholder) return;
        video.style.display = 'block';
        placeholder.style.display = 'none';

        try {
            if (modalWebcamStream) {
                modalWebcamStream.getTracks().forEach(t => t.stop());
            }
            const constraints = {
                video: deviceId === 'local' ? true : { deviceId: { exact: deviceId } }
            };
            modalWebcamStream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = modalWebcamStream;
        } catch (e) {
            console.error("Failed to start modal preview:", e);
        }
    }

    function stopWebcamPreview() {
        const video = document.getElementById('modal-webcam-preview');
        const img = document.getElementById('modal-network-snapshot');
        const placeholder = document.getElementById('modal-network-preview');
        if (video) {
            video.style.display = 'none';
            video.srcObject = null;
        }
        if (img) {
            img.style.display = 'none';
            img.src = '';
        }
        if (placeholder) {
            placeholder.style.display = 'block';
            const text = document.getElementById('network-preview-text');
            const icon = document.getElementById('network-preview-icon');
            if (text) text.innerHTML = `Network Stream Selected<br><span style="font-size:0.75rem;">Test connection to verify</span>`;
            if (icon) {
                icon.setAttribute('data-lucide', 'wifi');
                icon.style.color = 'var(--text-secondary)';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }

        if (modalWebcamStream) {
            modalWebcamStream.getTracks().forEach(t => t.stop());
            modalWebcamStream = null;
        }
    }

    const openAddCameraModal = async (camera = null) => {
        if (!camera && window.isFreeTrialExhausted) {
            showToast('Quota reached. Please upgrade to add more cameras.', 'error');
            return;
        }
        const modal = document.getElementById('camera-modal');
        const title = document.getElementById('camera-modal-title');

        // Clear forms
        document.getElementById('cam-form-name').value = '';
        document.getElementById('cam-form-location').value = '';
        const promptInputEl = document.getElementById('cam-form-prompt');
        if (promptInputEl) {
            promptInputEl.value = '';
            // Trigger input event to update the character counter and max length limits immediately
            promptInputEl.dispatchEvent(new Event('input'));
        }
        document.getElementById('camera-form-id').value = '';
        State.activeCameraIdForEdit = null;

        // Populate Webcam Devices
        const sourceSelect = document.getElementById('cam-form-source');
        if (sourceSelect) {
            sourceSelect.innerHTML = '<option value="webcam://local">Default Webcam</option>';
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                if (videoDevices.length > 0) {
                    sourceSelect.innerHTML = '';
                    videoDevices.forEach(d => {
                        const opt = document.createElement('option');
                        opt.value = `webcam://${d.deviceId}`;
                        opt.textContent = d.label || `Camera ${sourceSelect.options.length + 1}`;
                        sourceSelect.appendChild(opt);
                    });
                }
            } catch (e) {
                console.warn('Could not enumerate video devices', e);
            }
        }

        if (camera) {
            title.textContent = `Edit Camera: ${camera.name}`;
            document.getElementById('camera-form-id').value = camera.id;
            State.activeCameraIdForEdit = camera.id;
            document.getElementById('cam-form-name').value = camera.name || '';
            document.getElementById('cam-form-location').value = camera.location || '';

            // Fetch the active prompt for this camera if not already attached
            let activePrompt = camera.activePromptText || '';
            if (!activePrompt) {
                const promptsRes = await dbClient.getPromptsForCamera(camera.id, State.currentUser.id);
                if (promptsRes.data && promptsRes.data.length > 0) {
                    activePrompt = promptsRes.data[0].prompt_text;
                }
            }
            document.getElementById('cam-form-prompt').value = activePrompt;
            document.getElementById('cam-form-prompt').dispatchEvent(new Event('input'));
            const isWebcam = !camera.rtsp_url || camera.rtsp_url.startsWith('webcam://');

            // Switch Tab
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

            if (isWebcam) {
                document.getElementById('cam-active-tab').value = 'tab-webcam';
                document.querySelector('[data-target="tab-webcam"]').classList.add('active');
                document.getElementById('tab-webcam').style.display = 'block';
                if (sourceSelect && camera.rtsp_url) {
                    sourceSelect.value = camera.rtsp_url;
                    startWebcamPreview(camera.rtsp_url.replace('webcam://', ''));
                } else {
                    startWebcamPreview('local');
                }
            } else {
                document.getElementById('cam-active-tab').value = 'tab-rtsp';
                document.querySelector('[data-target="tab-rtsp"]').classList.add('active');
                document.getElementById('tab-rtsp').style.display = 'block';
                document.getElementById('cam-form-rtsp').value = camera.rtsp_url;
                stopWebcamPreview();
            }
        } else {
            title.textContent = "Add Camera";
            document.getElementById('camera-form-id').value = '';

            // Reset to webcam tab
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
            document.getElementById('cam-active-tab').value = 'tab-webcam';
            const webTabBtn = document.querySelector('[data-target="tab-webcam"]');
            if (webTabBtn) webTabBtn.classList.add('active');
            const webTabContent = document.getElementById('tab-webcam');
            if (webTabContent) webTabContent.style.display = 'block';

            startWebcamPreview('local');

            const rtspInput = document.getElementById('cam-form-rtsp');
            if (rtspInput) rtspInput.value = '';
            const onvifIp = document.getElementById('cam-form-onvif-ip');
            if (onvifIp) onvifIp.value = '';
            const onvifUser = document.getElementById('cam-form-onvif-user');
            if (onvifUser) onvifUser.value = '';
            const onvifPass = document.getElementById('cam-form-onvif-pass');
            if (onvifPass) onvifPass.value = '';
        }

        modal.classList.add('active');
    };

    const closeAddCameraModal = () => {
        document.getElementById('camera-modal').classList.remove('active');
        stopWebcamPreview();
    };


    document.getElementById('open-add-camera-btn').addEventListener('click', () => openAddCameraModal());

    // Global listener for webcam select change
    document.getElementById('cam-form-source')?.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val.startsWith('webcam://')) {
            startWebcamPreview(val.replace('webcam://', ''));
        }
    });

    // Camera Tab Switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

            e.target.classList.add('active');
            const targetId = e.target.getAttribute('data-target');
            document.getElementById(targetId).style.display = 'block';
            document.getElementById('cam-active-tab').value = targetId;

            if (targetId === 'tab-webcam') {
                const source = document.getElementById('cam-form-source').value;
                startWebcamPreview(source.replace('webcam://', ''));
            } else {
                stopWebcamPreview();
            }
        });
    });

    // Test Connections
    async function fetchAndDisplaySnapshot(rtspUrl) {
        const placeholder = document.getElementById('modal-network-preview');
        const img = document.getElementById('modal-network-snapshot');
        const text = document.getElementById('network-preview-text');
        if (!img || !placeholder) return;

        try {
            if (text) text.innerHTML = `<i data-lucide="loader-2" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"></i> Fetching Snapshot...`;
            if (typeof lucide !== 'undefined') lucide.createIcons();

            const r = await fetch(window.API_BASE_URL + '/api/cameras/preview-frame', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rtspUrl })
            });
            const data = await r.json();
            if (data.success && data.frame) {
                img.src = data.frame;
                img.style.display = 'block';
                placeholder.style.display = 'none';
            } else {
                if (text) text.innerHTML = `<span style="color:var(--status-error);">Snapshot Failed</span><br><span style="font-size:0.75rem;">${data.error || 'Unknown error'}</span>`;
            }
        } catch (e) {
            console.error("Snapshot error:", e);
            if (text) text.innerHTML = `<span style="color:var(--status-error);">Snapshot Failed</span><br><span style="font-size:0.75rem;">Network Error</span>`;
        }
    }

    document.getElementById('test-rtsp-btn')?.addEventListener('click', async () => {
        let url = document.getElementById('cam-form-rtsp').value.trim();
        const resDiv = document.getElementById('rtsp-test-result');
        const text = document.getElementById('network-preview-text');
        const icon = document.getElementById('network-preview-icon');

        if (!url) return;

        // Auto-prepend rtsp:// if missing
        if (!url.toLowerCase().startsWith('rtsp://') && !url.toLowerCase().startsWith('http')) {
            url = 'rtsp://' + url;
            document.getElementById('cam-form-rtsp').value = url;
        }

        resDiv.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"></i> Testing...';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        try {
            const r = await fetch(window.API_BASE_URL + '/api/rtsp/validate-deep', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rtspUrl: url })
            });
            const data = await r.json();

            if (data.success) {
                const streamInfo = `${data.codec || 'Unknown'} - ${data.resolution || 'Unknown'} @ ${data.fps || 0}fps`;
                resDiv.innerHTML = `<span style="color:var(--status-success);">Success: ${streamInfo}</span>`;
                if (text) text.innerHTML = `<span style="color:var(--status-success);">Connection Verified</span><br><span style="font-size:0.75rem;">Ready to save</span>`;
                if (icon) { icon.setAttribute('data-lucide', 'check-circle'); icon.style.color = 'var(--status-success)'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
                fetchAndDisplaySnapshot(url);
            } else {
                resDiv.innerHTML = `<span style="color:var(--status-error);">Failed: ${data.error || 'Connection refused'}</span>`;
                if (text) text.innerHTML = `<span style="color:var(--status-error);">Connection Failed</span><br><span style="font-size:0.75rem;">Check URL or network</span>`;
                if (icon) { icon.setAttribute('data-lucide', 'x-circle'); icon.style.color = 'var(--status-error)'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
            }
        } catch (e) {
            console.error("Test connection error:", e);
            resDiv.innerHTML = `<span style="color:var(--status-error);">Invalid URL format or Network Error. Include rtsp://</span>`;
        }
    });

    document.getElementById('test-onvif-btn')?.addEventListener('click', () => {
        const ip = document.getElementById('cam-form-onvif-ip').value;
        const user = document.getElementById('cam-form-onvif-user').value;
        const pass = document.getElementById('cam-form-onvif-pass').value;
        const resDiv = document.getElementById('onvif-test-result');
        const text = document.getElementById('network-preview-text');
        const icon = document.getElementById('network-preview-icon');
        if (!ip) return;
        const generated = `rtsp://${user ? user + ':' : ''}${pass ? pass + '@' : ''}${ip}:554/stream1`;

        resDiv.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"></i> Testing...';
        if (typeof lucide !== 'undefined') lucide.createIcons();

        (async () => {
            try {
                const r = await fetch(window.API_BASE_URL + '/api/rtsp/validate-deep', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rtspUrl: generated })
                });
                const data = await r.json();

                if (data.success) {
                    const streamInfo = `${data.codec || 'Unknown'} - ${data.resolution || 'Unknown'} @ ${data.fps || 0}fps`;
                    resDiv.innerHTML = `<span style="color:var(--status-success);">Success: ${streamInfo}</span>`;
                    if (text) text.innerHTML = `<span style="color:var(--status-success);">Connection Verified</span><br><span style="font-size:0.75rem;">Ready to save</span>`;
                    if (icon) { icon.setAttribute('data-lucide', 'check-circle'); icon.style.color = 'var(--status-success)'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
                    fetchAndDisplaySnapshot(generated);
                } else {
                    resDiv.innerHTML = `<span style="color:var(--status-error);">Failed: ${data.error || 'Connection refused'}</span>`;
                    if (text) text.innerHTML = `<span style="color:var(--status-error);">Connection Failed</span><br><span style="font-size:0.75rem;">Check IP or credentials</span>`;
                    if (icon) { icon.setAttribute('data-lucide', 'x-circle'); icon.style.color = 'var(--status-error)'; if (typeof lucide !== 'undefined') lucide.createIcons(); }
                }
            } catch (e) {
                console.error("ONVIF test error:", e);
                resDiv.innerHTML = `<span style="color:var(--status-error);">Network Error</span>`;
            }
        })();
    });

    // --- Command Center View Toggles ---
    const btnViewCards = document.getElementById('toggle-view-cards');
    const btnViewGrid = document.getElementById('toggle-view-grid');
    const camerasGridList = document.getElementById('cameras-grid-list');

    const updateGridSizeClass = () => {
        camerasGridList.classList.remove('grid-1', 'grid-2', 'grid-4', 'grid-5', 'grid-6', 'grid-9');
        const count = State.cameraList.length;
        if (count <= 1) camerasGridList.classList.add('grid-1');
        else if (count === 2) camerasGridList.classList.add('grid-2');
        else if (count <= 4) camerasGridList.classList.add('grid-4');
        else if (count === 5) camerasGridList.classList.add('grid-5');
        else if (count === 6) camerasGridList.classList.add('grid-6');
        else camerasGridList.classList.add('grid-9');
    };

    btnViewGrid?.addEventListener('click', () => {
        btnViewGrid.classList.add('active');
        btnViewGrid.style.background = 'var(--accent-blue)';
        btnViewGrid.style.color = 'white';

        btnViewCards.classList.remove('active');
        btnViewCards.style.background = 'transparent';
        btnViewCards.style.color = 'var(--text-secondary)';

        camerasGridList.classList.add('command-center-mode');
        updateGridSizeClass();
    });

    btnViewCards?.addEventListener('click', () => {
        btnViewCards.classList.add('active');
        btnViewCards.style.background = 'var(--accent-blue)';
        btnViewCards.style.color = 'white';

        btnViewGrid.classList.remove('active');
        btnViewGrid.style.background = 'transparent';
        btnViewGrid.style.color = 'var(--text-secondary)';

        camerasGridList.classList.remove('command-center-mode', 'grid-1', 'grid-2', 'grid-4', 'grid-5', 'grid-6', 'grid-9');
    });
    document.getElementById('camera-modal-close').addEventListener('click', closeAddCameraModal);
    document.getElementById('wizard-btn-cancel').addEventListener('click', closeAddCameraModal);


    const promptInput = document.getElementById('cam-form-prompt');
    const charCountEl = document.getElementById('cam-prompt-char-count');

    // Setup character limit enforcement
    if (promptInput && charCountEl) {
        promptInput.addEventListener('input', () => {
            const maxChars = 500;
            promptInput.maxLength = maxChars;

            // Truncate if they pasted something too long
            if (promptInput.value.length > maxChars) {
                promptInput.value = promptInput.value.substring(0, maxChars);
            }

            charCountEl.textContent = `${promptInput.value.length} / ${maxChars}`;

            if (promptInput.value.length >= maxChars) {
                charCountEl.style.color = '#ef4444'; // Red if maxed
            } else {
                charCountEl.style.color = 'var(--text-secondary)';
            }
        });
    }

    const enhancePromptBtn = document.getElementById('enhance-prompt-btn');
    if (enhancePromptBtn) {
        enhancePromptBtn.addEventListener('click', async () => {
            const originalPrompt = promptInput.value.trim();
            if (!originalPrompt) {
                showToast("Please enter a rough prompt first.", "error");
                return;
            }

            const originalText = enhancePromptBtn.innerHTML;
            enhancePromptBtn.innerHTML = '<i data-lucide="loader-2" class="spinning" style="width:14px; height:14px;"></i> Enhancing...';
            enhancePromptBtn.disabled = true;
            const maxChars = 500;

            try {
                const res = await fetch(window.API_BASE_URL + '/api/prompt/enhance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ promptText: originalPrompt, maxLength: maxChars })
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data.enhancedPrompt) {
                        promptInput.value = data.enhancedPrompt;
                        promptInput.dispatchEvent(new Event('input')); // trigger char counter update
                        showToast("Prompt enhanced successfully!", "success");
                    }
                } else {
                    const err = await res.json();
                    showToast("Failed to enhance prompt: " + (err.error || 'Unknown Error'), "error");
                }
            } catch (e) {
                showToast("Network error enhancing prompt.", "error");
            } finally {
                enhancePromptBtn.innerHTML = originalText;
                enhancePromptBtn.disabled = false;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });
    }

    // Form submit save action
    const cameraForm = document.getElementById('camera-wizard-form');
    cameraForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const saveBtn = document.getElementById('wizard-btn-finish');
        if (saveBtn && saveBtn.disabled) return; // Prevent double submission
        const origSaveText = saveBtn ? saveBtn.innerHTML : '';
        const resetBtn = () => {
            if (saveBtn) {
                saveBtn.innerHTML = origSaveText;
                saveBtn.disabled = false;
            }
            if (typeof lucide !== 'undefined') lucide.createIcons();
        };

        if (saveBtn) {
            saveBtn.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:16px; height:16px;"></i> Saving...';
            saveBtn.disabled = true;
        }

        // Enforce dynamic camera limits
        const maxCams = window.getMaxCamerasAllowed(State.userProfile?.subscription_plan);
        if (!State.activeCameraIdForEdit && State.cameraList.length >= maxCams) {
            showToast(`${State.userProfile.subscription_plan} Plan limit reached (${maxCams} cameras). Please upgrade under Billing tab.`, 'error');
            closeAddCameraModal();
            resetBtn();
            return;
        }

        const id = document.getElementById('camera-form-id').value;
        const name = document.getElementById('cam-form-name').value;
        const location = document.getElementById('cam-form-location').value;

        const activeTab = document.getElementById('cam-active-tab').value;
        let rtsp = '';
        if (activeTab === 'tab-webcam') {
            rtsp = document.getElementById('cam-form-source').value;
        } else if (activeTab === 'tab-rtsp') {
            rtsp = document.getElementById('cam-form-rtsp').value;
            if (!rtsp) { showToast("Please enter an RTSP URL", "error"); resetBtn(); return; }
        } else if (activeTab === 'tab-onvif') {
            const ip = document.getElementById('cam-form-onvif-ip').value;
            const user = document.getElementById('cam-form-onvif-user').value;
            const pass = document.getElementById('cam-form-onvif-pass').value;
            if (!ip) { showToast("Please enter an IP address", "error"); resetBtn(); return; }
            rtsp = `rtsp://${user ? user + ':' : ''}${pass ? pass + '@' : ''}${ip}:554/stream1`;
        }

        const username = '';
        const pass = '';

        const interval = 5;
        const prompt = document.getElementById('cam-form-prompt').value.trim();

        // Validate Prompt Appropriateness via AI
        if (prompt) {
            try {
                const valRes = await fetch(window.API_BASE_URL + '/api/prompt/validate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ promptText: prompt })
                });
                if (valRes.ok) {
                    const valData = await valRes.json();
                    if (valData.valid === false) {
                        showToast(`Prompt Invalid: ${valData.reason}`, 'error');
                        resetBtn();
                        return; // Block save
                    }
                }
            } catch (e) {
                console.error("Prompt validation error", e);
                // Fail open if validation API is down so we don't break the app completely
            }
        }

        const isDuplicate = State.cameraList.some(cam =>
            cam.rtsp_url === rtsp && cam.id.toString() !== id.toString()
        );

        if (isDuplicate) {
            alert('This camera feed (URL or Device) is already connected to your account!');
            resetBtn();
            return;
        }

        let encryptedPassword = '';
        if (pass) {
            try {
                const encResp = await fetch(window.API_BASE_URL + '/api/cameras/encrypt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pass })
                });
                const encData = await encResp.json();
                if (encData.password_encrypted) {
                    encryptedPassword = encData.password_encrypted;
                } else {
                    throw new Error("Encryption failed on backend");
                }
            } catch (e) {
                console.error("Password encryption error:", e);
                alert("Failed to securely encrypt password. Camera not saved.");
                resetBtn();
                return;
            }
        }

        const cameraData = {
            user_id: State.currentUser.id,
            name,
            location,
            rtsp_url: rtsp,
            username,
            password_encrypted: encryptedPassword,
            detection_interval: interval,
            user_id: State.currentUser ? State.currentUser.id : null
        };

        // The 2-day free trial is replaced by a 20 live camera minute limit in the backend.
        // We no longer automatically expire based on created_at date.

        if (id) {
            // Update
            const { data } = await dbClient.updateCamera(id, State.currentUser.id, cameraData);
            if (data) {
                await dbClient.addPrompt({ camera_id: id, user_id: State.currentUser.id, prompt_text: prompt });
                await syncCameraWithEngine({ ...data, id });
                showToast("Camera configurations updated successfully.", 'success');
            }
        } else {
            // Create
            const { data } = await dbClient.addCamera(cameraData);
            if (data) {
                await dbClient.addPrompt({ camera_id: data.id, user_id: State.currentUser.id, prompt_text: prompt });
                await syncCameraWithEngine(data);
                showToast("New camera feed connected to OSHA AI cluster.", 'success');
            }
        }

        closeAddCameraModal();
        await renderCamerasGrid();
        resetBtn();
    });

    // 11. Camera Details & Live Auto-Save Prompt Widget
    let autosaveDebounceTimer;
    let detailsCanvasLoop = null;

    const startDetailsCanvasPreview = (canvas, cam) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const camId = cam.id;

        // For webcam cameras: ensure detection loop is running
        if (cam.rtsp_url && cam.rtsp_url.startsWith('webcam://')) {
            const videoEl = State.activeWebcamStreams[camId];
            if (videoEl) {
                if (videoEl.readyState >= 2) {
                    startBrowserDetectionLoop(cam, videoEl);
                } else {
                    const onReady = () => {
                        startBrowserDetectionLoop(cam, videoEl);
                        videoEl.removeEventListener('canplay', onReady);
                    };
                    videoEl.addEventListener('canplay', onReady);
                }
            }
        }

        let frameCount = 0;
        const loc = cam.location.toLowerCase();
        let objects = getPromptSimulatedObjects(cam.activePromptText, cam.activePromptMetadata);
        let lastPromptText = cam.activePromptText;
        let lastPromptMetadata = cam.activePromptMetadata;
        let roomLines = [];

        if (loc.includes('gate') || loc.includes('door') || loc.includes('yard') || loc.includes('garden')) {
            roomLines = [
                { x1: 40, y1: 280, x2: 600, y2: 280 },
                { x1: 120, y1: 80, x2: 120, y2: 280 },
                { x1: 520, y1: 80, x2: 520, y2: 280 },
                { x1: 120, y1: 160, x2: 520, y2: 160 },
                { x1: 120, y1: 220, x2: 520, y2: 220 }
            ];
        } else if (loc.includes('nursery') || loc.includes('room') || loc.includes('nanny') || loc.includes('crib')) {
            roomLines = [
                { x1: 80, y1: 280, x2: 560, y2: 280 },
                { x1: 160, y1: 180, x2: 480, y2: 180 },
                { x1: 160, y1: 260, x2: 480, y2: 260 },
                { x1: 160, y1: 180, x2: 160, y2: 280 },
                { x1: 480, y1: 180, x2: 480, y2: 280 },
                { x1: 240, y1: 180, x2: 240, y2: 260 },
                { x1: 320, y1: 180, x2: 320, y2: 260 },
                { x1: 400, y1: 180, x2: 400, y2: 260 }
            ];
        } else if (loc.includes('warehouse') || loc.includes('dock') || loc.includes('stock')) {
            roomLines = [
                { x1: 20, y1: 300, x2: 620, y2: 300 },
                { x1: 60, y1: 40, x2: 60, y2: 300 },
                { x1: 300, y1: 40, x2: 300, y2: 300 },
                { x1: 540, y1: 40, x2: 540, y2: 300 },
                { x1: 60, y1: 120, x2: 540, y2: 120 },
                { x1: 60, y1: 220, x2: 540, y2: 220 }
            ];
        } else {
            roomLines = [
                { x1: 0, y1: 280, x2: 640, y2: 280 },
                { x1: 200, y1: 40, x2: 120, y2: 280 },
                { x1: 440, y1: 40, x2: 520, y2: 280 },
                { x1: 200, y1: 40, x2: 440, y2: 40 },
                { x1: 120, y1: 120, x2: 200, y2: 120 }
            ];
        }

        const renderLoop = () => {
            if (!document.getElementById('details-canvas') || detailsCanvasLoop === null) {
                return;
            }
            frameCount++;

            let videoEl = State.activeWebcamStreams[camId];

            if (cam.activePromptText !== lastPromptText || cam.activePromptMetadata !== lastPromptMetadata) {
                lastPromptText = cam.activePromptText;
                lastPromptMetadata = cam.activePromptMetadata;
                objects = getPromptSimulatedObjects(cam.activePromptText, cam.activePromptMetadata);
            }

            // Determine which video source to draw
            const webcamReady = cam.rtsp_url.startsWith('webcam://') && videoEl && videoEl.readyState >= 2;
            const hlsEntry = State.activeHlsStreams[camId];
            const hlsReady = hlsEntry && hlsEntry.ready && hlsEntry.videoEl && hlsEntry.videoEl.readyState >= 2;

            if (webcamReady) {
                // Auto-resize modal canvas to native webcam resolution on first frame
                if (videoEl.videoWidth && canvas.width !== videoEl.videoWidth) {
                    canvas.width = videoEl.videoWidth;
                    canvas.height = videoEl.videoHeight;
                    // Keep max 640px wide in the modal, preserve aspect ratio
                    const maxW = 640;
                    const ar = videoEl.videoWidth / videoEl.videoHeight;
                    canvas.style.width = '100%';
                    canvas.style.height = Math.round(Math.min(canvas.offsetWidth || maxW, maxW) / ar) + 'px';
                    canvas.style.aspectRatio = `${videoEl.videoWidth} / ${videoEl.videoHeight}`;
                }
                drawImageContain(ctx, videoEl, canvas.width, canvas.height);
            } else if (hlsReady) {
                // Live RTSP→HLS frame
                drawImageContain(ctx, hlsEntry.videoEl, canvas.width, canvas.height);
            } else {
                ctx.fillStyle = '#060a13';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
                ctx.lineWidth = 1;
                for (let i = 40; i < canvas.width; i += 40) {
                    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
                }
                for (let j = 40; j < canvas.height; j += 40) {
                    ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(canvas.width, j); ctx.stroke();
                }

                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.lineWidth = 2;
                roomLines.forEach(line => {
                    ctx.beginPath(); ctx.moveTo(line.x1, line.y1); ctx.lineTo(line.x2, line.y2); ctx.stroke();
                });
            }

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(canvas.width / 2 - 20, canvas.height / 2); ctx.lineTo(canvas.width / 2 + 20, canvas.height / 2);
            ctx.moveTo(canvas.width / 2, canvas.height / 2 - 20); ctx.lineTo(canvas.width / 2, canvas.height / 2 + 20);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(30, 50); ctx.lineTo(30, 30); ctx.lineTo(50, 30);
            ctx.moveTo(canvas.width - 50, 30); ctx.lineTo(canvas.width - 30, 30); ctx.lineTo(canvas.width - 30, 50);
            ctx.moveTo(30, canvas.height - 50); ctx.lineTo(30, canvas.height - 30); ctx.lineTo(50, canvas.height - 30);
            ctx.moveTo(canvas.width - 50, canvas.height - 30); ctx.lineTo(canvas.width - 30, canvas.height - 30); ctx.lineTo(canvas.width - 30, canvas.height - 50);
            ctx.stroke();

            if (cam.status !== 'Paused') {
                const matchState = cameraMatchState[camId];
                if (matchState && Date.now() < matchState.expiresAt) {
                    // Match active - no bounding box drawn as requested by user
                } else {
                    // No Gemini match — draw real-time YOLO live tracking boxes (cyan, dashed)
                    const liveBoxes = State.cameraLiveBoxes[camId];
                    drawLiveYoloBoxes(ctx, liveBoxes, canvas.width, canvas.height, frameCount);
                }
            } else {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.fillRect(canvas.width / 2 - 20, canvas.height / 2 - 30, 12, 60);
                ctx.fillRect(canvas.width / 2 + 8, canvas.height / 2 - 30, 12, 60);
            }

            const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.font = '11px monospace';
            ctx.fillText(dateStr, 24, canvas.height - 16);

            if (detailsCanvasLoop !== null) {
                detailsCanvasLoop = requestAnimationFrame(renderLoop);
            }
        };

        detailsCanvasLoop = requestAnimationFrame(renderLoop);
    };

    const openCameraDetailsModal = async (camera) => {
        const modal = document.getElementById('camera-details-modal');
        modal.classList.add('active');

        const nameEl = document.getElementById('details-cam-name');
        if (nameEl) nameEl.textContent = camera.name;
        const statusEl = document.getElementById('details-cam-status');
        if (statusEl) {
            statusEl.className = `cam-status ${camera.status === 'Paused' ? 'paused' : ''}`;
            statusEl.innerHTML = `<span class="pulse-dot green"></span> ${(camera.status || 'ONLINE').toUpperCase()}`;
        }
        const locEl = document.getElementById('details-location');
        if (locEl) locEl.textContent = camera.location || 'N/A';
        const intervalEl = document.getElementById('details-interval');
        if (intervalEl) intervalEl.textContent = `${camera.detection_interval || 5}s`;
        const rtspEl = document.getElementById('details-rtsp');
        if (rtspEl) rtspEl.textContent = camera.rtsp_url ? camera.rtsp_url.replace(/:[^:@]+@/, ':****@') : 'webcam://0';

        // Fetch prompt
        const promptsRes = await dbClient.getPromptsForCamera(camera.id, State.currentUser.id);
        const prompt = promptsRes.data && promptsRes.data.length > 0 ? promptsRes.data[0] : null;
        const activePrompt = prompt ? prompt.prompt_text : '';
        camera.activePromptText = activePrompt;
        camera.activePromptMetadata = prompt ? prompt.extracted_metadata : null;

        // Set video stream canvas rendering
        const videoBox = document.getElementById('details-video-stream-box');
        videoBox.className = 'details-video-stream';
        videoBox.innerHTML = '<canvas id="details-canvas" width="640" height="320" style="width:100%; height:100%; object-fit:cover; border-radius:12px; filter: brightness(0.85) contrast(1.1);"></canvas>';

        const detailsCanvas = document.getElementById('details-canvas');
        if (detailsCanvas) {
            startDetailsCanvasPreview(detailsCanvas, camera);
        }

        const textarea = document.getElementById('details-prompt-textarea');
        const charCount = document.getElementById('details-char-count');
        const maxChars = 500;
        textarea.maxLength = maxChars;

        const updateDetailsCharCount = (val) => {
            const len = val.length;
            charCount.textContent = `${len} / ${maxChars}`;
            charCount.style.color = len >= maxChars ? 'var(--text-red)' : 'var(--text-secondary)';
        };

        textarea.value = activePrompt;
        updateDetailsCharCount(activePrompt);

        // Render prompts configs list history
        renderPromptsHistoryList(promptsRes.data || []);

        // Load camera local detections logs
        await renderCameraDetectionsHistory(camera.id);

        // Use Supabase Realtime to push detection history
        if (window.detectionHistoryPoller) {
            try { window.detectionHistoryPoller.unsubscribe(); } catch (e) { }
            clearInterval(window.detectionHistoryPoller);
        }
        window.detectionHistoryPoller = dbClient.subscribeToDetections(State.currentUser.id, (newAlert, eventType) => {
            if (newAlert && newAlert.camera_id === camera.id) {
                renderCameraDetectionsHistory(camera.id);
            }
        });

        // Function to update the Interpreter Status UI
        const updateInterpreterUI = (metadata) => {
            const statusDiv = document.getElementById('details-ai-interpreter-status');
            if (!metadata) {
                statusDiv.style.display = 'none';
                return;
            }
            statusDiv.style.display = 'block';

            if (!metadata.supported) {
                statusDiv.style.background = 'rgba(239,68,68,0.1)';
                statusDiv.style.border = '1px solid rgba(239,68,68,0.3)';
                statusDiv.innerHTML = `<span style="color:var(--text-red); font-weight:bold;">⚠️ Unsupported Request:</span> <span style="color:var(--text-secondary);">${metadata.unsupportedReason}</span>`;
                document.getElementById('details-prompt-save').disabled = true;
                return;
            }

            document.getElementById('details-prompt-save').disabled = false;
            statusDiv.style.background = 'rgba(16,185,129,0.1)';
            statusDiv.style.border = '1px solid rgba(16,185,129,0.3)';

            let html = `<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center;">`;
            html += `<span style="color:var(--accent-emerald); font-weight:bold;">Capabilities Loaded:</span>`;

            if (metadata.requiredModules.includes('ObjectDetection')) html += `<span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:0.75rem;">🎯 Object Detection</span>`;
            if (metadata.requiredModules.includes('ObjectTracking')) html += `<span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:0.75rem;">👣 Tracking</span>`;
            if (metadata.requiredModules.includes('ZoneEngine')) html += `<span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:0.75rem;">📐 Zone Engine</span>`;
            if (metadata.requiredModules.includes('RuleEngine')) html += `<span style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:0.75rem;">⚙️ Rule Engine</span>`;

            html += `</div>`;
            statusDiv.innerHTML = html;
        };

        // Initialize UI with existing metadata if present
        if (camera.activePromptText) {
            fetch(window.API_BASE_URL + '/api/engine/interpret', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: camera.activePromptText })
            }).then(r => r.json()).then(updateInterpreterUI).catch(e => console.error(e));
        }

        // Bind auto-save prompt events
        textarea.oninput = () => {
            const val = textarea.value;
            camera.activePromptText = val; // Live update text in preview
            updateDetailsCharCount(val);

            // Fetch capabilities in real time
            fetch(window.API_BASE_URL + '/api/engine/interpret', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: val })
            }).then(r => r.json()).then(updateInterpreterUI).catch(e => console.error(e));

            // Autosave visual flashes
            const autosaveLabel = document.getElementById('details-autosave-indicator');
            autosaveLabel.textContent = "Typing...";

            clearTimeout(autosaveDebounceTimer);
            autosaveDebounceTimer = setTimeout(async () => {
                const isSaveBtnDisabled = document.getElementById('details-prompt-save').disabled;
                if (!isSaveBtnDisabled) {
                    camera.activePromptText = val; // Sync local state before engine sync
                    await dbClient.addPrompt({ camera_id: camera.id, user_id: State.currentUser.id, prompt_text: val, created_at: new Date().toISOString() });
                    await syncCameraWithEngine(camera);

                    autosaveLabel.textContent = "Saved";
                    showToast("Prompt autosaved to Supabase.", 'success');

                    const histRes = await dbClient.getPromptsForCamera(camera.id, State.currentUser.id);
                    renderPromptsHistoryList(histRes.data || []);
                } else {
                    autosaveLabel.textContent = "Not Saved (Unsupported)";
                }
            }, 1500);
        };

        // Reset & Save trigger bindings
        const resetBtn = document.getElementById('details-prompt-reset');
        resetBtn.onclick = () => {
            textarea.value = activePrompt;
            updateDetailsCharCount(activePrompt);
            document.getElementById('details-autosave-indicator').textContent = "Saved";
            fetch(window.API_BASE_URL + '/api/engine/interpret', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: activePrompt })
            }).then(r => r.json()).then(updateInterpreterUI).catch(e => console.error(e));
        };

        const saveBtn = document.getElementById('details-prompt-save');
        saveBtn.onclick = async () => {
            if (saveBtn.disabled) return;

            saveBtn.disabled = true;
            const originalText = saveBtn.innerHTML;
            saveBtn.innerHTML = '<i data-lucide="loader-2" class="spin" style="width:14px; height:14px;"></i> Saving...';

            try {
                const val = textarea.value;
                camera.activePromptText = val; // Sync local state
                await dbClient.addPrompt({ camera_id: camera.id, user_id: State.currentUser.id, prompt_text: val, created_at: new Date().toISOString() });
                await syncCameraWithEngine(camera);
                document.getElementById('details-autosave-indicator').textContent = "Saved";
                showToast("Prompt saved successfully.", 'success');
            } catch (err) {
                console.error(err);
                showToast("Error saving prompt.", 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerHTML = originalText;
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        };

        modal.classList.add('active');
    };

    const renderPromptsHistoryList = (prompts) => {
        const container = document.getElementById('details-prompt-history-list');
        container.innerHTML = '';

        if (prompts.length === 0) {
            container.innerHTML = `<div class="empty-state">No historical changes.</div>`;
            return;
        }

        prompts.forEach(p => {
            const item = document.createElement('div');
            item.className = 'prompt-hist-item';

            const timeStr = new Date(p.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

            item.innerHTML = `
                <span class="prompt-hist-txt">"${p.prompt_text}"</span>
                <span class="prompt-hist-time">${timeStr}</span>
            `;
            container.appendChild(item);
        });
    };

    let detectionHistoryPoller = null;

    const renderCameraDetectionsHistory = async (cameraId) => {
        const timeline = document.getElementById('details-history-timeline');
        if (!timeline) return;

        // Use per-camera query method for efficiency
        const { data } = await (dbClient.getDetectionsForCamera
            ? dbClient.getDetectionsForCamera(cameraId, State.currentUser.id)
            : dbClient.getDetections(State.currentUser.id).then(r => ({ data: r.data ? r.data.filter(d => d.camera_id === cameraId) : [] }))
        );

        const cameraEvents = data || [];

        if (cameraEvents.length === 0) {
            timeline.innerHTML = `<div class="empty-state">No alert matches.</div>`;
            return;
        }

        timeline.innerHTML = '';
        cameraEvents.forEach(e => {
            const row = document.createElement('div');
            row.className = 'history-row-detail';

            const timeStr = new Date(e.timestamp || e.created_at).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            row.innerHTML = `
                <div style="display:flex;gap:10px;align-items:flex-start;">
                    ${e.snapshot_url
                    ? `<img src="${e.snapshot_url}" style="width:64px;height:42px;object-fit:cover;border-radius:6px;flex-shrink:0;border:1px solid rgba(16,185,129,0.4);" alt="Snapshot" onerror="this.outerHTML='<div style=\\'width:64px;height:42px;background:#0d1117;border-radius:6px;flex-shrink:0;border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;\\'><span style=\\'font-size:18px;\\'>📷</span></div>'" />`
                    : `<div style="width:64px;height:42px;background:#0d1117;border-radius:6px;flex-shrink:0;border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;"><span style="font-size:18px;">📷</span></div>`
                }
                    <div>
                        <div class="hist-lbl">${e.reason}</div>
                        <div class="hist-time">${timeStr} · ${parseFloat(e.confidence || 0).toFixed(1)}% confidence</div>
                    </div>
                </div>
            `;
            timeline.appendChild(row);
        });
    };

    document.getElementById('details-modal-close').addEventListener('click', () => {
        document.getElementById('camera-details-modal').classList.remove('active');
        if (detailsCanvasLoop !== null) {
            cancelAnimationFrame(detailsCanvasLoop);
            detailsCanvasLoop = null;
        }
        if (detectionHistoryPoller) {
            clearInterval(detectionHistoryPoller);
            detectionHistoryPoller = null;
        }
        const videoBox = document.getElementById('details-video-stream-box');
        videoBox.innerHTML = ''; // Clean up canvas element
    });

    // 12. Tab View: Alerts Timeline & Filters
    const filterCamera = document.getElementById('filter-camera');
    const filterStatus = document.getElementById('filter-status');
    const searchAlert = document.getElementById('search-alert');

    const showImageModal = (alert) => {
        const dateObj = new Date(alert.timestamp);
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

        const modalHtml = `
            <div id="dynamic-image-modal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.4); z-index: 9999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(8px); opacity: 0; transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
                <div style="background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 24px; max-width: 850px; width: 95%; box-shadow: 0 32px 64px rgba(0,0,0,0.4); transform: scale(0.95) translateY(10px); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column;">
                    <div style="padding: 24px 32px 16px 32px; display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <div style="background: var(--accent-blue-glow); color: var(--accent-blue); padding: 8px; border-radius: 50%; display: flex;">
                                <i data-lucide="cctv" style="width: 18px; height: 18px;"></i>
                            </div>
                            <h3 style="margin: 0; font-size: 1.25rem; color: var(--text-primary); font-weight: 600; letter-spacing: -0.01em;">${alert.cameras ? alert.cameras.name : 'Camera'}</h3>
                        </div>
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <a href="${alert.snapshot_url}" download="alert-snapshot.jpg" style="background: var(--bg-neutral); border: 1px solid var(--border-light); color: var(--text-primary); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; text-decoration: none;" onmouseover="this.style.background='var(--border-light)'" onmouseout="this.style.background='var(--bg-neutral)'" title="Download Image">
                                <i data-lucide="download" style="width: 18px; height: 18px;"></i>
                            </a>
                            <button id="dynamic-modal-close" style="background: var(--bg-neutral); border: 1px solid var(--border-light); color: var(--text-primary); width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='var(--border-light)'" onmouseout="this.style.background='var(--bg-neutral)'">
                                <i data-lucide="x" style="width: 18px; height: 18px;"></i>
                            </button>
                        </div>
                    </div>
                    
                    <div style="padding: 8px 32px; flex-grow: 1; display: flex; justify-content: center; align-items: center;">
                        <div style="position: relative; width: 100%; border-radius: 16px; overflow: hidden; border: 1px solid var(--border-glass); box-shadow: 0 8px 32px rgba(0,0,0,0.15); background: #000;">
                            <img src="${alert.snapshot_url}" style="width: 100%; max-height: 60vh; object-fit: contain; display: block;">
                        </div>
                    </div>
                    
                    <div style="padding: 24px 32px 32px 32px;">
                        <div style="display: inline-block; background: var(--accent-emerald-glow); color: var(--accent-emerald); padding: 4px 12px; border-radius: 100px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;">
                            ${alert.confidence}% Match
                        </div>
                        <p style="margin: 0 0 12px 0; color: var(--text-primary); font-size: 1.15rem; font-weight: 500; line-height: 1.5; letter-spacing: -0.01em;">${alert.reason}</p>
                        <div style="display: flex; align-items: center; color: var(--text-secondary); font-size: 0.9rem; font-weight: 500;">
                            <i data-lucide="clock" style="width: 14px; height: 14px; margin-right: 6px;"></i>
                            ${dateStr} at ${timeStr}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        if (typeof lucide !== 'undefined') lucide.createIcons();

        const modalEl = document.getElementById('dynamic-image-modal');
        const closeBtn = document.getElementById('dynamic-modal-close');

        // Animate in
        requestAnimationFrame(() => {
            modalEl.style.opacity = '1';
            modalEl.children[0].style.transform = 'translateY(0)';
        });

        const closeThisModal = () => {
            modalEl.style.opacity = '0';
            modalEl.children[0].style.transform = 'translateY(20px)';
            setTimeout(() => modalEl.remove(), 200);
        };

        closeBtn.addEventListener('click', closeThisModal);
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) closeThisModal();
        });
    };

    const renderAlertsTimeline = async () => {
        const timeline = document.getElementById('alerts-log-timeline');
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const alertsRes = await dbClient.getDetections(State.currentUser.id);

        const cameras = camsRes.data || [];
        const alerts = alertsRes.data || [];

        // Build camera select list options
        filterCamera.innerHTML = '<option value="all">All Cameras</option>';
        cameras.forEach(c => {
            filterCamera.innerHTML += `<option value="${c.id}">${c.name}</option>`;
        });

        // Filter alerts
        const camVal = filterCamera.value;
        const statVal = filterStatus.value;
        const query = searchAlert.value.toLowerCase().trim();
        const dateFilterEl = document.getElementById('filter-date');
        const dateVal = dateFilterEl ? dateFilterEl.value : 'all';

        const now = new Date();
        const filteredAlerts = alerts.filter(a => {
            const matchCam = camVal === 'all' || a.camera_id === camVal;
            const matchStat = statVal === 'all' || a.status === statVal;
            const camName = a.cameras ? a.cameras.name : (a.camera_name || 'Unknown Camera');
            const matchQuery = !query || a.reason.toLowerCase().includes(query) || camName.toLowerCase().includes(query);

            let matchDate = true;
            if (dateVal === 'today') {
                const aDate = new Date(a.timestamp);
                matchDate = aDate.toDateString() === now.toDateString();
            } else if (dateVal === 'week') {
                const aDate = new Date(a.timestamp);
                const diffTime = Math.abs(now - aDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                matchDate = diffDays <= 7;
            }

            return matchCam && matchStat && matchQuery && matchDate;
        });

        timeline.innerHTML = '';

        if (filteredAlerts.length === 0) {
            timeline.innerHTML = `<div class="empty-state">No alerts match search filters.</div>`;
            return;
        }

        filteredAlerts.forEach(alert => {
            const row = document.createElement('div');
            // Use the new premium CSS class
            row.className = 'alert-list-item';
            if (alert.status === 'Unread') {
                row.classList.add('unread');
            }

            // Format dates
            const dateObj = new Date(alert.timestamp);
            const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
            const relative = getRelativeTimeString(dateObj);

            const snapshotHtml = alert.snapshot_url
                ? `<img src="${alert.snapshot_url}" alt="Alert Snapshot" class="alert-list-img">`
                : `<div class="alert-list-img" style="display:flex; align-items:center; justify-content:center; color:#fff; background:#000;">SCAN</div>`;

            row.innerHTML = `
                ${snapshotHtml}
                <div class="alert-list-details">
                    <h4 class="alert-list-title">${alert.cameras ? alert.cameras.name : 'Unknown Camera'}</h4>
                    <div style="font-size: 0.9rem; color: var(--text-primary); margin-bottom: 4px;">${alert.reason}</div>
                    <div class="alert-list-meta">
                        <span>${dateStr} ${timeStr} (${relative})</span>
                        <span style="color: var(--accent-emerald); font-weight: 500;">${alert.confidence}% Confidence</span>
                    </div>
                </div>
                <button class="icon-btn text-red action-delete-alert" title="Purge Alert" style="background: none; border: none; cursor: pointer;">
                    <i data-lucide="trash-2"></i>
                </button>
            `;

            row.querySelector('.action-delete-alert').addEventListener('click', async (e) => {
                e.stopPropagation();
                await dbClient.deleteDetection(alert.id, State.currentUser.id);
                showToast("Alert event deleted.", 'success');
                await renderAlertsTimeline();
                await syncNotificationsBellBadge();
            });

            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                if (alert.snapshot_url) {
                    showImageModal(alert);
                }

                if (alert.status === 'Unread') {
                    dbClient.updateDetectionStatus(alert.id, State.currentUser.id, { status: 'Read' }).then(() => {
                        row.classList.remove('unread');
                        alert.status = 'Read';
                        syncNotificationsBellBadge();
                    });
                }
            });

            timeline.appendChild(row);
        });

        if (typeof lucide !== 'undefined') lucide.createIcons();
    };

    // Filter Change event listeners
    filterCamera.addEventListener('change', renderAlertsTimeline);
    filterStatus.addEventListener('change', renderAlertsTimeline);
    searchAlert.addEventListener('input', renderAlertsTimeline);
    const dateFilterEl = document.getElementById('filter-date');
    if (dateFilterEl) {
        dateFilterEl.addEventListener('change', renderAlertsTimeline);
    }

    // AI Event Semantic Search logic
    const aiSearchBtn = document.getElementById('ai-search-btn');
    const aiSearchInput = document.getElementById('ai-search-input');
    const suggestionBtns = document.querySelectorAll('.ai-suggestion-btn');

    if (aiSearchBtn && aiSearchInput) {
        aiSearchBtn.addEventListener('click', async () => {
            const query = aiSearchInput.value.trim();
            if (!query) {
                renderAlertsTimeline(); // Reset to normal view
                return;
            }

            const timeline = document.getElementById('alerts-log-timeline');
            timeline.innerHTML = '<div class="empty-state">Performing AI semantic search...</div>';
            aiSearchBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Searching...';
            if (typeof lucide !== 'undefined') lucide.createIcons();

            try {
                // Get filter values
                const camVal = filterCamera.value === 'all' ? null : filterCamera.value;
                const dateVal = document.getElementById('filter-date') ? document.getElementById('filter-date').value : 'all';
                let startDate = null;
                let endDate = null;

                if (dateVal === 'today') {
                    const d = new Date();
                    d.setHours(0, 0, 0, 0);
                    startDate = d.toISOString();
                } else if (dateVal === 'week') {
                    const d = new Date();
                    d.setDate(d.getDate() - 7);
                    startDate = d.toISOString();
                }

                const res = await API.performSemanticSearch(query, State.currentUser.id, camVal, startDate, endDate);

                if (res && !res.error) {
                    const results = res.results || [];

                    timeline.innerHTML = '';
                    if (!results || results.length === 0) {
                        timeline.innerHTML = `<div class="empty-state" style="color:var(--text-secondary);">No semantic matches found for "${query}".</div>`;
                        return;
                    }

                    results.forEach(alert => {
                        const row = document.createElement('div');
                        row.className = 'alert-list-item';

                        const dateObj = new Date(alert.detected_at || alert.timestamp);
                        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const dateStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                        const relative = getRelativeTimeString(dateObj);

                        const snapshotHtml = alert.snapshot_url
                            ? `<img src="${alert.snapshot_url}" alt="Alert Snapshot" class="alert-list-img">`
                            : `<div class="alert-list-img" style="display:flex; align-items:center; justify-content:center; color:#fff; background:#000;">NO IMG</div>`;

                        row.innerHTML = `
                            ${snapshotHtml}
                            <div class="alert-list-details">
                                <h4 class="alert-list-title">🧠 Semantic Match (${Math.round(alert.similarity * 100)}%)</h4>
                                <div style="font-size: 0.9rem; color: var(--text-primary); margin-bottom: 4px;">${alert.search_description || alert.reason}</div>
                                <div class="alert-list-meta">
                                    <span>${dateStr} ${timeStr} (${relative})</span>
                                    <span style="color: var(--accent-emerald); font-weight: 500;">${alert.confidence}% Confidence</span>
                                </div>
                            </div>
                        `;
                        row.style.cursor = 'pointer';
                        row.addEventListener('click', () => {
                            if (alert.snapshot_url) showImageModal(alert);
                        });
                        timeline.appendChild(row);
                    });
                    if (typeof lucide !== 'undefined') lucide.createIcons();

                } else {
                    throw new Error('Search failed');
                }
            } catch (err) {
                console.error('AI Search Error:', err);
                timeline.innerHTML = `<div class="empty-state text-red">Search failed. See console.</div>`;
            } finally {
                aiSearchBtn.innerHTML = '<i data-lucide="search"></i> Search Events';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });

        // Trigger on enter key
        aiSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') aiSearchBtn.click();
        });

        // Suggestions
        suggestionBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                aiSearchInput.value = btn.innerText;
                aiSearchBtn.click();
            });
        });
    }

    // Helper: Relative time string formatter
    function getRelativeTimeString(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        let interval = Math.floor(seconds / 31536000);

        if (interval >= 1) return interval + " years ago";
        interval = Math.floor(seconds / 2592000);
        if (interval >= 1) return interval + " months ago";
        interval = Math.floor(seconds / 86400);
        if (interval >= 1) return interval + " days ago";
        interval = Math.floor(seconds / 3600);
        if (interval >= 1) return interval + " hours ago";
        interval = Math.floor(seconds / 60);
        if (interval >= 1) return interval + " mins ago";
        return seconds < 10 ? "Just now" : Math.floor(seconds) + " seconds ago";
    };

    // 13. Tab View: Notifications settings
    const loadNotificationsForm = () => {
        if (!State.userSettings) return;

        document.getElementById('notify-email').checked = State.userSettings.email_notifications;
        document.getElementById('cooldown-interval').value = State.userSettings.notification_cooldown;
        document.getElementById('digest-email').checked = State.userSettings.daily_summary;
    };

    const notifyForm = document.getElementById('settings-notifications-form');
    notifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email_notifications = document.getElementById('notify-email').checked;
        const notification_cooldown = parseInt(document.getElementById('cooldown-interval').value);
        const daily_summary = document.getElementById('digest-email').checked;

        const { data } = await dbClient.updateSettings(State.currentUser.id, {
            email_notifications,
            notification_cooldown,
            daily_summary
        });

        if (data) {
            State.userSettings = data;
            showToast("Notification channels saved.", 'success');
        } else {
            showToast("Failed to update settings.", 'error');
        }
    });

    // Test Alert trigger btn
    const testAlertBtn = document.getElementById('test-alert-btn');
    testAlertBtn.addEventListener('click', async () => {
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const cameras = camsRes.data || [];

        if (cameras.length === 0) {
            showToast("Configure at least one camera channel to dispatch tests.", 'error');
            return;
        }

        // Add a mock test detection
        const camera = cameras[0];

        // Mock prompt instructions text
        const promptText = "Test Alert matched.";

        // Push raw trigger
        const newDetection = {
            camera_id: camera.id,
            user_id: State.currentUser.id,
            snapshot_url: '',
            reason: 'Test Alert: Direct diagnostic test trigger successfully resolved.',
            confidence: 99.99,
            status: 'Unread',
            timestamp: new Date().toISOString()
        };

        // Suppressing live mock logic to avoid overlap, call direct mock db function
        const detections = JSON.parse(localStorage.getItem('osha_detections')) || [];
        const seedDetections = {
            id: 'det-test-' + Math.random().toString(36).substr(2, 9),
            ...newDetection,
            created_at: new Date().toISOString()
        };
        detections.unshift(seedDetections);
        localStorage.setItem('osha_detections', JSON.stringify(detections));

        // Fire custom window event
        window.dispatchEvent(new CustomEvent('osha-live-detection', { detail: { detection: seedDetections, cameraName: camera.name } }));
        showToast("Test notification dispatched.", 'success');
    });

    // 14. Tab View: Billing & Quotas
    const renderBillingDetails = async () => {};


    document.getElementById('btn-walkthrough-next')?.addEventListener('click', () => {
        const step1 = document.getElementById('walkthrough-step-1');
        const step2 = document.getElementById('walkthrough-step-2');
        step1.style.opacity = '0';
        setTimeout(() => {
            step1.style.display = 'none';
            step2.style.display = 'block';
            setTimeout(() => step2.style.opacity = '1', 50);
        }, 300);
    });

    document.getElementById('btn-walkthrough-next-2')?.addEventListener('click', () => {
        const modal = document.getElementById('purchase-walkthrough-modal');
        const oldPlan = modal?.dataset?.oldPlan;

        // Skip Step 3 if user is upgrading from Starter to Pro (AI Search already unlocked)
        if (oldPlan === 'Starter' || oldPlan === 'Pro') {
            if (modal) {
                modal.style.display = 'none';
                modal.classList.remove('fade-in');
            }
            return;
        }

        const step2 = document.getElementById('walkthrough-step-2');
        const step3 = document.getElementById('walkthrough-step-3');
        const lockIcon = document.getElementById('walkthrough-lock-icon');
        const unlockIcon = document.getElementById('walkthrough-unlock-icon');
        const lockText = document.getElementById('walkthrough-lock-text');
        const finishBtn = document.getElementById('btn-walkthrough-finish');

        // Reset states just in case
        if (lockIcon) { lockIcon.style.display = 'inline-block'; lockIcon.style.opacity = '1'; lockIcon.style.transform = 'scale(1)'; }
        if (unlockIcon) { unlockIcon.style.display = 'none'; unlockIcon.style.transform = 'scale(0.8)'; }
        if (lockText) { lockText.textContent = 'Unlocking premium features...'; }
        if (finishBtn) { finishBtn.style.display = 'none'; }

        step2.style.opacity = '0';
        setTimeout(() => {
            step2.style.display = 'none';
            step3.style.display = 'block';
            setTimeout(() => {
                step3.style.opacity = '1';

                // Play animation
                setTimeout(() => {
                    if (lockIcon) {
                        lockIcon.style.transform = 'scale(1.2)';
                        lockIcon.style.opacity = '0';
                        setTimeout(() => lockIcon.style.display = 'none', 300);
                    }
                    setTimeout(() => {
                        if (unlockIcon) {
                            unlockIcon.style.display = 'inline-block';
                            setTimeout(() => unlockIcon.style.transform = 'scale(1)', 50);
                        }
                        if (lockText) {
                            lockText.textContent = 'AI Search and Notifications are now fully unlocked and ready!';
                        }
                        if (finishBtn) {
                            finishBtn.style.display = 'inline-block';
                        }
                        if (typeof window.confetti === 'function') {
                            confetti({ particleCount: 50, spread: 40, origin: { y: 0.7 } });
                        }
                    }, 300);
                }, 800);

            }, 50);
        }, 300);
    });

    document.getElementById('btn-walkthrough-finish')?.addEventListener('click', () => {
        const modal = document.getElementById('purchase-walkthrough-modal');
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('fade-in');
        }
    });

    // Handle Upgrade confirmations via Stripe
    const upgradeBtnsGrid = document.getElementById('tier-upgrade-grid');
    if (upgradeBtnsGrid) {
        upgradeBtnsGrid.addEventListener('click', async (e) => {
            const btn = e.target.closest('.upgrade-action-btn');
            if (!btn || btn.disabled) return;

            const targetPlan = btn.getAttribute('data-plan');
            if (targetPlan === 'Free') return; // Cannot downgrade to free via checkout

            // Map plan to Stripe Price ID (using generic mock IDs)
            const priceId = targetPlan === 'Starter' ? 'price_starter_mock' : 'price_pro_mock';

            // Fetch promo code if one was entered
            const promoInputId = targetPlan === 'Starter' ? 'promo-starter' : 'promo-pro';
            const promoInput = document.getElementById(promoInputId);
            const promoCode = promoInput ? promoInput.value.trim() : null;

            if (promoCode) {
                // Instant Admin Promo Code Bypass
                if ((promoCode === 'AMAAN' && targetPlan === 'Starter') || (promoCode === 'AMAANPRO' && targetPlan === 'Pro')) {
                    btn.disabled = true;
                    btn.textContent = 'Applying Code...';
                    const oldPlan = State.userProfile.subscription_plan || 'Free Trial';
                    const profileRes = await dbClient.updateProfile(State.currentUser.id, { subscription_plan: targetPlan });

                    const startDate = new Date();
                    const endDate = new Date();
                    endDate.setMonth(endDate.getMonth() + 1); // Valid for exactly 1 month

                    const subUpdates = {
                        plan_name: targetPlan,
                        subscription_status: 'active',
                        billing_interval: 'monthly',
                        start_date: startDate.toISOString(),
                        end_date: endDate.toISOString(),
                        next_billing_date: null
                    };

                    const subRes = await dbClient.updateSubscription(State.currentUser.id, subUpdates);

                    if (profileRes.error || subRes.error) {
                        const errMsg = (profileRes.error && profileRes.error.message) || (subRes.error && subRes.error.message) || 'Unknown DB Error';
                        console.error("Profile Error:", profileRes.error);
                        console.error("Sub Error:", subRes.error);
                        showToast(`DB Error: ${errMsg}`, 'error');
                        btn.disabled = false;
                        btn.textContent = 'Upgrade to ' + targetPlan;
                        return;
                    }

                    State.userProfile.subscription_plan = targetPlan;
                    if (window.updateProfileRing) window.updateProfileRing(targetPlan);
                    if (window.updateFeatureLocks) window.updateFeatureLocks(targetPlan);

                    showToast(`Promo Code Applied! Instantly upgraded to ${targetPlan} Plan!`, 'success');

                    const camsRes = await dbClient.getCameras(State.currentUser.id);
                    const cams = camsRes.data || [];

                    document.getElementById('sidebar-plan-label').textContent = `${targetPlan} Plan`;
                    window.syncCameraUsageUI(cams.length, targetPlan);

                    await renderBillingDetails();

                    if (typeof showPurchaseWalkthrough === 'function') {
                        showPurchaseWalkthrough(oldPlan, targetPlan);
                    }
                    return;
                } else {
                    // Invalid Promo Code Block
                    showToast('Invalid Promo Code entered.', 'error');
                    return;
                }
            }

            btn.disabled = true;
            btn.textContent = 'Redirecting...';

            try {
                // Checkout removed

                const data = await response.json();
                if (data.url) {
                    window.location.href = data.url;
                } else {
                    showToast('Failed to start checkout process.', 'error');
                    btn.disabled = false;
                    btn.textContent = `Select ${targetPlan}`;
                }
            } catch (err) {
                console.error(err);
                showToast('Billing error', 'error');
                btn.disabled = false;
                btn.textContent = `Select ${targetPlan}`;
            }
        });
    }

    // Handle Manage Billing portal
    // manageBillingBtn removed

    // 15. Tab View: Settings
    const loadSettingsForm = () => {
        if (!State.userProfile || !State.userSettings) return;

        document.getElementById('settings-display-name').value = State.userProfile.full_name;
        document.getElementById('settings-email').value = State.userProfile.email;
        document.getElementById('notify-email').checked = State.userSettings.email_notifications === true;
        document.getElementById('cooldown-interval').value = State.userSettings.cooldown_interval || 60;
        document.getElementById('digest-email').checked = State.userSettings.daily_digest === true;
    };

    const settingsProfileForm = document.getElementById('settings-profile-form');
    settingsProfileForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('settings-display-name').value;

        const profRes = await dbClient.updateProfile(State.currentUser.id, { full_name: name });

        if (profRes.data) {
            State.userProfile = profRes.data;
            showToast("Workspace profile settings saved.", 'success');

            // Sync topbar header & side bar text
            document.getElementById('sidebar-username').textContent = State.userProfile.full_name;
            document.getElementById('topbar-welcome').textContent = `Welcome back, ${State.userProfile.full_name.split(' ')[0]}`;
        }
    });

    const settingsNotifForm = document.getElementById('settings-notifications-form');
    if (settingsNotifForm) {
        settingsNotifForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailNotify = document.getElementById('notify-email').checked;
            const cooldownVal = parseInt(document.getElementById('cooldown-interval').value) || 60;
            const dailyDigest = document.getElementById('digest-email').checked;

            const settRes = await dbClient.updateSettings(State.currentUser.id, {
                email_notifications: emailNotify,
                cooldown_interval: cooldownVal,
                daily_digest: dailyDigest
            });
            if (settRes.data) {
                State.userSettings = settRes.data;
                showToast("Notification preferences updated.", 'success');
            }
        });
    }

    // Backup & Export JSON Action
    const exportBtn = document.getElementById('settings-export-btn');
    exportBtn.addEventListener('click', async () => {
        const camsRes = await dbClient.getCameras(State.currentUser.id);
        const alertsRes = await dbClient.getDetections(State.currentUser.id);

        const payload = {
            osha_ai_version: '2026.1',
            export_timestamp: new Date().toISOString(),
            profile: {
                full_name: State.userProfile.full_name,
                email: State.userProfile.email,
                subscription_plan: State.userProfile.subscription_plan
            },
            cameras: camsRes.data || [],
            detections: alertsRes.data || []
        };

        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 4));
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute("href", dataStr);
        dlAnchor.setAttribute("download", `osha-ai-backup-${State.currentUser.id}.json`);
        document.body.appendChild(dlAnchor);
        dlAnchor.click();
        dlAnchor.remove();

        showToast("Backup logs downloaded.", 'success');
    });

    // Delete Account trigger
    const deleteAccBtn = document.getElementById('settings-delete-btn');
    deleteAccBtn.addEventListener('click', () => {
        openConfirmDialog(
            "Purge Workspace Data",
            "WARNING: This will permanently delete your OSHA AI account configuration, linked cameras, alerts, settings, and profile backups. This action is irreversible.",
            async () => {
                // Clear localStorage
                localStorage.removeItem('osha_session');
                const users = JSON.parse(localStorage.getItem('osha_users'));
                const email = State.currentUser.email;
                if (users[email]) {
                    delete users[email];
                    localStorage.setItem('osha_users', JSON.stringify(users));
                }

                showToast("Workspace account purged.", 'success');
                State.currentUser = null;
                window.location.hash = '#login';
                // Trigger customized state change
                window.dispatchEvent(new CustomEvent('osha-auth-state-changed'));
            }
        );
    });

    // 16. Action Confirmation Dialog Modal
    let confirmAcceptCallback = null;
    const confirmModal = document.getElementById('confirm-modal');

    const openConfirmDialog = (title, message, callback) => {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        confirmAcceptCallback = callback;
        confirmModal.classList.add('active');
    };

    const closeConfirmDialog = () => {
        confirmModal.classList.remove('active');
        confirmAcceptCallback = null;
    };

    document.getElementById('confirm-cancel-btn').addEventListener('click', closeConfirmDialog);
    document.getElementById('confirm-accept-btn').addEventListener('click', () => {
        if (confirmAcceptCallback) {
            confirmAcceptCallback();
        }
        closeConfirmDialog();
    });

    // 17. User Profile Dropdown toggles
    const userMenuTrigger = document.getElementById('user-menu-trigger');
    const userDropdown = document.getElementById('user-dropdown');
    const topbarAvatarBtn = document.getElementById('topbar-avatar-btn');

    const toggleUserDropdown = (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('active');
    };

    userMenuTrigger.addEventListener('click', toggleUserDropdown);
    topbarAvatarBtn.addEventListener('click', toggleUserDropdown);

    document.addEventListener('click', () => {
        userDropdown.classList.remove('active');
    });

    // Sidebar Mobile Toggle Expand
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.querySelector('.console-sidebar');
    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('expanded');
        });

        document.addEventListener('click', () => {
            sidebar.classList.remove('expanded');
        });

        sidebar.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // 18. Real-time Live Alert Listener
    window.addEventListener('osha-live-detection', async (e) => {
        const { detection, cameraName, eventType } = e.detail;

        cameraMatchState[detection.camera_id] = {
            label: detection.reason,
            confidence: detection.confidence || 99.0,
            expiresAt: Date.now() + 3000,
            lastSceneState: (detection.metadata && detection.metadata.yolo_boxes) ? detection.metadata.yolo_boxes : []
        };

        // Sync statistics on overview tab if active
        await syncNotificationsBellBadge();

        const activeTab = window.location.hash || '#dashboard';
        if (activeTab === '#dashboard') {
            await loadDashboardStats();
        } else if (activeTab === '#alerts') {
            await renderAlertsTimeline();
        }

        // Only trigger intrusive UI notifications (Toast + OS Popup) for entirely new events (INSERTs)
        if (eventType === 'INSERT') {
            // Trigger live slide-in toast visual
            showToast(`<strong>${cameraName}:</strong> ${detection.reason} (${detection.confidence}% confidence)`, 'success');

            // Fire native browser push notification (bottom-right OS popup)
            if ('Notification' in window && Notification.permission === 'granted') {
                const notif = new Notification(`🚨 OSHA AI Alert — ${cameraName}`, {
                    body: `${detection.reason}\n${detection.confidence}% confidence`,
                    icon: 'favicon.ico',
                    badge: 'favicon.ico',
                    tag: 'osha-alert-' + (detection.id || Date.now()),
                    requireInteraction: false,
                    silent: false
                });
                // Clicking notification focuses the dashboard
                notif.onclick = () => {
                    window.focus();
                    window.location.hash = '#alerts';
                    notif.close();
                };
            }
        }
    });

    // Kickstart application auth state check
    initAuthListener();
    checkGoogleLogin();

    // ---------------------------------------------------------
    // Dashboard Ambient Particles Interactive Background
    // ---------------------------------------------------------
    const bgCanvas = document.getElementById('ambient-particles');
    if (bgCanvas) {
        const ctx = bgCanvas.getContext('2d');
        if (!ctx) return;
        let particles = [];
        let mouse = { x: null, y: null, radius: 150 };

        const resizeCanvas = () => {
            bgCanvas.width = window.innerWidth;
            bgCanvas.height = window.innerHeight;
            initParticles();
        };

        class Particle {
            constructor(x, y) {
                this.x = x;
                this.y = y;
                this.size = Math.random() * 2 + 1;
                this.color = 'rgba(37, 99, 235, 0.15)'; // Soft blue glow particle
                this.vx = (Math.random() - 0.5) * 0.4;
                this.vy = (Math.random() - 0.5) * 0.4;
            }
            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                ctx.fillStyle = this.color;
                ctx.fill();
            }
            update() {
                this.x += this.vx;
                this.y += this.vy;
                if (this.x < 0 || this.x > bgCanvas.width) this.vx = -this.vx;
                if (this.y < 0 || this.y > bgCanvas.height) this.vy = -this.vy;
                if (mouse.x !== null && mouse.y !== null) {
                    let dx = mouse.x - this.x;
                    let dy = mouse.y - this.y;
                    let distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance < mouse.radius) {
                        let force = (mouse.radius - distance) / mouse.radius;
                        let directionX = dx / distance;
                        let directionY = dy / distance;
                        this.x -= directionX * force * 15;
                        this.y -= directionY * force * 15;
                    }
                }
            }
        }

        const initParticles = () => {
            particles = [];
            const numberOfParticles = Math.min(Math.floor((bgCanvas.width * bgCanvas.height) / 18000), 75);
            for (let i = 0; i < numberOfParticles; i++) {
                particles.push(new Particle(Math.random() * bgCanvas.width, Math.random() * bgCanvas.height));
            }
        };

        const connect = () => {
            let opacityValue = 1;
            for (let a = 0; a < particles.length; a++) {
                for (let b = a; b < particles.length; b++) {
                    let dx = particles[a].x - particles[b].x;
                    let dy = particles[a].y - particles[b].y;
                    let distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance < 120) {
                        opacityValue = 1 - (distance / 120);
                        ctx.strokeStyle = `rgba(37, 99, 235, ${opacityValue * 0.08})`;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(particles[a].x, particles[a].y);
                        ctx.lineTo(particles[b].x, particles[b].y);
                        ctx.stroke();
                    }
                }
            }
        };

        const animate = () => {
            ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
            particles.forEach(p => { p.update(); p.draw(); });
            connect();
            requestAnimationFrame(animate);
        };

        window.addEventListener('resize', resizeCanvas);
        window.addEventListener('mousemove', (e) => { mouse.x = e.x; mouse.y = e.y; });
        window.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });

        resizeCanvas();
        animate();
    }

    // Theme Toggle Logic
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        // Load saved theme
        const savedTheme = localStorage.getItem('osha_theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        themeBtn.innerHTML = savedTheme === 'dark' ? '<i data-lucide="sun"></i> <span>Light Mode</span>' : '<i data-lucide="moon"></i> <span>Dark Mode</span>';
        if (typeof lucide !== 'undefined') lucide.createIcons();

        themeBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('osha_theme', newTheme);

            themeBtn.innerHTML = newTheme === 'dark' ? '<i data-lucide="sun"></i> <span>Light Mode</span>' : '<i data-lucide="moon"></i> <span>Dark Mode</span>';
            if (typeof lucide !== 'undefined') lucide.createIcons();

            // Re-render chart for dark/light mode if it exists
            if (window.activityChartInstance) {
                window.activityChartInstance.options.scales.x.grid.color = newTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
                window.activityChartInstance.options.scales.y.grid.color = newTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
                window.activityChartInstance.update();
            }
        });
    }

    // Initialize Chart.js Activity Graph
    const initActivityChart = async () => {
        const ctx = document.getElementById('activityChart');
        if (!ctx || !State.currentUser) return;

        // Load mock/real data for chart
        const alertsRes = await dbClient.getDetections(State.currentUser.id);
        const alerts = alertsRes.data || [];

        // Group by hour for the past 24 hours (simplified logic)
        const dataMap = new Array(24).fill(0);
        const now = new Date();

        alerts.forEach(a => {
            const date = new Date(a.timestamp);
            const diffMs = now - date;
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            if (diffHours < 24) {
                dataMap[23 - diffHours]++;
            }
        });

        const labels = dataMap.map((_, i) => {
            const d = new Date(now);
            d.setHours(d.getHours() - (23 - i));
            return d.getHours() + ':00';
        });

        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const gridColor = currentTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

        window.activityChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'AI Detections (Last 24h)',
                    data: dataMap,
                    borderColor: '#2555eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.2)',
                    borderWidth: 2,
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: gridColor },
                        ticks: { stepSize: 1 }
                    },
                    x: {
                        grid: { color: gridColor }
                    }
                }
            }
        });
    };

    // Call init on load
    setTimeout(initActivityChart, 1000);

    // Camera Health Polling
    const pollCameraHealth = async () => {
        if (document.hidden) return;
        if (!State.cameraList || State.cameraList.length === 0) return;

        const healthListEl = document.getElementById('camera-health-list');

        let html = '';
        for (const cam of State.cameraList) {
            try {
                const res = await fetch(`${window.API_BASE_URL}/api/health/${cam.id}`);
                if (res.ok) {
                    const stats = await res.json();
                    let color = 'var(--text-primary)';
                    let badgeColor = '#9ca3af';

                    if (stats.level === 'WARNING') { color = 'var(--accent-yellow)'; badgeColor = '#eab308'; }
                    else if (stats.level === 'LIMITED') { color = 'var(--accent-orange)'; badgeColor = '#f97316'; }
                    else if (stats.level === 'SAFE_MODE') { color = 'var(--accent-red)'; badgeColor = '#ef4444'; }
                    else { color = 'var(--accent-emerald)'; badgeColor = '#10b981'; }

                    const badgeEl = document.getElementById(`health-badge-${cam.id}`);
                    if (badgeEl) {
                        badgeEl.title = `Score: ${stats.score} | Reqs: ${stats.dailyReqs || 0}/day | Burst: ${stats.currentBurst || 0}/min`;
                        badgeEl.querySelector('.health-dot').style.background = badgeColor;
                        badgeEl.querySelector('.health-dot').style.boxShadow = `0 0 6px ${badgeColor}`;
                        badgeEl.querySelector('.health-text').textContent = `API: ${stats.level}`;
                    }

                    if (healthListEl) {
                        html += `
                            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border-light); padding-bottom: 8px;">
                                <div>
                                    <div style="font-weight:600;">${cam.name}</div>
                                    <div style="font-size:0.8rem; color:var(--text-secondary);">Score: ${stats.score} | Level: <span style="color:${color}; font-weight:bold;">${stats.level}</span></div>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-size:0.8rem;">${stats.dailyReqs || 0} reqs today</div>
                                    <div style="font-size:0.8rem; color:var(--text-secondary);">${stats.currentBurst || 0} burst/min</div>
                                </div>
                            </div>
                        `;
                    }
                }
            } catch (e) {
                console.error('Failed to fetch health for cam', cam.id, e);
            }
        }

        if (healthListEl) {
            if (html) {
                healthListEl.innerHTML = html;
            } else {
                healthListEl.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 12px;">No cameras connected.</div>`;
            }
        }
    };

    // Poll every 5 seconds
    setInterval(pollCameraHealth, 5000);

    // --- Cleanup active streams when user navigates away ---
    window.addEventListener('beforeunload', () => {
        if (State.activeHlsStreams) {
            Object.values(State.activeHlsStreams).forEach(stream => {
                if (stream && stream.streamId) {
                    try {
                        fetch(window.API_BASE_URL + '/api/hls/stop', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ streamId: stream.streamId }),
                            keepalive: true
                        }).catch(() => { });
                    } catch (e) { }
                }
            });
        }
    });
});
