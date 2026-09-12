// Apply migration 069 (circle-removal request-visibility fix) via the
// Supabase Management API. Mirrors apply_068.js.
//   SUPABASE_MGMT_TOKEN=... node supabase/apply_069.js
// Roll back with:  FILE=supabase/20260912_069_rollback.sql node supabase/apply_069.js
const fs = require('fs');
const file = process.env.FILE || 'supabase/20260912_069_circle_removal_request_visibility.sql';
const sql = fs.readFileSync(file, 'utf8');
fetch('https://api.supabase.com/v1/projects/biilrksornvoqtalftty/database/query', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.SUPABASE_MGMT_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql })
}).then(r => r.json()).then(b => {
  if (b && b.message && !Array.isArray(b)) { console.error('FAILED:', b.message); process.exit(1); }
  console.log('Applied', file, 'OK');
}).catch(e => { console.error(e); process.exit(1); });
