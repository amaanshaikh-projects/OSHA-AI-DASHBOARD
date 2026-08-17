const fs = require('fs');
const { execSync } = require('child_process');
const lines = fs.readFileSync('app.mjs', 'utf8').split('\n');

let left = 20;
let right = 4596;
let ans = -1;

while (left <= right) {
  let mid = Math.floor((left + right) / 2);
  let testCode = lines.slice(0, mid).join('\n') + '\n});';
  fs.writeFileSync('bisect_tmp.mjs', testCode);
  try {
    execSync('node -c bisect_tmp.mjs', { stdio: 'pipe' });
    // If it succeeds, it means there are NO extra braces before `mid`, 
    // and appending `});` perfectly closes the one main brace!
    // So the extra } must be AFTER mid.
    left = mid + 1;
  } catch (e) {
    const err = e.stderr ? e.stderr.toString() : e.toString();
    if (err.includes("Unexpected token ')'")) {
      // It failed with Unexpected token ')'.
      // This means the main brace was ALREADY closed before `mid`!
      // So the extra } is BEFORE (or AT) mid.
      ans = mid;
      right = mid - 1;
    } else {
      // It failed with some OTHER error (like unclosed string, unclosed comment, missing `}`).
      // This usually means we cut the file in the middle of a block (like an `if` or `function`), 
      // so `});` is not enough to close it.
      // Or we cut in the middle of a string.
      // This doesn't strictly help us binary search unless we know the structure.
      // But we can just try another mid manually.
      // For binary search to work, we must only test valid chunk boundaries!
      console.log('Other error at ' + mid);
      break;
    }
  }
}
console.log('First Unexpected token ) at: ' + ans);
