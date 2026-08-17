const fs = require('fs');
const lines = fs.readFileSync('js/app.js', 'utf8').split('\n');
let b=0, p=0, s=false, sc='';
let minB = 9999;
let linesWhereBIncreased = {};
for(let i=21; i<lines.length; i++) {
    let l = lines[i];
    let prevB = b;
    for(let j=0; j<l.length; j++){
        let c=l[j];
        if(!s){
            if(c==="'"||c==='"'||c==='`'){s=true;sc=c;}
            else if(c==='{')b++;
            else if(c==='}')b--;
        }else{
            if(c===sc && l[j-1]!=='\\')s=false;
        }
    }
    if (b > prevB) linesWhereBIncreased[b] = i + 1;
    if (b < minB) minB = b;
}
console.log('Final b:', b);
console.log('Last time b became 2:', linesWhereBIncreased[2]);
console.log('Last time b became 3:', linesWhereBIncreased[3]);
console.log('Last time b became 4:', linesWhereBIncreased[4]);
