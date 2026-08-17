const fs = require('fs');
const code = fs.readFileSync('js/app.js', 'utf8');
const lines = code.split('\n');

for (let i = 0; i < 5; i++) {
    const subset = lines.slice(0, lines.length - i).join('\n');
    fs.writeFileSync('test.mjs', subset);
    console.log('Testing with ' + i + ' lines removed:');
    try {
        require('child_process').execSync('node -c test.mjs', { stdio: 'pipe' });
        console.log('SUCCESS');
    } catch (e) {
        console.log(e.stderr ? e.stderr.toString().substring(0, 150) : e.toString());
    }
}
