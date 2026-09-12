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
  const sql = fs.readFileSync(path.join(__dirname, '20260809_043_actor_filter.sql'), 'utf8');
  try {
    await PG.query(sql);
    console.log('M043 applied successfully.');
  } catch (e) {
    console.error('M043 failed:', e.message);
    await PG.end();
    process.exit(1);
  }
  await PG.end();

  console.log('\nRunning verification...\n');
  await import('./verify_043.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
