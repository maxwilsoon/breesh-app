// Apply migration 070 (device_id-based push-token reclaim) via the
// Supabase Management API. Mirrors apply_069.js.
//   SUPABASE_MGMT_TOKEN=... node supabase/apply_070.js
// Roll back with:  FILE=supabase/20260912_070_rollback.sql node supabase/apply_070.js
//
// NOT RUN as part of this change — do not execute until explicitly approved
// and a SUPABASE_MGMT_TOKEN is supplied.
const fs = require('fs');
const file = process.env.FILE || 'supabase/20260912_070_device_token_reclaim.sql';
const sql = fs.readFileSync(file, 'utf8');
fetch('https://api.supabase.com/v1/projects/biilrksornvoqtalftty/database/query', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.SUPABASE_MGMT_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql })
}).then(r => r.json()).then(b => {
  if (b && b.message && !Array.isArray(b)) { console.error('FAILED:', b.message); process.exit(1); }
  console.log('Applied', file, 'OK');
}).catch(e => { console.error(e); process.exit(1); });
