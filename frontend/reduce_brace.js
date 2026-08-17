const fs = require('fs');
let code = fs.readFileSync('app.mjs', 'utf8');

// replace block comments
code = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
// replace line comments
code = code.replace(/\/\/.*/g, ' ');
// replace strings (single, double, backtick). This regex is simplified and might fail on escaped quotes, but let's try.
code = code.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, ' ');
// replace regex literals
code = code.replace(/\/(?![*+?])(?:[^\r\n\[/\\]|\\.|\[(?:[^\r\n\]\\]|\\.)*\])+\/[gimuy]*/g, ' ');

// keep only braces and newlines
let chars = [];
let line = 1;
for (let i = 0; i < code.length; i++) {
  if (code[i] === '\n') line++;
  if (code[i] === '{' || code[i] === '}') {
    chars.push({ c: code[i], line: line });
  }
}

// reduce
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < chars.length - 1; i++) {
    if (chars[i].c === '{' && chars[i+1].c === '}') {
      chars.splice(i, 2);
      changed = true;
      break; // restart
    }
  }
}

console.log('Unbalanced braces:');
chars.forEach(ch => console.log(ch.c + ' at line ' + ch.line));
