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
        const p = (planStr || 'free').toLowerCase();
        if (p.includes('free')) return 1;
        if (p.includes('starter')) return 2;
        if (p.includes('pro')) return 5;
        if (p.includes('enterprise')) return '∞';
        return 5;
    };

    window.syncCameraUsageUI = (cameraCount, planStr) => {
        const maxCams = window.getMaxCamerasAllowed(planStr);
        const usageText = `${cameraCount} / ${maxCams} Cameras`;
        
        // Update topbar if it exists
        const topbarUsage = document.getElementById('topbar-camera-usage');
        if (topbarUsage) topbarUsage.textContent = usageText;
        
        // Update billing tab if it exists
        const billingUsageText = document.getElementById('billing-camera-usage-text');
        if (billingUsageText) billingUsageText.textContent = usageText;
        
        const billingFill = document.getElementById('billing-camera-fill');
        if (billingFill) {
            billingFill.style.width = maxCams === '∞' ? '0%' : `${Math.min((cameraCount / maxCams) * 100, 100)}%`;
        }
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

});