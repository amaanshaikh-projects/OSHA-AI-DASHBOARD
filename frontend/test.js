const acorn = require('acorn');
try {
  acorn.parse("document.addEventListener('DOMContentLoaded', () => {\n});", { ecmaVersion: 2022, sourceType: 'module' });
  console.log('Passed');
} catch(e) {
  console.log(e);
}
