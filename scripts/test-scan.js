const http = require('http');

// First select the grant
const selectData = JSON.stringify({
  grant: {
    id: 3,
    name: 'Sound NSW — Touring & Travel Fund',
    portalType: 'smartygrants',
    url: 'https://www.nsw.gov.au/departments-and-agencies/sound-nsw/funding-and-support/touring-and-travel-fund',
    loginUrl: 'https://soundnsw.smartygrants.com.au',
    applicationUrl: 'https://soundnsw.smartygrants.com.au/form/15030850/continue/1',
  }
});

function post(path, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3002, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamScan(data) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 3002, path: '/api/wizard/scan', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'browser_action') {
              console.log(`  [browser] ${d.action}: ${d.detail}`);
            } else if (d.type === 'warning') {
              console.log(`  [WARN] ${d.message}`);
            } else if (d.type === 'scan_complete') {
              console.log(`  [COMPLETE] ${d.totalFields} fields`);
            } else if (d.type === 'done') {
              console.log(`  [DONE] ${(d.fields || []).length} fields`);
              for (const f of (d.fields || [])) {
                const idx = (d.fields || []).indexOf(f) + 1;
                console.log(`    ${idx}. [${f.type}] ${f.label}${f.options ? ' [' + f.options.length + ' opts]' : ''} (p${f.page})`);
              }
            } else if (d.type === 'error') {
              console.log(`  [ERROR] ${d.message}`);
            }
          } catch (e) {}
        }
      });
      res.on('end', () => { console.log('--- END ---'); resolve(); });
    });
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('Selecting grant...');
  await post('/api/wizard/select', selectData);
  console.log('Starting scan...');
  const scanData = JSON.stringify({
    credentials: { email: 'cleopatterson@gmail.com', password: 'sS0nnycher!' }
  });
  await streamScan(scanData);
  process.exit(0);
})();

setTimeout(() => { console.log('--- TIMEOUT ---'); process.exit(1); }, 300000);
