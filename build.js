// Builds the single-file app:  node build.js
// Joins src/shell.html + src/styles.css + src/js/*.js (+ the vendor modules) into video-redline.html (in this folder).
// Users never run this: they just open the finished video-redline.html.
//   node build.js            writes video-redline.html
//   node build.js <file>     writes that file instead
//   node build.js --check    writes nothing; says whether video-redline.html is up to date with src/ (exit code 1 when it is not)
const fs = require('fs'), path = require('path');
const root = __dirname, src = path.join(root, 'src');
const lf = s => s.replace(/\r\n/g, '\n');                       // the same page on every computer, whatever git did to the line endings
const read = (...p) => lf(fs.readFileSync(path.join(src, ...p), 'utf8'));
const maybe = (...p) => { const f = path.join(src, ...p); return fs.existsSync(f) ? lf(fs.readFileSync(f, 'utf8')) : ''; };

const checkOnly = process.argv[2] === '--check';
const target = path.join(root, 'video-redline.html');
const out = (!checkOnly && process.argv[2]) || target;
const jsFiles = fs.readdirSync(path.join(src, 'js')).filter(f => /\.js$/.test(f)).sort();
const app = jsFiles.map(f => '/* ---- src/js/' + f + ' ---- */\n' + read('js', f)).join('\n');

// Vendor modules: plain scripts that define globals (ODParse, VIS, Cleanup, TranscriberClient, CleanupPanel). They go before the app code.
const vendorJs = ['od-parse.js', 'visuals.js', 'cleanup.js', 'transcriber-client.js', 'cleanup-panel.js'].map(f => maybe('vendor', f)).filter(Boolean).join('\n;\n');
const styles = maybe('vendor', 'od-styles.json').trim();
const icons = maybe('vendor', 'icons.html');
const notice = maybe('vendor', 'NOTICE-open-design.txt');

// A script that contains the text "</script" would end the page's script early and cut the page in half, silently.
if (/<\/script/i.test(app) || /<\/script/i.test(vendorJs)) { console.error('PROBLEM: "</script" appears inside a script (write "<\\/script" instead).'); process.exit(1); }

// The version comes from the one-line file VERSION in this folder (for example 0.1.0-beta); it is shown at the bottom of the page.
const version = fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() : 'dev';

let html = read('shell.html').split('{{VERSION}}').join(version.replace(/[^0-9A-Za-z.+-]/g, ''));
html = html.replace('/*{{CSS}}*/', () => read('styles.css') + '\n' + maybe('vendor', 'visuals.css'));
html = html.replace('<!--{{ICONS}}-->', () => icons);
const data = (styles ? '<script type="application/json" id="od-styles">\n' + styles.replace(/<\/script/gi, '<\\/script') + '\n</script>\n' : '') +
             (notice ? '<script type="text/plain" id="od-notice">\n' + notice.replace(/<\/script/gi, '<\\/script') + '\n</script>\n' : '') +
             (vendorJs ? '<script>\n' + vendorJs + '\n</script>' : '');
html = html.replace('<!--{{DATA}}-->', () => data);
html = html.replace('/*{{JS}}*/', () => app);

// Every placeholder of shell.html must have been replaced.
const left = html.match(/\{\{(VERSION|CSS|JS|DATA|ICONS)\}\}/);
if (left) { console.error('PROBLEM: the placeholder ' + left[0] + ' is still in the page.'); process.exit(1); }

if (checkOnly) {
  const have = fs.existsSync(target) ? lf(fs.readFileSync(target, 'utf8')) : null;
  if (have === html) { console.log('video-redline.html is up to date with src/ (' + (html.length / 1024).toFixed(0) + ' KB).'); process.exit(0); }
  console.error('PROBLEM: video-redline.html is ' + (have === null ? 'missing' : 'not up to date with src/') + '. Run: node build.js');
  process.exit(1);
}
fs.writeFileSync(out, html);
console.log('built', out, (html.length / 1024).toFixed(0) + ' KB,', html.split('\n').length + ' lines');
