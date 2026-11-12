// Bundles src/*.js into a single self-contained index.html (works from file:// and from a server).
// Usage: node build.js
//
// The cloud shapes come from the CloudWorks project (the source of truth for them): its shared
// core module is bundled from ../CloudWorks/src/cloudcore.js (override with CLOUDWORKS=<dir>), and
// its original cumulus volume is copied to data/cloudworks/ from the built groundview.html.
const fs = require('fs');
const path = require('path');

const CLOUDWORKS = path.resolve(process.env.CLOUDWORKS || path.join(__dirname, '..', 'CloudWorks'));
const sources = {
  'cloudcore.js': path.join(CLOUDWORKS, 'src', 'cloudcore.js'),
};
const order = ['shaders.js', 'atmosphere.js', 'clouds.js', 'cloudmodels.js', 'earth.js', 'lighting.js', 'cloudslot.js', 'exampleclouds.js', 'regionclouds.js', 'cloudcore.js', 'cwstats.js', 'cwfar.js', 'cwclouds.js', 'textures.js', 'spherex.js', 'campose.js', 'sim.js', 'planner.js', 'flare10.js', 'lens.js', 'main.js'];
const imports = new Set();
let body = '';
for (const f of order) {
  const file = sources[f] || path.join(__dirname, 'src', f);
  if (!fs.existsSync(file)) throw new Error(`${f} not found at ${file}` + (sources[f] ? ' (set CLOUDWORKS to the CloudWorks project folder)' : ''));
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
fs.writeFileSync(path.join(__dirname, 'index.html'), tpl.replace('<!-- BUNDLE -->', () => script));
console.log(`index.html built (${(script.length / 1024).toFixed(0)} KB of script; cloud core from ${CLOUDWORKS})`);

// CloudWorks' original cumulus volume (432 x 304 x 328 bytes, gzip): served as a data file, loaded
// by the cloud provider when the page is served (opened as a file, only the ten genera are used).
const gv = path.join(CLOUDWORKS, 'groundview.html');
const out = path.join(__dirname, 'data', 'cloudworks', 'legacy-cumulus.gz');
if (fs.existsSync(gv)) {
  const m = fs.readFileSync(gv, 'utf8').match(/const DENSITY_GZIP='([^']+)';/);
  if (m) {
    const bytes = Buffer.from(m[1], 'base64');
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(bytes)) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
      console.log(`legacy cumulus volume updated (${(bytes.length / 1024).toFixed(0)} KB)`);
    }
  }
}
