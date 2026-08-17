const fs = require('fs');
const acorn = require('acorn');
const code = fs.readFileSync('js/app.js', 'utf8');
const fixedCode = code.slice(0, -4) + '\n}\n});\n';

const ast = acorn.parse(fixedCode, { ecmaVersion: 2022, sourceType: 'module', locations: true });

// Traverse the AST to find the node that ends exactly at the inserted }
function traverse(node, path) {
    if (!node || typeof node !== 'object') return;
    
    // We inserted } around line 4579. The block node will end there.
    if (node.loc && node.loc.end.line >= 4578) {
        console.log(path + ' -> ' + node.type + ' starts at line ' + node.loc.start.line);
    }
    
    for (let key in node) {
        if (key === 'loc') continue;
        let child = node[key];
        if (Array.isArray(child)) {
            child.forEach((c, i) => traverse(c, path + '.' + key + '[' + i + ']'));
        } else {
            traverse(child, path + '.' + key);
        }
    }
}

traverse(ast, 'Program');
