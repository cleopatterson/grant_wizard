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

(async () => {
  // Get state and check for browser page
  const state = JSON.parse(await request('GET', '/api/wizard/state'));
  console.log('Step:', state.step);
  console.log('Has browser:', !!state.fields);
  
  // Check the fields with element IDs
  const fields = state.fields || [];
  const p3Fields = fields.filter(f => f.page === 3);
  console.log('\n=== Page 3 fields with element info ===');
  p3Fields.forEach(f => {
    console.log(`  ${f.label}: id=${f._elementId || 'none'} name=${f._elementName || 'none'} sel=${f._cssSelector || 'none'} type=${f.type}`);
  });

  const p4Fields = fields.filter(f => f.page === 4);
  console.log('\n=== Page 4 fields with element info ===');
  p4Fields.forEach(f => {
    console.log(`  ${f.label}: id=${f._elementId || 'none'} name=${f._elementName || 'none'} sel=${f._cssSelector || 'none'} type=${f.type}`);
  });
})();
