#!/usr/bin/env node
'use strict';
const { Client } = require('pg');
const fs   = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const PG = new Client({ connectionString: DATABASE_URL });

(async () => {
  await PG.connect();
  const sql = fs.readFileSync(path.join(__dirname, '20260806_042_notification_secret.sql'), 'utf8');
  try {
    await PG.query(sql);
    console.log('M042 applied successfully.');
  } catch (e) {
    console.error('M042 failed:', e.message);
    process.exit(1);
  }
  await PG.end();

  console.log('\nRunning verification...');
  require('./verify_042.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
