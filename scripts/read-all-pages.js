const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  // Go to the form (will redirect to login)
  await page.goto('https://soundnsw.smartygrants.com.au/form/15030850/continue/1');
  await page.waitForTimeout(3000);
  console.log('On login page:', await page.title());

  // Auto-fill login
  const emailField = page.getByRole('textbox', { name: 'Email:' });
  const passwordField = page.getByRole('textbox', { name: 'Password:' });

  await emailField.fill(process.env.SG_EMAIL || '');
  await passwordField.fill(process.env.SG_PASSWORD || '');
  console.log('Credentials entered, clicking Log In...');

  await page.getByRole('button', { name: 'Log In' }).click();
  await page.waitForTimeout(5000);

  console.log('After login — Title:', await page.title());
  console.log('URL:', page.url());

  // Check if we're past login
  const title = await page.title();
  if (title.includes('Login')) {
    console.log('Login may have failed. Check the browser window.');
    await page.waitForTimeout(30000);
    await browser.close();
    return;
  }

  const allFields = [];
  let pageNum = 1;

  while (true) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PAGE ${pageNum}: ${await page.title()}`);
    console.log('='.repeat(60));

    const snap = await page.accessibility.snapshot();
    if (snap) {
      require('fs').writeFileSync(`/tmp/smartygrants-page-${pageNum}.json`, JSON.stringify(snap, null, 2));

      let currentSection = 'General';
      function findFields(node) {
        if (!node) return;
        if (node.role === 'heading') {
          currentSection = node.name || currentSection;
          console.log(`\n  [${currentSection}]`);
        }

        const fieldRoles = ['textbox', 'combobox', 'checkbox', 'radio', 'listbox'];
        const skipNames = ['Save Progress', 'Save and Close', 'Next Page', 'Previous Page', 'Clear the selected value'];
        if (fieldRoles.includes(node.role) && node.name && !skipNames.includes(node.name)) {
          allFields.push({
            page: pageNum, section: currentSection, role: node.role,
            name: node.name, value: node.value || '', required: node.required || false,
          });
          console.log(`  [${node.role}] ${node.name}${node.required ? ' *' : ''}${node.value ? ' = "' + String(node.value).substring(0, 80) + '"' : ''}`);
        }

        for (const child of (node.children || [])) findFields(child);
      }
      findFields(snap);
    }

    // Navigate to next page
    let advanced = false;

    // Method 1: click Next Page button
    try {
      const btns = await page.locator('input[value="Next Page"], button:has-text("Next Page")').all();
      for (const btn of btns) {
        if (await btn.isVisible()) {
          await btn.click();
          advanced = true;
          console.log('\n  >>> Clicked Next Page');
          break;
        }
      }
    } catch (e) {}

    // Method 2: direct URL navigation
    if (!advanced) {
      const url = page.url();
      const match = url.match(/\/continue\/(\d+)/);
      if (match) {
        const nextUrl = url.replace(/\/continue\/\d+/, `/continue/${parseInt(match[1]) + 1}`).split('?')[0];
        console.log('\n  >>> Trying direct nav:', nextUrl);
        await page.goto(nextUrl);
        await page.waitForTimeout(2000);
        const newTitle = await page.title();
        if (newTitle.includes('Page') && !newTitle.includes(`Page ${pageNum} `)) {
          advanced = true;
        } else if (newTitle.includes('Page')) {
          // Might be same page number text but different content — check URL
          if (page.url().includes(`/continue/${parseInt(match[1]) + 1}`)) {
            advanced = true;
          }
        }
      }
    }

    if (!advanced) {
      console.log('\n  >>> End of form.');
      break;
    }

    await page.waitForTimeout(2000);
    pageNum++;
    if (pageNum > 20) break;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`DONE: ${allFields.length} fields across ${pageNum} pages`);
  console.log('='.repeat(60));

  require('fs').writeFileSync('/tmp/smartygrants-all-fields.json', JSON.stringify(allFields, null, 2));

  console.log('\nAll fields:');
  allFields.forEach((f, i) => {
    console.log(`  ${i + 1}. [P${f.page}] (${f.section}) ${f.name} [${f.role}]${f.required ? ' *' : ''}`);
  });

  console.log('\nBrowser open for 20s...');
  await page.waitForTimeout(20000);
  await browser.close();
  console.log('Done');
})().catch(e => console.error('Error:', e.message));
