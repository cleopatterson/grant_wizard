const http = require('http');

function request(method, path, data) {
  const body = JSON.stringify(data || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3002, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function post(path, data) { return request('POST', path, data); }
function put(path, data) { return request('PUT', path, data); }

function streamSSE(path, data, label) {
  const body = JSON.stringify(data || {});
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 3002, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = '';
      let fields = [];
      res.on('data', c => {
        buf += c.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'browser_action') {
              console.log(`  [${label}] ${d.action}: ${d.detail?.substring(0, 80)}`);
            } else if (d.type === 'fill_field') {
              console.log(`  [${label}] ${d.status}: ${d.label} (p${d.page})`);
            } else if (d.type === 'fill_field_error') {
              console.log(`  [${label}] ERROR: ${d.label}: ${d.error}`);
            } else if (d.type === 'fill_navigating') {
              console.log(`  [${label}] nav: page ${d.page} — ${d.detail || ''}`);
            } else if (d.type === 'fill_complete') {
              console.log(`  [${label}] COMPLETE: ${d.totalFilled} filled (${d.autoFilled} auto, ${d.aiGenerated} AI)`);
            } else if (d.type === 'done') {
              fields = d.fields || [];
              console.log(`  [${label}] DONE: ${fields.length} fields`);
            } else if (d.type === 'scan_complete') {
              console.log(`  [${label}] SCAN DONE: ${d.totalFields} fields`);
            } else if (d.type === 'error') {
              console.log(`  [${label}] ERROR: ${d.message}`);
            }
          } catch (e) {}
        }
      });
      res.on('end', () => resolve(fields));
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  // Step 1: Select the Touring & Travel grant
  console.log('=== Selecting grant ===');
  await post('/api/wizard/select', {
    grant: {
      id: 2, name: 'Sound NSW — Touring & Travel Fund',
      portalType: 'smartygrants',
      url: 'https://www.nsw.gov.au/departments-and-agencies/sound-nsw/funding-and-support/touring-and-travel-fund',
      loginUrl: 'https://soundnsw.smartygrants.com.au',
      applicationUrl: 'https://soundnsw.smartygrants.com.au/form/15030850/continue/1',
    }
  });

  // Step 2: Scan
  console.log('\n=== Scanning ===');
  const scanData = { credentials: { email: 'cleopatterson@gmail.com', password: 'sS0nnycher!' } };
  await streamSSE('/api/wizard/scan', scanData, 'scan');

  // Step 3: Check field state after scan
  console.log('\n=== Checking field state ===');
  const stateResp = await request('GET', '/api/wizard/state');
  const state = JSON.parse(stateResp);
  const fields = state.fields || [];
  console.log(`Total fields: ${fields.length}`);
  console.log(`Fields with values: ${fields.filter(f => f.value).length}`);
  console.log(`Fields to fill: ${fields.filter(f => f.value && f.status !== 'skip').length}`);
  // Show first 15 fields with values
  fields.filter(f => f.value).slice(0, 15).forEach(f => {
    console.log(`  [p${f.page}] ${f.label}: "${String(f.value).substring(0, 60)}" (${f.status}/${f.classifiedType})`);
  });
  console.log('Fields checked');

  // Step 4: Fill
  console.log('\n=== Filling form ===');
  await streamSSE('/api/wizard/fill', {}, 'fill');

  console.log('\n=== Done ===');
  process.exit(0);
})();

setTimeout(() => { console.log('--- TIMEOUT ---'); process.exit(1); }, 600000);
