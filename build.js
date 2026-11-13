// Bundles src/*.js into a single self-contained index.html (works from file:// and from a server).
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const order = ['shaders.js', 'atmosphere.js', 'clouds.js', 'cloudmodels.js', 'earth.js', 'lighting.js', 'cloudslot.js', 'exampleclouds.js', 'regionclouds.js', 'photoclouds.js', 'citybounce.js', 'textures.js', 'spherex.js', 'campose.js', 'orbit.js', 'sim.js', 'planner.js', 'flare10.js', 'lens.js', 'grade.js', 'main.js'];
const imports = new Set();
let body = '';
for (const f of order) {
  const file = path.join(__dirname, 'src', f);
  if (!fs.existsSync(file)) throw new Error(`${f} not found at ${file}`);
  let src = fs.readFileSync(file, 'utf8');
  if (f === 'flare10.js') {
    const pack = fs.readFileSync(path.join(__dirname, 'data', 'flare10', 'catalyst.bin.gz'));
    src = src.replace("new URL('../data/flare10/catalyst.bin.gz', import.meta.url).href", `'data:application/octet-stream;base64,${pack.toString('base64')}'`);
  }
  const kept = src.split(/\r?\n/).filter((line) => {
    const m = line.match(/^import .* from '(.+)';$/);
    if (!m) return true;
    if (!m[1].startsWith('.')) imports.add(line);
    return false;
  });
  body += `\n// ===== ${f} =====\n` + kept.join('\n').replace(/^export (const|let|function|class|async function) /gm, '$1 ');
}
const script = `<script type="module">\n${[...imports].join('\n')}\n${body}\n</script>`;
const tpl = fs.readFileSync(path.join(__dirname, 'src', 'template.html'), 'utf8');
// The photo clouds' layers (src/photoclouds.js, ~235 MB) start downloading from the head, before
// the 2 MB script has even parsed (~1.5 s sooner); the provider then takes those responses.
// Only when the page asks for the photo clouds (the default).
const cloudDate = fs.readFileSync(path.join(__dirname, 'src', 'earth.js'), 'utf8').match(/CLOUD_DATE = '([\d-]+)'/)[1];
const photoDir = path.join(__dirname, 'data', 'clouds', cloudDate, 'photo');
let preload = '';
if (fs.existsSync(path.join(photoDir, 'photo.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(photoDir, 'photo.json'), 'utf8'));
  const urls = [...Array(meta.cols * meta.rows).keys()].map((i) => `data/clouds/${cloudDate}/photo/L${i}.bc4.gz`);
  // plain fetch() calls kept in window.__pcPrefetch (not <link rel=preload>: Chrome failed to hand
  // the 30 MB preloaded responses over to the page's fetch(), "Failed to fetch" for every layer)
  preload = `<script>(function(){var c=new URLSearchParams(location.search).get('clouds');if(c&&c!=='photo')return;if(location.protocol.indexOf('http')!==0)return;` +
    `var m=window.__pcPrefetch={};${JSON.stringify(urls)}.forEach(function(u){var p=fetch(u,{priority:'high'});p.catch(function(){});m[u]=p;});})();</script>`;
}
fs.writeFileSync(path.join(__dirname, 'index.html'), tpl.replace('<!-- PRELOAD -->', () => preload).replace('<!-- BUNDLE -->', () => script));
console.log(`index.html built (${(script.length / 1024).toFixed(0)} KB of script)`);
