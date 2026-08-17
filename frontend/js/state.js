export const State = {
    currentUser: null,
    userProfile: null,
    userSettings: null,
    cameraList: [],
    detectionList: [],
    cameraLiveBoxes: {},
    
    // Modal Control Flags
    activeCameraIdForEdit: null,
    
    // High-Performance WebSocket for Webcams
    engineWebSocket: null,
    wsConnected: false,
    
    // Store active streams and handles
    activeCanvasLoops: {}, // Store canvas animation frame handles
    activeWebcamStreams: {}, // Store active webcam video stream elements
    activeHlsStreams: {},   // Store HLS.js instances + hidden video elements for RTSP cameras
    activeBrowserDetectors: {}, // Store browser-side detection interval handles per camera
    
    // Global metric polling handles
    metricsPoller: null
};

// Helper function to safely update state
export const updateState = (key, value) => {
    if (State.hasOwnProperty(key)) {
        State[key] = value;
    }
};
