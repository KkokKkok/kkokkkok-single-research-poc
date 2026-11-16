import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const files=[];function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){if(['node_modules','private-data','.git'].includes(item.name))continue;const path=resolve(dir,item.name);if(item.isDirectory())walk(path);else if(/\.(mjs|js)$/.test(path))files.push(path);}}
walk('.');for(const path of files){const r=spawnSync(process.execPath,['--check',path],{stdio:'inherit',windowsHide:true});if(r.status!==0)process.exit(1);}console.log(`Syntax checked ${files.length} JavaScript files.`);
const html=readFileSync('public/index.html','utf8');for(const asset of ['/app.js','/style.css'])if(!html.includes(asset))throw new Error('Missing frontend asset');
