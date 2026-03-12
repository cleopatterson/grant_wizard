const EventEmitter = require('events');
const BrowserAgent = require('./browser');
const { classifyFields } = require('./classifier');
const { buildPreFillPlan, generateContent, generateFromHelp } = require('./prefiller');

class WizardOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.state = {
      step: 'idle',
      grant: null,
      fields: [],
      scanProgress: [],
      fillProgress: { current: 0, total: 0, currentField: null },
      error: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  _setState(updates) {
    Object.assign(this.state, updates);
    this.emit('state', this.getState());
  }

  _emitProgress(type, data) {
    this.emit('progress', { type, ...data });
  }

  // ─── Step 1: Select grant ───
  selectGrant(grant) {
    this._setState({ grant, step: 'selected' });
  }

  // ─── Step 2: Connect and scan ───
  async connectAndScan(credentials) {
    const { grant } = this.state;
    if (!grant) throw new Error('No grant selected');

    this._setState({ step: 'scanning', scanProgress: [], error: null });

    const steps = [
      { label: 'Opening browser', icon: '🌐' },
      { label: `Logging into ${grant.portal || 'portal'}`, icon: '🔑' },
      { label: 'Navigating to application form', icon: '📄' },
      { label: 'Reading fields across pages', icon: '👁' },
      { label: 'Classifying questions', icon: '🧠' },
      { label: 'Matching to your profile', icon: '✨' },
      { label: 'Writing draft answers', icon: '✍️' },
    ];

    const completedSteps = [];

    try {
      // Step 1: Open browser
      this._emitProgress('scan_step', { stepIndex: 0, steps });
      this.browser = new BrowserAgent();

      this.browser.on('step', (s) => {
        this._emitProgress('browser_action', s);
      });

      const portalType = grant.portalType || grant.portal_type || 'smartygrants';
      await this.browser.start(portalType);
      completedSteps.push(0);
      this._emitProgress('scan_step_done', { stepIndex: 0, steps });

      // Step 2: Login
      this._emitProgress('scan_step', { stepIndex: 1, steps });

      // Determine URLs and portal type
      const loginUrl = grant.loginUrl || grant.login_url || null;
      const appUrl = grant.applicationUrl || grant.application_url || null;
      const fallbackUrl = grant.url;

      if (credentials && credentials.email && loginUrl) {
        // Log in at the portal login page
        await this.browser.login(loginUrl, credentials.email, credentials.password, portalType);
        // Navigate to the actual application form if separate from login
        if (appUrl) {
          await this.browser.navigate(appUrl);
        }
      } else if (appUrl) {
        await this.browser.navigate(appUrl);
      } else if (fallbackUrl) {
        await this.browser.navigate(fallbackUrl);
      }
      completedSteps.push(1);
      this._emitProgress('scan_step_done', { stepIndex: 1, steps });

      // Step 3: Navigate to form
      this._emitProgress('scan_step', { stepIndex: 2, steps });

      if (portalType === 'fluxx' || portalType === 'creative_australia') {
        await this.browser.navigateFluxxToApplication(grant.name);
      } else if (portalType === 'smartygrants') {
        await this.browser.navigateSmartyGrantsToForm(appUrl, grant.name);
      } else {
        await this._delay(1500);
      }
      completedSteps.push(2);
      this._emitProgress('scan_step_done', { stepIndex: 2, steps });

      // Step 4: Read fields
      this._emitProgress('scan_step', { stepIndex: 3, steps });
      let rawFields = await this.browser.readFormFields();

      if (!rawFields || rawFields.length === 0) {
        this._emitProgress('warning', { message: 'No form fields detected — the browser may not have reached the application form' });
      }

      // Log raw fields for debugging
      console.log('\n=== RAW FIELDS ===');
      rawFields.forEach((f, i) => {
        console.log(`  [${i}] type=${f.type} label="${f.label}" options=${f.options ? f.options.join(', ') : 'none'}`);
      });
      console.log('=== END RAW FIELDS ===\n');
      completedSteps.push(3);
      this._emitProgress('scan_step_done', { stepIndex: 3, steps, fieldCount: rawFields.length });

      // Step 5: Classify
      this._emitProgress('scan_step', { stepIndex: 4, steps });
      let classifiedFields;
      try {
        classifiedFields = await classifyFields(rawFields);
      } catch (err) {
        console.warn('LLM classifier failed, using heuristic fallback:', err.message);
        // Fallback: use heuristic classification with proper strategy/key from CLASSIFICATION_TYPES
        const { CLASSIFICATION_TYPES } = require('./classifier');
        classifiedFields = rawFields.map(f => {
          const ct = this._heuristicClassify(f);
          const typeInfo = CLASSIFICATION_TYPES[ct] || CLASSIFICATION_TYPES.unknown;
          return {
            ...f,
            classifiedType: ct,
            confidence: 0.7,
            preFillStrategy: typeInfo.strategy,
            preFillKey: typeInfo.key,
          };
        });
      }
      completedSteps.push(4);
      this._emitProgress('scan_step_done', { stepIndex: 4, steps });

      // Log classification results
      console.log('\n=== CLASSIFIED FIELDS ===');
      classifiedFields.forEach((f, i) => {
        console.log(`  [${i}] "${f.label}" → ${f.classifiedType} (${f.preFillStrategy}) conf=${f.confidence}`);
      });
      console.log('=== END CLASSIFIED ===\n');

      // Post-classification cleanup
      classifiedFields = this._cleanupFields(classifiedFields);

      // Step 6: Match to profile
      this._emitProgress('scan_step', { stepIndex: 5, steps });
      const plannedFields = buildPreFillPlan(classifiedFields);
      completedSteps.push(5);
      this._emitProgress('scan_step_done', { stepIndex: 5, steps });

      // Step 7: Ready — skip blocking generation, it happens in background
      this._emitProgress('scan_step', { stepIndex: 6, steps });
      completedSteps.push(6);
      this._emitProgress('scan_step_done', { stepIndex: 6, steps });

      const autoCount = plannedFields.filter(f => f.status === 'auto').length;
      const needsCount = plannedFields.filter(f => f.status === 'needs_input').length;
      const templateCount = plannedFields.filter(f => f.status === 'template').length;
      const readyCount = plannedFields.filter(f => f.status === 'ready').length;

      this._setState({
        step: 'review',
        fields: plannedFields,
      });

      this._emitProgress('scan_complete', {
        totalFields: plannedFields.length,
        autoCount,
        needsCount,
        templateCount,
        readyCount,
      });

      return plannedFields;
    } catch (error) {
      this._setState({ step: 'error', error: error.message });
      this._emitProgress('error', { message: error.message });
      throw error;
    }
  }

