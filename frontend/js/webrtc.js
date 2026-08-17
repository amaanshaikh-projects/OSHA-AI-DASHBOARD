import { State } from './state.js';
import { API } from './api.js';

// WebRTC and HLS Streaming logic
export const WebRTC = {
    initWebSocket: () => {
        const token = State.currentUser ? State.currentUser.id : '';
        State.engineWebSocket = new WebSocket(`ws://${window.location.hostname}:8001?token=${token}`);
        
        State.engineWebSocket.onopen = () => {
            console.log('[WebSocket] Connected to Engine');
            State.wsConnected = true;

            if (State.cameraList && State.cameraList.length > 0) {
                State.cameraList.forEach(cam => {
                    State.engineWebSocket.send(JSON.stringify({ action: 'subscribe', cameraId: cam.id }));
                });
            }
        };
        
        State.engineWebSocket.onmessage = (event) => {
            try {
                const result = JSON.parse(event.data);
                // The main app will listen to these and update cameraLiveBoxes
                // It is better to use a custom event dispatcher here in the future
                const ev = new CustomEvent('webrtc_message', { detail: result });
                window.dispatchEvent(ev);
            } catch (err) {
                console.error('WebSocket parsing error', err);
            }
        };

        State.engineWebSocket.onclose = () => {
            State.wsConnected = false;
            setTimeout(WebRTC.initWebSocket, 5000); // Auto reconnect
        };
    },

    stopAllStreams: async () => {
        // Stop all HLS streams
        for (const camId in State.activeHlsStreams) {
            if (State.activeHlsStreams[camId]) {
                const h = State.activeHlsStreams[camId];
                if (h.hls) {
                    try { h.hls.destroy(); } catch (e) { }
                }
                if (h.videoEl) {
                    h.videoEl.remove();
                }
                delete State.activeHlsStreams[camId];
                await API.stopHlsStream(camId).catch(() => {});
            }
        }
        
        // Stop webcam streams
        for (const camId in State.activeWebcamStreams) {
            const videoEl = State.activeWebcamStreams[camId];
            if (videoEl) {
                const stream = videoEl.srcObject;
                if (stream) {
                    stream.getTracks().forEach(t => t.stop());
                }
                videoEl.srcObject = null;
                if (videoEl.parentNode) {
                    videoEl.remove();
                }
            }
            delete State.activeWebcamStreams[camId];
        }

        // Stop canvas loops
        for (const camId in State.activeCanvasLoops) {
            cancelAnimationFrame(State.activeCanvasLoops[camId]);
            delete State.activeCanvasLoops[camId];
        }

        // Purge any orphaned backend video streams from DOM
        document.querySelectorAll('.backend-video-stream').forEach(el => el.remove());
    }
};
