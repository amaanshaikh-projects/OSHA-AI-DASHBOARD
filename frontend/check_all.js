const fs = require('fs');
const { execSync } = require('child_process');
const lines = fs.readFileSync('app.mjs', 'utf8').split('\n');

for (let i = lines.length - 2; i >= 4000; i -= 10) {
  let testCode = lines.slice(0, i).join('\n') + '\n});';
  fs.writeFileSync('bisect_tmp.mjs', testCode);
  try {
    execSync('node -c bisect_tmp.mjs', { stdio: 'ignore' });
    console.log('Passed at line ' + i);
    break;
  } catch(e) {}
}
