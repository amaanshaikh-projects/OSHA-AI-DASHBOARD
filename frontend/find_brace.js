const fs = require('fs');
const code = fs.readFileSync('d:\\VISION AI 1.0\\frontend\\app.mjs', 'utf8');
let stack = [];
let inString = false;
let stringChar = '';
let inBlockComment = false;
let inLineComment = false;

for (let i = 0; i < code.length; i++) {
  const c = code[i];
  const nextC = code[i+1];
  
  if (inBlockComment) {
    if (c === '*' && nextC === '/') { inBlockComment = false; i++; }
    continue;
  }
  if (inLineComment) {
    if (c === '\n' || c === '\r') { inLineComment = false; }
    continue;
  }
  if (inString) {
    if (c === '\\') { i++; continue; }
    if (c === stringChar) { inString = false; }
    continue;
  }
  
  if (c === '/' && nextC === '*') { inBlockComment = true; i++; continue; }
  if (c === '/' && nextC === '/') { inLineComment = true; i++; continue; }
  if (c === '"' || c === "'" || c === '`') { inString = true; stringChar = c; continue; }
  
  if (c === '{') stack.push(i);
  if (c === '}') {
    if (stack.length === 0) {
      const line = code.substring(0, i).split('\n').length;
      console.log('Extra } at index ' + i + ', line ' + line);
    } else {
      stack.pop();
    }
  }
}