  // ─── Step 3: Update field during review ───
  updateField(fieldId, updates) {
    const fields = this.state.fields.map(f => {
      if (f.id === fieldId) {
        const updated = { ...f, ...updates };
        if (updates.value !== undefined) {
          updated.wordCount = updates.value.split(/\s+/).filter(Boolean).length;
          if (updates.value) updated.status = 'auto';
        }
        return updated;
      }
      return f;
    });
    this._setState({ fields });
    return fields.find(f => f.id === fieldId);
  }

  // ─── Step 3a+: Background generate all long-form fields ───
  async generateAllLongFields(onFieldDone) {
    const grantContext = this.state.grant
      ? `Grant: ${this.state.grant.name}\nBody: ${this.state.grant.body || ''}\nDescription: ${this.state.grant.description || ''}`
      : '';

    // Generate for all fields that don't already have values (except file uploads and skipped)
    const fieldsToGenerate = this.state.fields.filter(f =>
      !f.value && f.status !== 'skip' && f.type !== 'file' && f.classifiedType !== 'fileUpload'
    );

    // Process in parallel batches of 4
    for (let i = 0; i < fieldsToGenerate.length; i += 4) {
      const batch = fieldsToGenerate.slice(i, i + 4);
      await Promise.all(batch.map(async (field) => {
        try {
          const content = await generateContent(field, grantContext, this.state.fields);
          this.updateField(field.id, { value: content, status: 'auto' });
          if (onFieldDone) onFieldDone(field.id, content);
        } catch (err) {
          if (onFieldDone) onFieldDone(field.id, null, err.message);
        }
      }));
    }
  }

  // ─── Step 3b: Generate content for a field ───
  async generateFieldContent(fieldId) {
    const field = this.state.fields.find(f => f.id === fieldId);
    if (!field) throw new Error('Field not found');

    const grantContext = this.state.grant
      ? `Grant: ${this.state.grant.name}\nBody: ${this.state.grant.body || ''}\nDescription: ${this.state.grant.description || ''}`
      : '';

    const content = await generateContent(field, grantContext, this.state.fields);
    return this.updateField(fieldId, { value: content, status: 'auto' });
  }

