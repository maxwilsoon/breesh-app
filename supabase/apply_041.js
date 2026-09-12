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
  const sql = fs.readFileSync(path.join(__dirname, '20260806_041_child_rpc_authenticated_grants.sql'), 'utf8');
  try {
    await PG.query(sql);
    console.log('M041 applied successfully.');
  } catch (e) {
    console.error('M041 failed:', e.message);
    process.exit(1);
  }
  await PG.end();

  // Run verification
  console.log('\nRunning verification...');
  require('./verify_041.js');
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
