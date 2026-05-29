#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  CLI import script
//  Usage:
//    node scripts/importCSV.js <path-to-csv> <project-id>
//  Example:
//    node scripts/importCSV.js ./data/cps.csv abc-123-project-id
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const logger = require('../src/config/logger');
const { importCSV } = require('../src/services/import.service');

async function run() {
  const [,, filePath, projectId, periodType = 'monthly'] = process.argv;

  if (!filePath || !projectId) {
    console.error('Usage: node scripts/importCSV.js <csv-file> <project-id> [period-type]');
    process.exit(1);
  }

  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    console.error('File not found:', fullPath);
    process.exit(1);
  }

  console.log(`\nImporting: ${fullPath}`);
  console.log(`Project:   ${projectId}`);
  console.log(`Period:    ${periodType}\n`);

  try {
    const buffer = fs.readFileSync(fullPath);
    const result = await importCSV({ buffer, projectId, adminId: null, periodType });

    console.log('─────────────────────────────');
    console.log(`✅ Success: ${result.success} rows`);
    console.log(`❌ Failed:  ${result.failed} rows`);
    console.log(`📊 Total:   ${result.total} rows`);

    if (result.errors.length) {
      console.log('\nErrors:');
      result.errors.forEach(e => console.log(`  Row ${e.row}: ${e.error}`));
    }

    if (result.preview.length) {
      console.log('\nSample imported CPs:');
      result.preview.forEach(p => console.log(`  ${p.name} → ${p.tier} (score: ${p.score})`));
    }

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exit(1);
  }
}

run();