  // ─── Step 3c: Generate from help modal answers ───
  async generateFromHelpAnswers(fieldId, helpAnswers) {
    const field = this.state.fields.find(f => f.id === fieldId);
    if (!field) throw new Error('Field not found');

    const grantContext = this.state.grant
      ? `Grant: ${this.state.grant.name}\nBody: ${this.state.grant.body || ''}\nDescription: ${this.state.grant.description || ''}`
      : '';

    const content = await generateFromHelp(field, helpAnswers, grantContext);
    return this.updateField(fieldId, { value: content, status: 'auto' });
  }

  // ─── Step 4: Fill the form ───
  async fillForm() {
    const fields = this.state.fields.filter(
      f => f.value && f.status !== 'skip'
    );

    this._setState({
      step: 'filling',
      fillProgress: { current: 0, total: fields.length, currentField: null },
    });

    // Group fields by page for multi-page navigation
    const fieldsByPage = {};
    for (const field of fields) {
      const page = field.page || 1;
      if (!fieldsByPage[page]) fieldsByPage[page] = [];
      fieldsByPage[page].push(field);
    }
    const pages = Object.keys(fieldsByPage).map(Number).sort((a, b) => a - b);
    const portalType = this.state.grant?.portalType || this.state.grant?.portal_type || 'smartygrants';

    // For SmartyGrants: navigate to page 1 first (review page redirects break /continue/N)
    // Then walk forward through pages filling as we go
    let filledCount = 0;
    let currentBrowserPage = 0;

    if (this.browser && this.browser.ready && portalType === 'smartygrants') {
      // Go to page 1 to reset position
      const url = this.browser.page.url();
      const formMatch = url.match(/\/form\/(\d+)\//);
      if (formMatch) {
        const baseUrl = url.split('/form/')[0];
        const startUrl = `${baseUrl}/form/${formMatch[1]}/continue/1`;
        this._emitProgress('fill_navigating', { page: 1, detail: 'Returning to page 1' });
        await this.browser.page.goto(startUrl);
        await this._delay(2000);
        currentBrowserPage = 1;
      }
    } else if (this.browser && this.browser.ready && pages.length > 0) {
      await this.browser.navigateToPage(pages[0]);
      await this._delay(2000);
      currentBrowserPage = pages[0];
    }

    for (let pi = 0; pi < pages.length; pi++) {
      const page = pages[pi];
      const pageFields = fieldsByPage[page];

      // Navigate forward to the target page
      if (this.browser && this.browser.ready && currentBrowserPage < page) {
        this._emitProgress('fill_navigating', { page, totalPages: pages.length });

        while (currentBrowserPage < page) {
          const title = await this.browser.page.title().catch(() => '');
          if (/review|summary/i.test(title)) {
            // On a review page — navigate past it using direct URL
            const url = this.browser.page.url();
            const formMatch = url.match(/\/form\/(\d+)\//);
            if (formMatch) {
              const baseUrl = url.split('/form/')[0];
              const nextUrl = `${baseUrl}/form/${formMatch[1]}/continue/${currentBrowserPage + 1}`;
              await this.browser.page.goto(nextUrl);
              await this._delay(2000);
              currentBrowserPage++;
            } else {
              break;
            }
          } else {
            const advanced = await this.browser.clickNextPage();
            if (!advanced) break;
            await this._delay(2000);
            currentBrowserPage++;
          }
        }
        await this._delay(1000);
      }

      // Debug: check what page we're actually on
      if (this.browser && this.browser.ready) {
        const pageInfo = await this.browser.page.evaluate(() => {
          const title = document.title;
          const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=radio]), textarea, select')];
          return {
            title: title.substring(0, 80),
            url: location.href,
            inputCount: inputs.length,
            firstIds: inputs.slice(0, 5).map(i => ({ id: i.id, name: i.name, tag: i.tagName })),
          };
        }).catch(() => ({ title: 'error', url: 'error', inputCount: 0, firstIds: [] }));
        this._emitProgress('fill_navigating', {
          page,
          detail: `On: ${pageInfo.title} (${pageInfo.inputCount} inputs, url: ...${pageInfo.url.slice(-30)})`,
        });
      }

      // Fill all fields on this page
      for (const field of pageFields) {
        this._setState({
          fillProgress: { current: filledCount, total: fields.length, currentField: field.label },
        });

        this._emitProgress('fill_field', {
          fieldIndex: filledCount,
          total: fields.length,
          label: field.label,
          page,
          status: 'typing',
        });

        if (this.browser && this.browser.ready) {
          try {
            await this.browser.fillField(field);
          } catch (err) {
            this._emitProgress('fill_field_error', {
              fieldIndex: filledCount,
              label: field.label,
              error: err.message,
            });
          }
        }

        await this._delay(600 + Math.random() * 400);

        this._emitProgress('fill_field', {
          fieldIndex: filledCount,
          total: fields.length,
          label: field.label,
          page,
          status: 'done',
        });

        filledCount++;
      }

      // After filling a page, save progress
      if (this.browser && this.browser.ready) {
        await this.browser.clickSaveDraft();
      }
    }

    this._setState({
      step: 'complete',
      fillProgress: { current: fields.length, total: fields.length, currentField: null },
    });

    this._emitProgress('fill_complete', {
      totalFilled: fields.length,
      autoFilled: fields.filter(f => f.preFillStrategy === 'profile_lookup' || f.preFillStrategy === 'profile_match').length,
      aiGenerated: fields.filter(f => ['generate', 'template'].includes(f.preFillStrategy)).length,
      filesUploaded: fields.filter(f => f.type === 'file').length,
    });
  }

