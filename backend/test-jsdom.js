const { JSDOM } = require('jsdom');
JSDOM.fromURL('http://localhost:8080/dashboard.html#dashboard', { 
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
}).then(dom => { 
    dom.window.fetch = async () => ({ json: async () => ({}) }); // polyfill fetch
    dom.window.console.error = console.error; 
    dom.window.console.log = console.log; 
    dom.window.console.warn = console.warn;
    dom.window.addEventListener('error', e => console.error('BROWSER ERROR:', e.error));
    // Wait a few seconds for scripts to execute
    setTimeout(() => process.exit(0), 4000); 
}).catch(console.error);
