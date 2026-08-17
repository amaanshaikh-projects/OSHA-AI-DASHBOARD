const fs = require('fs');
const code = fs.readFileSync('js/app.js', 'utf8');

let p = 0, b = 0, s = false, sc = '';
for (let i = 0; i < code.length; i++) {
    let c = code[i];
    if (!s) {
        if (c === "'" || c === '"' || c === "`") { s = true; sc = c; }
        else if (c === '(') p++;
        else if (c === ')') p--;
        else if (c === '{') b++;
        else if (c === '}') b--;
    } else {
        if (c === sc && code[i - 1] !== '\\') s = false;
    }
}
console.log('Final p:', p, 'b:', b);
