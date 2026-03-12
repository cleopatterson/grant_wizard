const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext(
    '/tmp/grant-wizard-browser',
    { headless: false, viewport: { width: 1280, height: 900 } }
  );
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://soundnsw.smartygrants.com.au/form/15030850/continue/1');
  console.log('Browser opened — please log in now!');

  // Wait until we're past the login page
  console.log('Waiting for you to log in...');
  await page.waitForURL('**/form/**', { timeout: 120000 });
  console.log('Logged in! URL:', page.url());

  // Wait for form to fully render
  await page.waitForTimeout(3000);
  console.log('Page title:', await page.title());

  // Get accessibility snapshot
  const snap = await page.accessibility.snapshot();
  if (snap) {
    const json = JSON.stringify(snap, null, 2);
    require('fs').writeFileSync('/tmp/smartygrants-form-snapshot.json', json);
    console.log('Saved full snapshot (' + json.length + ' chars)');
    console.log('\n=== FORM FIELDS FOUND ===');

    // Recursively find form fields
    function findFields(node, depth) {
      if (!node) return;
      const roles = ['textbox', 'combobox', 'checkbox', 'radio', 'button', 'listbox'];
      if (roles.includes(node.role)) {
        console.log('  '.repeat(depth) + node.role + ': ' + (node.name || '(unnamed)'));
      }
      if (node.role === 'heading') {
        console.log('\n' + '  '.repeat(depth) + '=== ' + node.name + ' ===');
      }
      if (node.children) {
        for (const child of node.children) findFields(child, depth);
      }
    }
    findFields(snap, 0);
  }

  // Keep browser open so user can see
  console.log('\nKeeping browser open for 15 more seconds...');
  await page.waitForTimeout(15000);
  await context.close();
  console.log('Done');
})().catch(e => console.error('Error:', e.message));