  // ─── Build fields from grant database data when no browser ───
  _buildFieldsFromGrantData(grant) {
    // Standard SmartyGrants fields for Australian music grants
    return [
      { id: 1, label: 'Applicant Name', type: 'text', section: 'About You', page: 1, required: true },
      { id: 2, label: 'Email Address', type: 'text', section: 'About You', page: 1, required: true },
      { id: 3, label: 'ABN', type: 'text', section: 'About You', page: 1 },
      { id: 4, label: 'Primary Art Form', type: 'dropdown', section: 'About You', page: 1 },
      { id: 5, label: 'Brief Biography', type: 'textarea', section: 'About You', page: 1, wordLimit: 200 },
      { id: 6, label: 'Are you a NSW resident?', type: 'radio', section: 'About You', page: 1 },
      { id: 7, label: 'Describe the proposed activity', type: 'textarea', section: 'Project Details', page: 2, wordLimit: 500 },
      { id: 8, label: 'Proposed dates', type: 'text', section: 'Project Details', page: 2 },
      { id: 9, label: 'How will this activity benefit your career?', type: 'textarea', section: 'Project Details', page: 2, wordLimit: 300 },
      { id: 10, label: 'Total project budget ($)', type: 'text', section: 'Budget', page: 3 },
      { id: 11, label: 'Amount requested ($)', type: 'text', section: 'Budget', page: 3 },
      { id: 12, label: 'Upload support material (PDF)', type: 'file', section: 'Support Material', page: 3 },
    ];
  }

  _cleanupFields(fields) {
    const cleaned = [];

    // Group consecutive checkboxes into a single multi-select question
    let i = 0;
    while (i < fields.length) {
      const f = fields[i];

      // Detect runs of checkboxes (multi-select groups)
      if (f.type === 'checkbox' && f.classifiedType !== 'checkbox_declaration') {
        const group = [f];
        let j = i + 1;
        while (j < fields.length && fields[j].type === 'checkbox' && fields[j].classifiedType !== 'checkbox_declaration') {
          group.push(fields[j]);
          j++;
        }

        if (group.length >= 3) {
          // This is a multi-select group — collapse into one dropdown-style field
          // Look at the next field for context (often the same question as a dropdown)
          const nextField = fields[j];
          const contextLabel = nextField && nextField.type === 'dropdown'
            ? nextField.label
            : `Select applicable groups (${group.map(g => g.label.trim()).join(', ')})`;

          // Auto-answer: pick "No specific group" or first option
          const noSpecific = group.find(g => /no specific/i.test(g.label));
          const autoValue = noSpecific ? noSpecific.label.trim() : group[0].label.trim();

          cleaned.push({
            ...group[0],
            label: contextLabel,
            type: 'dropdown',
            options: group.map(g => g.label.trim()),
            classifiedType: 'communityBenefit',
            preFillStrategy: 'generate',
            preFillKey: null,
          });
          i = j;
          continue;
        }
      }

      // Fix useless short labels — keep original for Playwright matching
      const label = (f.label || '').trim();
      if (label === 'Start') {
        f.domLabel = f.label;
        f.label = 'Activity start date';
        f.classifiedType = 'timeline';
        f.preFillStrategy = 'needs_input';
      } else if (label === 'End') {
        f.domLabel = f.label;
        f.label = 'Activity end date';
        f.classifiedType = 'timeline';
        f.preFillStrategy = 'needs_input';
      } else if (/^Music Australia request:?$/i.test(label)) {
        f.domLabel = f.label;
        f.label = 'Amount requested from Music Australia ($)';
        f.classifiedType = 'budgetOverview';
        f.preFillStrategy = 'needs_input';
      } else if (label === 'Description' && f.type === 'textarea') {
        // Support material descriptions — give context
        const prevField = cleaned[cleaned.length - 1];
        if (prevField && /url|password/i.test(prevField.label)) {
          f.domLabel = f.label;
          f.label = `Description of support material ${Math.ceil(cleaned.filter(c => /support material/i.test(c.label)).length / 2) + 1}`;
        }
      }

      // Skip duplicate URL password fields that aren't needed
      if (/^Password, if applicable$/i.test(label)) {
        f.classifiedType = 'supportMaterial';
        f.preFillStrategy = 'skip';
      }

      cleaned.push(f);
      i++;
    }

    // Re-number field IDs
    cleaned.forEach((f, idx) => { f.id = idx + 1; });

    return cleaned;
  }

