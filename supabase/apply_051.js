const fs = require('fs');
const sql = fs.readFileSync('supabase/20260812_051_parent_push_passcode.sql', 'utf8');
fetch('https://api.supabase.com/v1/projects/biilrksornvoqtalftty/database/query', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.SUPABASE_MGMT_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql })
}).then(r => r.json()).then(b => {
  if (b && b.message && !Array.isArray(b)) { console.error('FAILED:', b.message); process.exit(1); }
  console.log('Applied M051 OK');
}).catch(e => { console.error(e); process.exit(1); });
