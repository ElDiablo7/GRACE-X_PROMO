#!/usr/bin/env node
/**
 * GX Map Patch — deterministic, auditable patcher with rollback
 *
 * Usage:
 *   node tools/gx-map-patch.js <repo_root> <build_tag> [--dry-run]
 *
 * Inputs (expected in repo root unless overridden in code):
 *   - gx-map.patch.config.json        (patch targets + markers)
 *   - gx-canonical-hashes.json        (canonical file list + sha256)
 *   - gx-canonical-hashes.sig.json    (optional signature metadata)
 *
 * Outputs:
 *   - gx-patch-backups/<STAMP>/...    (central copy of original files)
 *   - gx-map-patch-report-<STAMP>.json
 *
 * Notes:
 * - Applies marker-based inserts only (strict, deterministic).
 * - If any guardrail fails, attempts rollback of all modified files.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const BUILD_TAG = process.argv[3] || '6.5.1';
const DRY_RUN = process.argv.includes('--dry-run');

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vercel']);

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const STAMP = nowStamp();

function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }
function writeUtf8(p, s) { fs.writeFileSync(p, s, 'utf8'); }

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFileSafe(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function loadJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(readUtf8(p));
}

function fail(msg) {
  const e = new Error(msg);
  e.isGXFail = true;
  throw e;
}

/**
 * Optional signature verification for gx-canonical-hashes.json
 * Expected file: gx-canonical-hashes.sig.json
 * Format:
 * {
 *   "algorithm": "ed25519",
 *   "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
 *   "signatureBase64": "..."
 * }
 */
function verifyCanonicalSignature(repoRoot, report) {
  const sigPath = path.join(repoRoot, 'gx-canonical-hashes.sig.json');
  const sig = loadJsonIfExists(sigPath);
  if (!sig) {
    report.signature = { verified: false, reason: 'no signature file (optional)' };
    return;
  }
  const hashesPath = path.join(repoRoot, 'gx-canonical-hashes.json');
  if (!fs.existsSync(hashesPath)) fail('Missing gx-canonical-hashes.json but signature metadata exists.');

  const msg = fs.readFileSync(hashesPath);
  const publicKey = sig.publicKeyPem;
  const signature = Buffer.from(sig.signatureBase64, 'base64');

  const ok = crypto.verify(null, msg, publicKey, signature);
  report.signature = { verified: ok, algorithm: sig.algorithm || 'unknown', sigPath };
  if (!ok) fail('Canonical hash manifest signature verification failed.');
}

function validateCanonicalHashes(repoRoot, report) {
  const p = path.join(repoRoot, 'gx-canonical-hashes.json');
  if (!fs.existsSync(p)) {
    report.canonical = { verified: false, reason: 'gx-canonical-hashes.json not found' };
    fail('Missing gx-canonical-hashes.json. Create it to enable canonical validation.');
  }
  const manifest = JSON.parse(readUtf8(p));
  if (!manifest || typeof manifest !== 'object' || !manifest.files) {
    fail('gx-canonical-hashes.json invalid format. Expected { "files": { "path": "sha256", ... } }.');
  }
  const files = manifest.files;
  const results = [];

  for (const rel of Object.keys(files)) {
    const expected = files[rel];
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      results.push({ file: rel, ok: false, reason: 'missing' });
      continue;
    }
    const actual = sha256File(abs);
    results.push({ file: rel, ok: actual === expected, expected, actual });
  }

  const ok = results.every(r => r.ok);
  report.canonical = { verified: ok, results };
  if (!ok) fail('Canonical hash validation failed. Refuse to patch to avoid drift.');
}

function loadPatchConfig(repoRoot) {
  const p = path.join(repoRoot, 'gx-map.patch.config.json');
  if (!fs.existsSync(p)) fail('Missing gx-map.patch.config.json (patch targets + markers).');
  const cfg = JSON.parse(readUtf8(p));
  if (!cfg || !Array.isArray(cfg.targets)) fail('gx-map.patch.config.json invalid: expected { targets: [...] }.');
  return cfg;
}

function strictInsertOnce({ text, markerBegin, markerEnd, insertBody }) {
  const beginIdx = text.indexOf(markerBegin);
  const endIdx = text.indexOf(markerEnd);

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    fail(`Markers not found or malformed: \${markerBegin} ... \${markerEnd}`);
  }

  const before = text.slice(0, beginIdx + markerBegin.length);
  const after = text.slice(endIdx); // includes markerEnd

  // If already inserted deterministically (same insertBody), no-op.
  const existing = text.slice(beginIdx + markerBegin.length, endIdx);
  if (existing.includes(insertBody.trim())) {
    return { next: text, changed: false };
  }

  const next = `\${before}\n\${insertBody}\n\${after}`;
  return { next, changed: true };
}

