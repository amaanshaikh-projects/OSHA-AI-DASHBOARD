const fs = require('fs');

const dashboardPath = 'dashboard.js';
const appPath = 'js/app.js';
const uiPath = 'js/ui.js';
const statePath = 'js/state.js';

let content = fs.readFileSync(dashboardPath, 'utf8');

// We will build app.js out of the modified dashboard.js
// 1. Remove the global variable declarations
content = content.replace(/let currentUser = null;\r?\n/, '');
content = content.replace(/let userProfile = null;\r?\n/, '');
content = content.replace(/let userSettings = null;\r?\n/, '');
content = content.replace(/let cameraList = \[\];\r?\n/, '');
content = content.replace(/let detectionList = \[\];\r?\n/, '');
content = content.replace(/let activeCameraIdForEdit = null;\r?\n/, '');
content = content.replace(/let engineWebSocket = null;\r?\n/, '');
content = content.replace(/let wsConnected = false;\r?\n/, '');
content = content.replace(/const activeCanvasLoops = \{\};\r?\n/, '');
content = content.replace(/const activeWebcamStreams = \{\};\r?\n/, '');
content = content.replace(/const activeHlsStreams = \{\};\r?\n/, '');
content = content.replace(/const activeBrowserDetectors = \{\};\r?\n/, '');

// 2. Replace variable references with State.xxx
const stateVars = [
    'currentUser', 'userProfile', 'userSettings', 'cameraList', 'detectionList', 
    'activeCameraIdForEdit', 'engineWebSocket', 'wsConnected',
    'activeCanvasLoops', 'activeWebcamStreams', 'activeHlsStreams', 'activeBrowserDetectors', 'metricsPoller'
];

stateVars.forEach(v => {
    const regex = new RegExp(`\\b${v}\\b`, 'g');
    content = content.replace(regex, `State.${v}`);
});

// 3. Remove showToast, showModal, closeModal definitions (we use ui.js for this)
// We'll just regex them out roughly. 
// showToast is from "const showToast = " up to "}, 5000);\n    };"
// This might be tricky, so we'll just inject imports at the top.

const imports = `
import { State, updateState } from './state.js';
import { showToast, showModal, closeModal } from './ui.js';

// Bind to window for any stray onclick events or external calls
window.showModal = showModal;
window.closeModal = closeModal;
window.showToast = showToast;
`;

content = content.replace(/document\.addEventListener\('DOMContentLoaded', \(\) => \{/, imports + "\ndocument.addEventListener('DOMContentLoaded', () => {");

// Remove the definitions manually to avoid bad regex matches
// Wait, replacing them might fail if the regex is wrong. Let's just comment them out using a quick replace.
content = content.replace(/const showToast = /g, 'window.legacyShowToast = ');
content = content.replace(/const showModal = /g, 'window.legacyShowModal = ');
content = content.replace(/const closeModal = /g, 'window.legacyCloseModal = ');

fs.writeFileSync(appPath, content);
console.log('Successfully created js/app.js with state replacements and module imports.');
