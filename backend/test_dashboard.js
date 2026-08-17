const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('dashboard.html', 'utf8');

const dom = new JSDOM(html, {
    url: "http://localhost:8000/dashboard.html",
    runScripts: "dangerously",
    resources: "usable"
});

const errors = [];
const warnings = [];

dom.window.console.error = (...args) => errors.push(args.join(' '));
dom.window.console.warn = (...args) => warnings.push(args.join(' '));

dom.window.addEventListener('error', (event) => {
    errors.push(`[DOM Error] ${event.message} at ${event.filename}:${event.lineno}`);
});

dom.window.addEventListener('unhandledrejection', (event) => {
    errors.push(`[Unhandled Rejection] ${event.reason}`);
});

setTimeout(() => {
    console.log("--- ERRORS ---");
    errors.forEach(e => console.log(e));
    console.log("\n--- WARNINGS ---");
    warnings.forEach(w => console.log(w));
    process.exit(0);
}, 2000);
