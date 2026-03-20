const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');

const files = [
  'protected/command_deck.html',
  'components/gx-map/gx-map.css',
  'components/gx-map/gx-map.js',
  'tools/gx-map-patch.js',
  'gx-map.patch.config.json'
];

const res = { files: {} };
files.forEach(f => {
  if (fs.existsSync(path.join(ROOT, f))) {
    res.files[f] = hash(f);
  } else {
    console.error('File not found:', f);
  }
});

fs.writeFileSync(path.join(ROOT, 'gx-canonical-hashes.json'), JSON.stringify(res, null, 2));
console.log('Successfully generated gx-canonical-hashes.json');
