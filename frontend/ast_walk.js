const fs = require('fs');
const acornLoose = require('acorn-loose');
const code = fs.readFileSync('app.mjs', 'utf8');

const ast = acornLoose.parse(code, { ecmaVersion: 2022, locations: true });

function walk(node, path) {
  if (!node) return;
  // If this node ends at the very end of the file (or near it)
  // we print it out to see the chain of unclosed blocks
  if (node.loc && node.loc.end.line >= 4596) {
    console.log(path + ' -> ' + node.type + ' (starts at line ' + node.loc.start.line + ')');
  }
  
  for (let key in node) {
    if (node[key] && typeof node[key] === 'object') {
      if (Array.isArray(node[key])) {
        node[key].forEach((child, i) => walk(child, path + '.' + key + '[' + i + ']'));
      } else {
        walk(node[key], path + '.' + key);
      }
    }
  }
}

walk(ast, 'Program');