function guardrails(repoRoot, report, cfg) {
  const g = { ok: true, checks: [] };

  // Example guardrail: inserted asset tags must include build tag.
  for (const t of cfg.targets) {
    const abs = path.join(repoRoot, t.file);
    if (!fs.existsSync(abs)) continue;
    const txt = readUtf8(abs);
    if (t.guardrail && t.guardrail.mustContain) {
      for (const s of t.guardrail.mustContain) {
        const ok = txt.includes(s.replaceAll('${BUILD_TAG}', report.buildTag));
        g.checks.push({ type: 'mustContain', file: t.file, needle: s, ok });
        if (!ok) g.ok = false;
      }
    }
  }

  // No external URLs in injected assets (basic scan).
  for (const t of cfg.targets) {
    const abs = path.join(repoRoot, t.file);
    if (!fs.existsSync(abs)) continue;
    const txt = readUtf8(abs);
    const hasHttp = /https?:\/\//i.test(txt);
    // This is strict; if your canonical file already contains http URLs, scope this to markers.
    if (t.guardrail && t.guardrail.forbidHttpInFile === true) {
      g.checks.push({ type: 'forbidHttpInFile', file: t.file, ok: !hasHttp });
      if (hasHttp) g.ok = false;
    }
  }

  report.guardrails = g;
  if (!g.ok) fail('Guardrails failed.');
}

function rollback(changes, report) {
  report.rollback = { attempted: true, restored: [] };
  for (const c of changes) {
    try {
      fs.copyFileSync(c.backupAdjacent, c.file);
      report.rollback.restored.push({ file: c.file, from: c.backupAdjacent });
    } catch (e) {
      report.rollback.restored.push({ file: c.file, error: String(e) });
    }
  }
}

function main() {
  const report = {
    tool: 'gx-map-patch',
    stamp: STAMP,
    repoRoot: ROOT,
    buildTag: BUILD_TAG,
    dryRun: DRY_RUN,
    canonical: null,
    signature: null,
    changes: []
  };

  const cfg = loadPatchConfig(ROOT);

  // Pre-flight: validate canonical baseline.
  verifyCanonicalSignature(ROOT, report);
  validateCanonicalHashes(ROOT, report);

  const backupRoot = path.join(ROOT, 'gx-patch-backups', STAMP);
  if (!DRY_RUN) ensureDir(backupRoot);

  try {
    for (const t of cfg.targets) {
      const abs = path.join(ROOT, t.file);
      if (!fs.existsSync(abs)) fail(`Target file missing: \${t.file}`);

      const original = readUtf8(abs);
      const beforeHash = sha256File(abs);

      let next = original;
      let changed = false;
      const ops = [];

      for (const op of t.ops) {
        if (op.kind === 'strictInsertOnce') {
          const insertBody = op.insertBody
            .replaceAll('${BUILD_TAG}', BUILD_TAG)
            .replaceAll('${ROOT}', ROOT);

          const res = strictInsertOnce({
            text: next,
            markerBegin: op.markerBegin,
            markerEnd: op.markerEnd,
            insertBody
          });
          next = res.next;
          changed = changed || res.changed;
          ops.push({ kind: op.kind, changed: res.changed, markerBegin: op.markerBegin, markerEnd: op.markerEnd });
        } else if (op.kind === 'replaceAll') {
          const before = next;
          next = next.split(op.find).join(op.replace.replaceAll('${BUILD_TAG}', BUILD_TAG));
          const did = before !== next;
          changed = changed || did;
          ops.push({ kind: op.kind, changed: did, find: op.find });
        } else {
          fail(`Unknown op kind: \${op.kind}`);
        }
      }

      if (changed) {
        // Backup adjacent
        const backupAdjacent = `\${abs}.bak-\${STAMP}`;

        // Backup central
        const backupCentral = path.join(backupRoot, t.file);

        if (!DRY_RUN) {
          copyFileSafe(abs, backupCentral);
          fs.copyFileSync(abs, backupAdjacent);
          writeUtf8(abs, next);
        }

        const afterHash = DRY_RUN ? beforeHash : sha256File(abs);

        report.changes.push({
          file: t.file,
          beforeHash,
          afterHash,
          backupAdjacent,
          backupCentral,
          ops
        });
      }
    }

    // Guardrails after write
    guardrails(ROOT, report, cfg);

    // Write report
    const reportPath = path.join(ROOT, `gx-map-patch-report-\${STAMP}.json`);
    if (!DRY_RUN) writeUtf8(reportPath, JSON.stringify(report, null, 2));

    // eslint-disable-next-line no-console
    console.log(`GX Map Patch OK. Report: \${path.basename(reportPath)}`);
    process.exit(0);

  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`GX Map Patch FAILED: \${e.message}`);

    // Rollback if we wrote anything
    if (!DRY_RUN && report.changes.length) {
      rollback(report.changes, report);
      const reportPath = path.join(ROOT, `gx-map-patch-report-\${STAMP}.json`);
      try { writeUtf8(reportPath, JSON.stringify(report, null, 2)); } catch (_) {}
      // eslint-disable-next-line no-console
      console.error(`Rollback attempted. Report: \${path.basename(reportPath)}`);
    }
    process.exit(1);
  }
}

main();
