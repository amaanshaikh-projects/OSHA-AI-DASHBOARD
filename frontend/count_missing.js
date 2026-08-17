const fs = require('fs');
const { execSync } = require('child_process');
const code = fs.readFileSync('js/app.js', 'utf8');

// The file currently has }); at the end, which throws Unexpected token ')'
// This means the } closes a block, but the ) is unmatched.
// If we remove the ), does it pass?

const codeWithoutParen = code.slice(0, -2) + '\n}';
fs.writeFileSync('temp.mjs', codeWithoutParen);

try {
    execSync('node -c temp.mjs', { stdio: 'pipe' });
    console.log('SUCCESS with just }');
} catch (e) {
    console.log('Error with just }:', e.stderr.toString().split('\n')[0]);
}

// What if we try adding multiple }
let testCode = code.slice(0, -3); // remove });
for (let i = 0; i <= 5; i++) {
    let suffix = '';
    for(let j=0; j<i; j++) suffix += '\n}';
    suffix += '\n});';
    
    fs.writeFileSync('temp.mjs', testCode + suffix);
    try {
        execSync('node -c temp.mjs', { stdio: 'pipe' });
        console.log('SUCCESS with ' + i + ' missing } before });');
        break;
    } catch (e) {
        console.log('Failed with ' + i + ' missing } before });');
    }
}
