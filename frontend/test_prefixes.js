const fs = require('fs');
const { execSync } = require('child_process');
const lines = fs.readFileSync('js/app.js', 'utf8').split('\n');

for (let i = 22; i < lines.length; i++) {
    if (lines[i].trim() === '});') {
        const code = lines.slice(0, i + 1).join('\n');
        fs.writeFileSync('temp.mjs', code);
        try {
            execSync('node -c temp.mjs', { stdio: 'ignore' });
            console.log('SUCCESS at line: ' + (i + 1));
        } catch (e) {
            // failed, ignore
        }
    }
}
console.log('Done checking prefixes.');
