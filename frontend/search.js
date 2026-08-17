const fs = require('fs');
const lines = fs.readFileSync('js/app.js', 'utf8').split('\n');
const { execSync } = require('child_process');

function check(n) {
    const code = lines.slice(0, n).join('\n');
    fs.writeFileSync('temp.mjs', code);
    try {
        execSync('node -c temp.mjs', { stdio: ['pipe', 'pipe', 'pipe'] });
        return 'SUCCESS';
    } catch (e) {
        const err = e.stderr ? e.stderr.toString() : '';
        if (err.includes("Unexpected end of input")) return 'UNEXPECTED_END';
        return 'SYNTAX_ERROR';
    }
}

let paren = 0, brace = 0;
let inString = false, strChar = '';
for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Very simple counting, ignoring comments for a sec just to get a hint
    for (let j = 0; j < line.length; j++) {
        let c = line[j];
        if (!inString) {
            if (c === "'" || c === '"' || c === "`") { inString = true; strChar = c; }
            else if (c === '(') paren++;
            else if (c === ')') paren--;
            else if (c === '{') brace++;
            else if (c === '}') brace--;
        } else {
            if (c === strChar && line[j-1] !== '\\') inString = false;
        }
    }
    if (paren === 0 && i > 22) {
        console.log('Paren reached 0 at line', i + 1);
}
console.log('Final paren:', paren);
console.log('Final brace:', brace);}
