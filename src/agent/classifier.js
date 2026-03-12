const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const CLASSIFICATION_TYPES = {
  biography: { strategy: 'profile_lookup', key: 'content.biography' },
  artisticStatement: { strategy: 'profile_lookup', key: 'content.artisticStatement' },
  careerSummary: { strategy: 'profile_lookup', key: 'content.careerSummary' },
  trackRecord: { strategy: 'profile_lookup', key: 'achievements' },
  audienceReach: { strategy: 'profile_lookup', key: 'stats' },
  supportMaterial: { strategy: 'profile_lookup', key: 'attachments' },
  residencyConfirmation: { strategy: 'profile_lookup', key: 'content.nswResidency' },
  projectDescription: { strategy: 'generate', key: null },
  projectNeed: { strategy: 'generate', key: null },
  budgetOverview: { strategy: 'needs_input', key: null },
  budgetJustification: { strategy: 'generate', key: null },
  timeline: { strategy: 'needs_input', key: null },
  communityBenefit: { strategy: 'generate', key: null },
  collaborators: { strategy: 'generate', key: null },
  accessibility: { strategy: 'generate', key: null },
  previousFunding: { strategy: 'profile_lookup', key: 'fundingHistory' },
  coContribution: { strategy: 'needs_input', key: null },
  name: { strategy: 'profile_lookup', key: 'personal.name' },
  email: { strategy: 'profile_lookup', key: 'personal.email' },
  phone: { strategy: 'profile_lookup', key: 'personal.phone' },
  address: { strategy: 'profile_lookup', key: 'personal.address' },
  abn: { strategy: 'profile_lookup', key: 'personal.abn' },
  website: { strategy: 'profile_lookup', key: 'personal.website' },
  dropdown_genre: { strategy: 'profile_match', key: 'artist.genre' },
  dropdown_artform: { strategy: 'profile_match', key: 'artist.genre' },
  checkbox_declaration: { strategy: 'skip', key: null },
  fileUpload: { strategy: 'file_upload', key: 'attachments' },
  ui_chrome: { strategy: 'skip', key: null },
  unknown: { strategy: 'generate', key: null },
};

async function classifyFields(fields) {
  const fieldSummaries = fields.map((f, i) => ({
    index: i,
    label: f.label,
    type: f.type,
    helpText: f.helpText || '',
    wordLimit: f.wordLimit || null,
    required: f.required || false,
  }));

  const prompt = `You are a grant application field classifier. Given a list of form fields extracted from an Australian arts/music grant portal's accessibility tree, classify each field.

IMPORTANT: Many fields will be UI navigation elements (filters, search boxes, page controls, dropdowns for sorting/filtering results, toolbar buttons) — NOT actual application questions. These must be classified as "ui_chrome" so they are excluded from the application wizard.

CLASSIFICATION TYPES:
- ui_chrome: NOT an application field — UI navigation, filters, search boxes, sort controls, toolbar elements, "Filter by..." dropdowns, page selectors, etc. Use this liberally for anything that is clearly portal chrome rather than an application question.
- name: Applicant's full name
- email: Email address
- phone: Phone number
- address: Address or postcode
- abn: ABN or business number
- biography: Artist biography or "about you" text
- artisticStatement: Artistic practice description or creative statement
- careerSummary: Career overview, CV summary, track record
- trackRecord: Specific achievements, awards, past work
- audienceReach: Audience numbers, social media stats, reach metrics
- residencyConfirmation: State/territory residency confirmation (yes/no or text)
- projectDescription: Description of the proposed project/activity (requires specific user input)
- projectNeed: Why this project needs funding, justification
- budgetOverview: Total budget, amount requested, financial figures
- budgetJustification: Explanation of how funds will be used
- timeline: Project dates, milestones, schedule
- communityBenefit: Community impact, audience benefit, cultural value
- collaborators: Key collaborators, partners, support team
- accessibility: Accessibility plan, inclusion strategy
- previousFunding: Past grants received, funding history
- coContribution: Co-contribution amount, matched funding
- dropdown_genre: Genre or art form dropdown selection
- dropdown_artform: Primary art form dropdown
- checkbox_declaration: Declaration/agreement checkbox
- fileUpload: File upload field (CV, support material, budget spreadsheet)
- supportMaterial: Links to support material (videos, press)
- unknown: Cannot confidently classify (but IS a real application field)

For each field, return:
- index: the field index
- classifiedType: one of the types above
- confidence: 0.0 to 1.0

Return ONLY a JSON array, no other text.

FIELDS TO CLASSIFY:
${JSON.stringify(fieldSummaries, null, 2)}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  let classifications = [];
  try {
    classifications = JSON.parse(text.trim());
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) classifications = JSON.parse(match[0]);
  }

  // Merge classifications back into fields
  return fields.map((field, i) => {
    const cls = classifications.find(c => c.index === i) || {
      classifiedType: 'unknown',
      confidence: 0.5,
    };
    const typeInfo = CLASSIFICATION_TYPES[cls.classifiedType] || CLASSIFICATION_TYPES.unknown;
    return {
      ...field,
      classifiedType: cls.classifiedType,
      confidence: cls.confidence,
      preFillStrategy: typeInfo.strategy,
      preFillKey: typeInfo.key,
    };
  });
}

module.exports = { classifyFields, CLASSIFICATION_TYPES };
