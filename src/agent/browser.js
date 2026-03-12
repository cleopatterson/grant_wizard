const { chromium } = require('playwright');
const EventEmitter = require('events');

class BrowserAgent extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page = null;
    this.ready = false;
  }

  async start(portalType) {
    this.emit('step', { action: 'opening_browser', detail: 'Launching Chromium' });

    // SmartyGrants SSO (login.smartyfile.com.au) detects basic headless browsers.
    // Use stealth-like args to look like a real browser session.
    const envHeadless = process.env.HEADLESS !== 'false';
    const needsStealth = portalType === 'smartygrants';

    this.browser = await chromium.launch({
      headless: envHeadless,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(envHeadless ? ['--headless=new'] : []),
      ],
    });

    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-AU',
    });

    this.page = await context.newPage();

    // Remove navigator.webdriver flag that SSO providers check
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    this.page.setDefaultTimeout(60000);
    this.ready = true;
    this.emit('step', { action: 'browser_ready', detail: 'Chromium ready' });
  }

  async navigate(url) {
    this.emit('step', { action: 'navigating', detail: url });
    await this.page.goto(url);
    await this._delay(2000);
  }

  async navigateFluxxToApplication(grantName) {
    this.emit('step', { action: 'fluxx_nav', detail: 'Looking for "Apply for a Grant" in left menu' });

    try {
      // Click "Apply for a Grant" in the left navigation
      const applyLink = this.page.locator('a:has-text("Apply for a Grant"), a:has-text("Apply for a grant"), a:has-text("Apply")').first();
      await applyLink.waitFor({ state: 'visible', timeout: 10000 });
      await applyLink.click();
      await this._delay(3000);

      this.emit('step', { action: 'fluxx_nav', detail: 'Scrolling to find the right grant category' });

      // Scroll down to find the right application category
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await this._delay(1000);

      // Look for "Apply to International Performance and Touring" or similar green buttons
      // Try specific button text matches first, then broader matches
      const applyButtons = [
        'Apply to International Performance and Touring',
        'Apply to International Professional and Artistic Development',
        'Apply to International Market and Audience Development',
      ];

      // Determine which button to click based on grant name
      let targetBtn = null;
      const grantLower = (grantName || '').toLowerCase();

      if (grantLower.includes('touring') || grantLower.includes('performance')) {
        targetBtn = applyButtons[0];
      } else if (grantLower.includes('professional') || grantLower.includes('artistic development')) {
        targetBtn = applyButtons[1];
      } else if (grantLower.includes('market') || grantLower.includes('audience')) {
        targetBtn = applyButtons[2];
      } else {
        // Default to first (International Performance and Touring)
        targetBtn = applyButtons[0];
      }

      this.emit('step', { action: 'fluxx_nav', detail: `Looking for: ${targetBtn}` });

      const btn = this.page.locator(`a:has-text("${targetBtn}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await this._delay(4000);
        this.emit('step', { action: 'fluxx_nav', detail: `Clicked: ${targetBtn}` });
      } else {
        // Fallback: click any green apply button
        const anyApply = this.page.locator('a:has-text("Apply to")').first();
        if (await anyApply.isVisible().catch(() => false)) {
          const text = await anyApply.textContent().catch(() => 'Apply');
          await anyApply.click();
          await this._delay(4000);
          this.emit('step', { action: 'fluxx_nav', detail: `Clicked fallback: ${text}` });
        }
      }

      this.emit('step', { action: 'fluxx_nav', detail: `Now at: ${this.page.url()}` });
    } catch (e) {
      this.emit('step', { action: 'fluxx_nav_error', detail: e.message });
      // Continue anyway — readFormFields will capture whatever is on screen
    }
  }

  async navigateSmartyGrantsToForm(appUrl, grantName) {
    this.emit('step', { action: 'smartygrants_nav', detail: 'Looking for application form' });

    // Strategy 1: Try the direct application URL if we have one
    if (appUrl) {
      this.emit('step', { action: 'smartygrants_nav', detail: `Navigating to ${appUrl}` });
      await this.page.goto(appUrl);
      await this._delay(3000);

      const url = this.page.url();
      const title = await this.page.title();
      this.emit('step', { action: 'smartygrants_nav', detail: `Landed on: ${title} (${url})` });

      // If we ended up on the form, we're good
      if (url.includes('/form/') || url.includes('/continue/')) {
        return;
      }
    }

    // Strategy 2: Look for "Continue" or "Apply" links on the dashboard
    this.emit('step', { action: 'smartygrants_nav', detail: 'Searching dashboard for application links' });

    // Try "Continue Application" buttons/links first (means a draft exists)
    const continueLink = this.page.locator('a:has-text("Continue"), a:has-text("Resume"), a:has-text("Edit")').first();
    if (await continueLink.isVisible().catch(() => false)) {
      this.emit('step', { action: 'smartygrants_nav', detail: 'Found Continue link — clicking' });
      await continueLink.click();
      await this._delay(3000);
      return;
    }

    // Try "Apply Now" or "Start Application" links
    const applyLink = this.page.locator('a:has-text("Apply Now"), a:has-text("Start Application"), a:has-text("Apply")').first();
    if (await applyLink.isVisible().catch(() => false)) {
      this.emit('step', { action: 'smartygrants_nav', detail: 'Found Apply link — clicking' });
      await applyLink.click();
      await this._delay(3000);
      return;
    }

    // Strategy 3: Look for the grant by name in the page
    if (grantName) {
      const grantLink = this.page.locator(`a:has-text("${grantName.split('—').pop().trim()}")`).first();
      if (await grantLink.isVisible().catch(() => false)) {
        this.emit('step', { action: 'smartygrants_nav', detail: `Found grant link: ${grantName}` });
        await grantLink.click();
        await this._delay(3000);
        return;
      }
    }

    // Strategy 4: Go to portal homepage and look for the grant in listed rounds
    try {
      const currentUrl = this.page.url();
      const baseUrl = currentUrl.match(/^https?:\/\/[^/]+/)?.[0];
      if (baseUrl) {
        this.emit('step', { action: 'smartygrants_nav', detail: 'Checking portal homepage for open rounds' });
        await this.page.goto(baseUrl);
        await this._delay(3000);

        // List all round links on the homepage
        const roundLinks = await this.page.evaluate(() => {
          return [...document.querySelectorAll('a[href]')]
            .filter(a => a.href.match(/smartygrants\.com\.au\/[A-Za-z0-9]+$/) && !a.href.includes('/applicant'))
            .map(a => ({ text: a.textContent.trim().substring(0, 80), href: a.href }));
        });
        this.emit('step', { action: 'smartygrants_nav', detail: `Found ${roundLinks.length} round links on homepage` });

        // Try to match grant name to a round link
        if (grantName) {
          const keywords = grantName.toLowerCase().split(/[\s—–-]+/).filter(w => w.length > 3);
          const match = roundLinks.find(l => {
            const linkText = l.text.toLowerCase();
            return keywords.some(k => linkText.includes(k));
          });
          if (match) {
            this.emit('step', { action: 'smartygrants_nav', detail: `Matched round: ${match.text}` });
            await this.page.goto(match.href);
            await this._delay(3000);
            // Look for Apply button on the round page
            const applyBtn = this.page.locator('a:has-text("Apply"), a:has-text("Start"), input[value="Apply"]').first();
            if (await applyBtn.isVisible().catch(() => false)) {
              await applyBtn.click();
              await this._delay(3000);
              return;
            }
          }
        }

        // Look for any form link on current page
        const formLink = this.page.locator('a[href*="/form/"], a[href*="/continue/"]').first();
        if (await formLink.isVisible().catch(() => false)) {
          this.emit('step', { action: 'smartygrants_nav', detail: 'Found form link' });
          await formLink.click();
          await this._delay(3000);
          return;
        }
      }
    } catch (e) {}

    this.emit('step', { action: 'smartygrants_nav', detail: 'Could not find application form — grant may not have an open round' });
  }

  async login(portalUrl, email, password, portalType = 'smartygrants') {
    this.emit('step', { action: 'navigating', detail: `Opening ${portalType} login` });

    if (portalType === 'smartygrants') {
      // SmartyGrants uses SSO via login.smartyfile.com.au
      const loginPath = portalUrl.replace(/\/$/, '') + '/applicant/login';
      await this.page.goto(loginPath);
      await this._delay(4000);
    } else {
      // Direct login page (Fluxx, etc.)
      await this.page.goto(portalUrl);
      await this._delay(3000);
    }

    this.emit('step', { action: 'logging_in', detail: `Entering credentials on ${this.page.url().split('/')[2]}` });

    try {
      // Find username/email field
      const emailField = this.page.locator(
        'input[type="email"], input[type="text"][name*="user"], input[name="username"], input[name="email"], input[id="username"], input[id="email"], input[id*="login" i]'
      ).first();
      await emailField.waitFor({ state: 'visible', timeout: 10000 });

      // Find password field
      const passwordField = this.page.locator('input[type="password"]').first();
      await passwordField.waitFor({ state: 'visible', timeout: 5000 });

      await emailField.fill(email);
      await passwordField.fill(password);

      // Find and click submit button
      const submitBtn = this.page.locator(
        'input[type="submit"], button[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In"), button:has-text("Sign in")'
      ).first();
      await submitBtn.click();

      // Wait for login to complete
      await this._delay(6000);

      const currentUrl = this.page.url();
      this.emit('step', { action: 'login_redirect', detail: `Now at: ${currentUrl}` });

      // Check if we're still on a login page
      if (currentUrl.includes('login.smartyfile') || currentUrl.includes('user_sessions/new') || currentUrl.includes('/login')) {
        throw new Error('Login may have failed — still on login page');
      }

      this.emit('step', { action: 'logged_in', detail: 'Successfully logged in' });
      return true;
    } catch (e) {
      this.emit('step', { action: 'login_error', detail: e.message });
      throw e;
    }
  }

  async readFormFields() {
    this.emit('step', { action: 'reading_fields', detail: 'Reading accessibility tree' });

    // Auto-accept any JS dialogs (confirm, alert, prompt) throughout form reading
    this.page.on('dialog', async dialog => {
      this.emit('step', { action: 'dialog', detail: `Auto-accepting: "${dialog.message()}"` });
      await dialog.accept();
    });

    const allFields = [];
    const seenPageSignatures = new Set();
    let pageNum = 1;

    while (true) {
      try {
        // Wait for page to be stable after any navigation
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this._delay(1500);

        const title = await this.page.title();
        this.emit('step', { action: 'reading_page', detail: `Page ${pageNum}: ${title}` });

        // Skip review/summary pages — try to navigate past them
        if (/review|summary|confirm/i.test(title)) {
          this.emit('step', { action: 'review_page', detail: `Page ${pageNum}: Review/summary page detected` });

          // For SmartyGrants, the review page is at /form/ID/review
          // The actual application pages continue at /form/ID/continue/N
          const currentUrl = this.page.url();
          const formMatch = currentUrl.match(/\/form\/(\d+)\//);
          if (formMatch) {
            // Try navigating to the next continue page directly
            const baseUrl = currentUrl.split('/form/')[0];
            const nextUrl = `${baseUrl}/form/${formMatch[1]}/continue/${pageNum + 1}`;
            this.emit('step', { action: 'review_skip', detail: `Navigating past review to: ${nextUrl}` });
            try {
              await this.page.goto(nextUrl);
              await this._delay(3000);
              const newTitle = await this.page.title();
              const newUrl = this.page.url();
              this.emit('step', { action: 'post_review', detail: `Landed on: ${newTitle} (${newUrl})` });
              // If we're still on review or got redirected back, we've reached the end
              if (newUrl.includes('/review') || /review|summary|confirm/i.test(newTitle)) {
                this.emit('step', { action: 'review_end', detail: 'Still on review page — no more pages' });
                break;
              }
              pageNum++;
              continue;
            } catch (e) {
              this.emit('step', { action: 'review_nav_error', detail: e.message });
            }
          }
          // If URL navigation didn't work, we've reached the end
          break;
        }

        await this.page.evaluate(() => window.scrollTo(0, 0));
        await this._delay(1000);

        const snap = await this.page.accessibility.snapshot();
        if (!snap) break;

        const pageFields = this._extractFields(snap, pageNum);
        this.emit('step', { action: 'fields_found', detail: `Page ${pageNum}: ${pageFields.length} fields` });

        // Detect eligibility screening pages (only radio buttons, no text fields)
        const hasTextFields = pageFields.some(f => f.type === 'text' || f.type === 'textarea');
        const onlyRadios = pageFields.length > 0 && pageFields.every(f => f.type === 'radio' || f.type === 'checkbox');

        if (onlyRadios && !hasTextFields) {
          // This is an eligibility/screening page — auto-answer and advance
          this.emit('step', { action: 'eligibility_page', detail: `Page ${pageNum}: Auto-answering ${pageFields.length} radio buttons` });
          await this._autoAnswerEligibility(pageFields);
          await this._delay(2000);
        } else {
          // Real application fields — replace raw radios with properly labelled radio groups
          const nonRadioFields = pageFields.filter(f => f.type !== 'radio');
          const radioGroups = await this._extractRadioGroups(pageNum);

          // Merge: non-radio fields + radio groups (with proper question labels)
          const mergedFields = [...nonRadioFields, ...radioGroups];

          await this._enrichDropdownOptions(mergedFields);
          await this._captureElementIds(mergedFields);

          // Deduplicate: skip pages that have identical field labels to ones already collected
          const newSignature = mergedFields.map(f => f.label).sort().join('|');
          if (!seenPageSignatures.has(newSignature)) {
            seenPageSignatures.add(newSignature);
            allFields.push(...mergedFields);
          } else {
            this.emit('step', { action: 'dedup', detail: `Page ${pageNum}: Skipping duplicate fields` });
          }
        }

        // Try to advance to next page
        let advanced = await this._tryAdvancePage(pageNum);

        if (!advanced) break;

        await this._delay(2500);
        pageNum++;
        if (pageNum > 30) break;
      } catch (e) {
        // Navigation can destroy context mid-read — wait and retry once
        this.emit('step', { action: 'page_error', detail: `Page ${pageNum}: ${e.message} — waiting for page to settle` });
        await this._delay(3000);
        try {
          await this.page.waitForLoadState('domcontentloaded');
          // Retry this page
          continue;
        } catch (e2) {
          this.emit('step', { action: 'page_error', detail: `Could not recover: ${e2.message}` });
          break;
        }
      }
    }

    return allFields;
  }

  // Auto-answer eligibility screening radio buttons using DOM-based grouping
  async _autoAnswerEligibility(fields) {
    // Read radio button groups from the DOM (grouped by `name` attribute)
    const radioGroups = await this.page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      const groups = {};
      for (const r of radios) {
        const name = r.getAttribute('name') || 'unknown';
        if (!groups[name]) groups[name] = [];
        // Get the label text for this radio
        const label = r.labels?.[0]?.textContent?.trim() ||
                      r.closest('label')?.textContent?.trim() ||
                      r.nextSibling?.textContent?.trim() || '';
        groups[name].push({ name, value: r.value, label, id: r.id });
      }
      return Object.values(groups);
    });

    this.emit('step', { action: 'eligibility_groups', detail: `${radioGroups.length} question groups found` });

    for (const group of radioGroups) {
      const labels = group.map(g => g.label);
      let selected = null;

      // Yes/No question: always pick Yes
      const yesOpt = group.find(g => /^yes$/i.test(g.label));
      const noOpt = group.find(g => /^no$/i.test(g.label));
      if (yesOpt && noOpt && group.length === 2) {
        selected = yesOpt;
      }
      // Multi-option: pick best match
      else {
        // Prefer "artist or act to tour" for touring grants
        selected = group.find(g => /tour/i.test(g.label));
        // Prefer "Artist" over "Act"
        if (!selected) selected = group.find(g => /^artist$/i.test(g.label));
        // Prefer "Domestic"
        if (!selected) selected = group.find(g => /^domestic$/i.test(g.label));
        // Fallback to first option
        if (!selected) selected = group[0];
      }

      if (selected) {
        try {
          // Click the radio via page.evaluate using the ID
          const clicked = await this.page.evaluate((sel) => {
            const el = sel.id ? document.getElementById(sel.id)
              : document.querySelector(`input[type="radio"][name="${sel.name}"][value="${sel.value}"]`);
            if (el) { el.click(); return true; }
            return false;
          }, selected);
          if (clicked) {
            this.emit('step', { action: 'eligibility_answer', detail: `Q: [${labels.join(' / ')}] → ${selected.label}` });
          } else {
            this.emit('step', { action: 'eligibility_error', detail: `Could not find radio for: ${selected.label}` });
          }
          await this._delay(500);
        } catch (e) {
          this.emit('step', { action: 'eligibility_error', detail: `Failed to click ${selected.label}: ${e.message}` });
        }
      }
    }
  }

  async _tryAdvancePage(pageNum) {
    // Accept any JS confirmation dialogs (e.g. "Are you sure you want to submit?")
    this.page.once('dialog', async dialog => {
      this.emit('step', { action: 'dialog', detail: `Accepting dialog: ${dialog.message()}` });
      await dialog.accept();
    });

    // Try various "next" button patterns
    const selectors = [
      'input[value="Next Page"]',
      'button:has-text("Next Page")',
      'input[value="Submit"]',
      'button:has-text("Submit")',
      'input[type="button"][value="Submit"]',
      'input[value="Continue"]',
      'button:has-text("Continue")',
      'input[value="Next"]',
      'button:has-text("Next")',
    ];

    for (const sel of selectors) {
      try {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          this.emit('step', { action: 'clicking', detail: `Clicking: ${sel}` });
          // Use noWaitAfter to avoid hanging on navigation-triggering clicks
          await btn.click({ noWaitAfter: true });
          await this._delay(3000);
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          return true;
        }
      } catch (e) {
        this.emit('step', { action: 'click_error', detail: `${sel}: ${e.message}` });
      }
    }

    // Try direct URL navigation (SmartyGrants /continue/N pattern)
    const url = this.page.url();
    const match = url.match(/\/continue\/(\d+)/);
    if (match) {
      const nextUrl = url.replace(/\/continue\/\d+/, `/continue/${parseInt(match[1]) + 1}`).split('?')[0];
      try {
        await this.page.goto(nextUrl);
        await this._delay(2000);
        const newTitle = await this.page.title();
        if (newTitle.includes('Page') && !newTitle.includes(`Page ${pageNum} `)) {
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  _extractFields(snapshot, pageNum) {
    const fields = [];
    let currentSection = 'General';
    let fieldId = 0;
    const skipNames = ['Save Progress', 'Save and Close', 'Next Page', 'Previous Page', 'Clear the selected value'];
    const seenRadioNames = new Set(); // Track radio groups we've already added

    const walk = (node) => {
      if (!node) return;

      if (node.role === 'heading') {
        currentSection = node.name || currentSection;
      }

      // Skip radio buttons here — we'll extract them from the DOM later
      const fieldRoles = ['textbox', 'combobox', 'checkbox', 'listbox'];
      if (fieldRoles.includes(node.role) && node.name && !skipNames.includes(node.name)) {
        fieldId++;

        // Detect field type
        let type = 'text';
        if (node.role === 'textbox') {
          const name = node.name.toLowerCase();
          if (name.includes('descri') || name.includes('biograph') || name.includes('statement') ||
              name.includes('detail') || name.includes('outline') || name.includes('explain')) {
            type = 'textarea';
          }
        } else if (node.role === 'combobox' || node.role === 'listbox') {
          type = 'dropdown';
          if (node.children) {
            const options = node.children
              .filter(c => c.role === 'option' || c.role === 'menuitem' || c.role === 'listitem')
              .map(c => c.name)
              .filter(Boolean);
            if (options.length > 0) {
              node._extractedOptions = options;
            }
          }
        } else if (node.role === 'checkbox') {
          type = 'checkbox';
        }

        const wordLimitMatch = (node.name || '').match(/\((?:max\s+)?(\d+)\s*words?\)/i);
        const charLimitMatch = (node.name || '').match(/\((?:max\s+)?(\d+)\s*char/i);

        fields.push({
          id: fieldId,
          label: node.name,
          type,
          required: node.required || false,
          wordLimit: wordLimitMatch ? parseInt(wordLimitMatch[1], 10) : null,
          charLimit: charLimitMatch ? parseInt(charLimitMatch[1], 10) : null,
          helpText: '',
          currentValue: node.value || '',
          options: node._extractedOptions || null,
          section: currentSection,
          page: pageNum,
        });
      }

      // Still collect radio entries for the "only radios" detection used by eligibility
      if (node.role === 'radio' && node.name && !skipNames.includes(node.name)) {
        fieldId++;
        fields.push({
          id: fieldId,
          label: node.name,
          type: 'radio',
          required: node.required || false,
          section: currentSection,
          page: pageNum,
          options: null,
          helpText: '',
          currentValue: node.value || '',
          wordLimit: null, charLimit: null,
        });
      }

      for (const child of (node.children || [])) walk(child);
    };

    walk(snapshot);
    return fields;
  }

  // Extract radio button groups from the DOM with their question labels
  async _extractRadioGroups(pageNum) {
    const groups = await this.page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      const groupMap = {};
      for (const r of radios) {
        const name = r.getAttribute('name') || 'unknown';
        if (!groupMap[name]) groupMap[name] = { options: [], questionLabel: '' };
        const label = r.labels?.[0]?.textContent?.trim() ||
                      r.closest('label')?.textContent?.trim() ||
                      r.nextSibling?.textContent?.trim() || r.value || '';
        groupMap[name].options.push(label);

        // Try to find the question label (fieldset > legend, or preceding label/heading)
        if (!groupMap[name].questionLabel) {
          const fieldset = r.closest('fieldset');
          if (fieldset) {
            const legend = fieldset.querySelector('legend');
            if (legend) groupMap[name].questionLabel = legend.textContent.trim();
          }
          if (!groupMap[name].questionLabel) {
            // Look for a question div/label preceding the radio group
            const container = r.closest('.question, .form-group, .field-group, [class*="question"]');
            if (container) {
              const qLabel = container.querySelector('label, .question-title, h3, h4, p');
              if (qLabel && !qLabel.querySelector('input')) {
                groupMap[name].questionLabel = qLabel.textContent.trim();
              }
            }
          }
        }
      }
      return Object.entries(groupMap).map(([name, data]) => ({
        name,
        questionLabel: data.questionLabel,
        options: data.options,
      }));
    });

    return groups.map(g => ({
      id: 0, // will be renumbered
      label: g.questionLabel || `Choose: ${g.options.join(' / ')}`,
      type: g.options.length === 2 ? 'radio' : 'select',
      required: false,
      options: g.options,
      helpText: '',
      currentValue: '',
      section: 'General',
      page: pageNum,
      wordLimit: null,
      charLimit: null,
      _radioName: g.name,
    }));
  }

  // Extract actual dropdown options by querying <select> and <option> elements in the DOM
  async _enrichDropdownOptions(fields) {
    try {
      const dropdownData = await this.page.evaluate(() => {
        const results = {};
        // Find all <select> elements
        document.querySelectorAll('select').forEach(sel => {
          const label = sel.getAttribute('aria-label') ||
            sel.closest('label')?.textContent?.trim() ||
            document.querySelector(`label[for="${sel.id}"]`)?.textContent?.trim() ||
            sel.name || '';
          const options = Array.from(sel.options)
            .map(o => o.text.trim())
            .filter(t => t && t !== '' && t !== '-- Please select --' && t !== 'Select...' && t !== 'Please select' && !t.startsWith('--'));
          if (label && options.length > 0) {
            results[label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()] = options;
          }
        });
        return results;
      });

      // Match dropdown fields to their options
      for (const field of fields) {
        if (field.type !== 'dropdown' || field.options) continue;
        const fieldKey = field.label.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        // Try exact match, then partial match
        if (dropdownData[fieldKey]) {
          field.options = dropdownData[fieldKey];
        } else {
          // Partial match — find best overlap
          for (const [key, opts] of Object.entries(dropdownData)) {
            if (fieldKey.includes(key) || key.includes(fieldKey)) {
              field.options = opts;
              break;
            }
          }
        }
      }
    } catch (e) {
      // Non-fatal — we just won't have dropdown options
    }
    return fields;
  }

  // Capture DOM element IDs for each field so we can fill by ID later
  async _captureElementIds(fields) {
    try {
      const domElements = await this.page.evaluate(() => {
        const elements = [];
        // Get all visible input, textarea, select elements
        const inputs = document.querySelectorAll('input, textarea, select');
        for (const el of inputs) {
          if (el.type === 'hidden' || el.type === 'radio' || el.type === 'submit' || el.type === 'button') continue;
          const id = el.id || '';
          const name = el.name || '';
          // Find the label text for this element
          let labelText = '';
          if (el.labels && el.labels.length > 0) {
            labelText = el.labels[0].textContent.trim();
          } else if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) labelText = lbl.textContent.trim();
          }
          if (!labelText) {
            const closest = el.closest('.field-group, .form-group, fieldset, .field');
            if (closest) {
              const lbl = closest.querySelector('label, legend, .label, .field-label');
              if (lbl) labelText = lbl.textContent.trim();
            }
          }
          elements.push({
            id, name, labelText,
            tag: el.tagName.toLowerCase(),
            type: el.type || el.tagName.toLowerCase(),
            cssSelector: el.id ? `#${el.id}` : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : ''),
          });
        }
        return elements;
      });

      // Match scanned fields to DOM elements
      for (const field of fields) {
        if (field.type === 'radio' || field._radioName) continue;
        const cleanLabel = (field.label || '').replace(/\s*\*\s*Required\s*/i, '').trim().toLowerCase();
        // Try to find matching DOM element
        for (const el of domElements) {
          const cleanDomLabel = (el.labelText || '').replace(/\s*\*\s*Required\s*/i, '').trim().toLowerCase();
          if (cleanDomLabel && (cleanDomLabel === cleanLabel || cleanDomLabel.startsWith(cleanLabel) || cleanLabel.startsWith(cleanDomLabel))) {
            field._elementId = el.id;
            field._elementName = el.name;
            field._cssSelector = el.cssSelector;
            break;
          }
        }
      }
    } catch (e) {
      // Non-fatal
    }
  }

  // Navigate to a specific page number in a multi-page form
  async navigateToPage(targetPage) {
    const url = this.page.url();

    // Strategy 1: Direct URL manipulation (SmartyGrants /continue/N pattern)
    const match = url.match(/\/continue\/(\d+)/);
    if (match) {
      const currentPage = parseInt(match[1], 10);
      if (currentPage === targetPage) return;
      const targetUrl = url.replace(/\/continue\/\d+/, `/continue/${targetPage}`).split('?')[0];
      this.emit('step', { action: 'navigating_page', detail: `Jumping to page ${targetPage}` });
      await this.page.goto(targetUrl);
      await this._delay(2000);
      return;
    }

    // Strategy 2: Fluxx — pages are single-page, no navigation needed
    // (Fluxx forms don't use multi-page pagination like SmartyGrants)

    // Strategy 3: Click Previous/Next Page buttons to reach target
    // First go back to page 1 if needed
    if (targetPage === 1) {
      let prevBtn = this.page.locator('input[value="Previous Page"], button:has-text("Previous Page"), a:has-text("Previous Page")').first();
      while (await prevBtn.isVisible().catch(() => false)) {
        await prevBtn.click();
        await this._delay(2000);
        prevBtn = this.page.locator('input[value="Previous Page"], button:has-text("Previous Page"), a:has-text("Previous Page")').first();
      }
      return;
    }

    // Go forward to target page
    for (let p = 1; p < targetPage; p++) {
      const nextBtn = this.page.locator('input[value="Next Page"], button:has-text("Next Page"), a:has-text("Next Page")').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        await this._delay(2000);
      } else {
        break;
      }
    }
  }

  async fillField(field) {
    const matchLabel = field.domLabel || field.label;
    const value = String(field.value || '');
    this.emit('step', { action: 'filling_field', detail: `${field.label} = ${value.substring(0, 50)}` });

    if (!value) return;

    try {
      switch (field.type) {
        case 'text':
        case 'textarea': {
          let filled = false;

          // Strategy 1: Use captured element ID (most reliable)
          if (field._elementId) {
            filled = await this.page.evaluate(({ id, val }) => {
              const el = document.getElementById(id);
              if (!el) return false;
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (nativeSet) nativeSet.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, { id: field._elementId, val: value });
            if (filled) this.emit('step', { action: 'field_filled', detail: `${field.label} (by id)` });
          }

          // Strategy 2: Use captured CSS selector
          if (!filled && field._cssSelector) {
            filled = await this.page.evaluate(({ sel, val }) => {
              const el = document.querySelector(sel);
              if (!el) return false;
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (nativeSet) nativeSet.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }, { sel: field._cssSelector, val: value });
            if (filled) this.emit('step', { action: 'field_filled', detail: `${field.label} (by selector)` });
          }

          // Strategy 3: DOM search by label text (for fields without IDs)
          if (!filled) {
            const cleanLabel = matchLabel.replace(/\s*\*\s*Required\s*/i, '').trim();
            filled = await this.page.evaluate(({ label, val }) => {
              // Search all labels for a text match
              const labels = [...document.querySelectorAll('label')];
              for (const lbl of labels) {
                const lblText = lbl.textContent.replace(/\s*\*\s*Required\s*/gi, '').replace(/\s+/g, ' ').trim();
                if (lblText === label || lblText.includes(label) || label.includes(lblText)) {
                  const forId = lbl.getAttribute('for');
                  const input = forId ? document.getElementById(forId) :
                    lbl.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea');
                  if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
                    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (nativeSet) nativeSet.call(input, val);
                    else input.value = val;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
              }
              return false;
            }, { label: cleanLabel, val: value });
            if (filled) this.emit('step', { action: 'field_filled', detail: `${field.label} (by label search)` });
          }

          // Strategy 4: Playwright role-based fill (last resort, with short timeout)
          if (!filled) {
            try {
              let textbox = this.page.getByRole('textbox', { name: matchLabel }).first();
              if (await textbox.isVisible({ timeout: 3000 }).catch(() => false)) {
                await textbox.fill(value, { timeout: 5000 });
                filled = true;
                this.emit('step', { action: 'field_filled', detail: `${field.label} (by role)` });
              }
            } catch (e) {
              // Timeout — skip
            }
          }

          if (!filled) {
            this.emit('step', { action: 'field_not_found', detail: `${field.label} [id=${field._elementId || 'none'}, sel=${field._cssSelector || 'none'}]` });
          }
          break;
        }
        case 'dropdown': {
          let filled = false;

          // Strategy 1: By captured ID
          if (field._elementId) {
            filled = await this.page.evaluate(({ id, val }) => {
              const sel = document.getElementById(id);
              if (!sel || sel.tagName !== 'SELECT') return false;
              const opt = [...sel.options].find(o => o.text.trim() === val || o.value === val);
              if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
              // Partial match
              const partial = [...sel.options].find(o => o.text.toLowerCase().includes(val.toLowerCase().split('/')[0].trim()));
              if (partial) { sel.value = partial.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
              return false;
            }, { id: field._elementId, val: value });
            if (filled) this.emit('step', { action: 'field_filled', detail: `${field.label} (dropdown by id)` });
          }

          // Strategy 2: Playwright combobox
          if (!filled) {
            let combo = this.page.getByRole('combobox', { name: matchLabel }).first();
            if (await combo.isVisible({ timeout: 3000 }).catch(() => false)) {
              await combo.selectOption({ label: value }).catch(() => {});
              filled = true;
              this.emit('step', { action: 'field_filled', detail: field.label });
            }
          }

          if (!filled) this.emit('step', { action: 'field_not_found', detail: field.label });
          break;
        }
        case 'radio':
        case 'select': {
          // Radio groups extracted from DOM — use _radioName if available
          if (field._radioName) {
            const clicked = await this.page.evaluate((radioName, value) => {
              const radios = [...document.querySelectorAll(`input[type="radio"][name="${radioName}"]`)];
              for (const r of radios) {
                const label = r.labels?.[0]?.textContent?.trim() ||
                  r.closest('label')?.textContent?.trim() || '';
                if (label === value || r.value === value) {
                  r.click();
                  return true;
                }
              }
              return false;
            }, field._radioName, field.value);
            if (clicked) this.emit('step', { action: 'field_filled', detail: `${field.label} → ${field.value}` });
            else this.emit('step', { action: 'field_not_found', detail: `Radio ${field.label}` });
          } else {
            // Fallback: try by role
            const radio = this.page.getByRole('radio', { name: field.value });
            if (await radio.isVisible().catch(() => false)) {
              await radio.click();
              this.emit('step', { action: 'field_filled', detail: `${field.label} → ${field.value}` });
            } else {
              this.emit('step', { action: 'field_not_found', detail: `Radio ${field.label}` });
            }
          }
          break;
        }
        case 'checkbox': {
          let checkbox = this.page.getByRole('checkbox', { name: matchLabel });
          if (!await checkbox.isVisible().catch(() => false) && field.domLabel) {
            checkbox = this.page.getByRole('checkbox', { name: field.label });
          }
          if (await checkbox.isVisible().catch(() => false)) {
            const checked = await checkbox.isChecked().catch(() => false);
            if (!checked) await checkbox.click();
            this.emit('step', { action: 'field_filled', detail: field.label });
          } else {
            this.emit('step', { action: 'field_not_found', detail: `Checkbox ${field.label}` });
          }
          break;
        }
      }
    } catch (e) {
      this.emit('step', { action: 'fill_error', detail: `${field.label}: ${e.message}` });
    }

    await this._delay(300 + Math.random() * 400);
  }

  // Click "Next Page" button — returns true if advanced
  async clickNextPage() {
    const selectors = [
      'input[value="Next Page"]',
      'button:has-text("Next Page")',
      'input[value="Save and Continue"]',
      'button:has-text("Save and Continue")',
    ];
    for (const sel of selectors) {
      try {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ noWaitAfter: true });
          await this._delay(2000);
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async clickSaveDraft() {
    try {
      const saveBtn = this.page.locator('input[value="Save Progress"], button:has-text("Save Progress"), input[value="Save and Close"]').first();
      if (await saveBtn.isVisible().catch(() => false)) {
        this.emit('step', { action: 'saving', detail: 'Clicking Save Progress' });
        await saveBtn.click({ noWaitAfter: true });
        await this._delay(3000);
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    } catch (e) {}
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async stop() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
    this.ready = false;
  }
}

module.exports = BrowserAgent;