  _heuristicClassify(field) {
    const l = (field.label || '').toLowerCase();
    const t = field.type || '';

    // Personal details — auto-fill from profile
    if (l.match(/first\s*name|given\s*name/)) return 'name';
    if (l.match(/last\s*name|surname|family\s*name/)) return 'name';
    if (l.match(/applicant.*name|authorised.*name/) && !l.includes('project')) return 'name';
    if (l.includes('organisation name')) return 'name';
    if (l === 'name' || l === 'name * required') return 'name';
    if (l.match(/title/) && (l.includes('applicant') || l.includes('authorised'))) return 'name';
    if (l.includes('email')) return 'email';
    if (l.includes('phone')) return 'phone';
    if (l.includes('address') || l.includes('postcode')) return 'address';
    if (l.includes('abn') || l.includes('business number')) return 'abn';
    if (l.includes('website') || l.includes('social media')) return 'website';
    if (l.includes('position') && !l.includes('descri')) return 'name';

    // Artist info
    if (l.includes('biograph') || l.includes('about you') || l.includes('about the applicant')) return 'biography';
    if (l.match(/tell us about (you|your act)/)) return 'biography';
    if (l.includes('career') && l.includes('to date')) return 'careerSummary';
    if (l.includes('art form') || l.includes('artform') || l.includes('genre')) return 'dropdown_artform';
    if (l.includes('resident') && !l.includes('state')) return 'residencyConfirmation';

    // Project details — need user input or AI generation
    if (l.match(/project.*descri|descri.*project|brief description/)) return 'projectDescription';
    if (l.match(/proposed|tell us about your tour|outline your plan/)) return 'projectDescription';
    if (l.match(/title/) && !l.includes('applicant') && !l.includes('authorised') && !l.includes('name')) return 'projectDescription';
    if (l.includes('benefit') || l.includes('impact')) return 'communityBenefit';
    if (l.includes('promot')) return 'projectDescription';

    // Budget / financial
    if (l.match(/budget|cost|amount|income|expenditure|co-contribution|funding source/)) return 'budgetOverview';

    // Timeline / dates
    if (l.match(/date|start|end|when|timeline|anticipated/)) return 'timeline';

    // Choices / demographics — needs user input
    if (l.match(/first nations|disability|deaf|lgbti|culturally|linguistically|western sydney|regional|under \d+ years/)) return 'checkbox_declaration';
    if (l.match(/individual.*organisation|organisation.*individual|entity type/)) return 'checkbox_declaration';
    if (l.match(/do you identify/)) return 'checkbox_declaration';
    if (l.match(/do you agree|declaration|agree that/)) return 'checkbox_declaration';
    if (l.match(/do you need|does the applicant/)) return 'checkbox_declaration';

    // File uploads / support material
    if (l.match(/upload|file|attach/)) return 'fileUpload';
    if (l.match(/password/) && !l.includes('login')) return 'supportMaterial';

    // Collaborators / touring party
    if (l.match(/collaborat|partner|role|confirmed|resident state/)) return 'collaborators';
    if (l.match(/touring party|nsw artists|artists from outside|music industry professional/)) return 'collaborators';
    if (l.match(/support people/)) return 'collaborators';

    // Venue / itinerary
    if (l.match(/venue|event|location|sydney|western sydney|regional.*nsw|outside nsw|international|audience/)) return 'timeline';

    // Previous funding
    if (l.includes('previous') && l.includes('fund')) return 'previousFunding';

    // Community
    if (l.includes('communit')) return 'communityBenefit';

    // Catch-all for checkboxes with just "Yes" label
    if (t === 'checkbox' && l.match(/^yes$/)) return 'checkbox_declaration';

    return 'unknown';
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.stop();
      this.browser = null;
    }
    this._setState({ step: 'idle', fields: [], error: null });
  }
}

module.exports = WizardOrchestrator;
