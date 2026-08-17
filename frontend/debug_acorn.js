const fs = require('fs');
const acorn = require('acorn');
const code = fs.readFileSync('js/app.js', 'utf8');

try {
    acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
} catch (e) {
    console.log(e);
}
