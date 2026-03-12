const Anthropic = require('@anthropic-ai/sdk');
const PROFILE = require('../data/profile');

const client = new Anthropic();

function getNestedValue(obj, path) {
  if (!path) return null;
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
}

function preFillFromProfile(field) {
  const { classifiedType, preFillKey, wordLimit } = field;

  // Direct profile lookups
  const value = getNestedValue(PROFILE, preFillKey);
  if (value === null || value === undefined) return null;

  // Handle biography — pick short or long based on word limit
  if (classifiedType === 'biography' && typeof value === 'object') {
    if (wordLimit && wordLimit <= 250) return value.short;
    return value.long;
  }

  // Handle arrays (achievements) — format as prose
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const formatted = value.join('. ') + '.';
    if (wordLimit) {
      const words = formatted.split(/\s+/);
      if (words.length > wordLimit) {
        return words.slice(0, wordLimit).join(' ');
      }
    }
    return formatted;
  }

  // Handle stats object — format as prose
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
  }

  return String(value);
}

function generateTemplate(field) {
  const templates = {
    projectNeed: PROFILE.content.projectNeedTemplate,
    communityBenefit:
      'This project will benefit [TARGET COMMUNITY] by [SPECIFIC IMPACT]. Through [ACTIVITY], the project will reach approximately [NUMBER] people and create lasting value through [LASTING OUTCOME]. The activity connects to the broader community by [CONNECTION].',
    accessibility:
      'This project is committed to accessibility and inclusion. All venues will be assessed for wheelchair access, and reasonable adjustments will be made to ensure participation is open to all. Marketing materials will be available in accessible formats.',
  };

  return templates[field.classifiedType] || null;
}

async function generateContent(field, grantContext, existingFields) {
  const model = 'claude-haiku-4-5-20251001';

  const prompt = `You are a professional grant writer for Australian music industry funding applications. Write a compelling answer for this specific form field.

APPLICANT PROFILE:
Name: ${PROFILE.personal.name}
Genre: ${PROFILE.artist.genre}
Label: ${PROFILE.artist.label}
Bio: ${PROFILE.content.biography.short}
Career: ${PROFILE.content.careerSummary}
Key achievements: ${PROFILE.achievements.slice(0, 8).join('; ')}

GRANT CONTEXT:
${grantContext || 'Australian arts/music grant application'}

FIELD TO ANSWER:
Label: ${field.label}
Type: ${field.type}
${field.options ? 'Available options: ' + field.options.join(', ') : ''}
${field.helpText ? 'Help text: ' + field.helpText : ''}
${field.wordLimit ? 'Word limit: ' + field.wordLimit + ' words' : ''}

OTHER FIELDS ALREADY FILLED (do not repeat this information):
${existingFields
  .filter(f => f.value && f.id !== field.id)
  .map(f => `- ${f.label}: ${String(f.value).substring(0, 100)}...`)
  .join('\n')}

INSTRUCTIONS:
1. Write in first person from Mark's perspective
2. Use Australian English spelling
3. Be specific — reference actual achievements, album titles, tour history
4. Be confident but not arrogant
5. ${field.wordLimit ? `Stay under ${field.wordLimit} words` : 'Be concise'}
6. For dropdown fields, return EXACTLY one of the available options — nothing else
7. Return ONLY the answer text — no preamble, no field label, no explanation

Write the answer now.`;

  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

async function generateFromHelp(field, helpAnswers, grantContext) {
  const prompt = `You are a professional grant writer for Australian music industry funding applications. Using the applicant's quick answers and their full profile, compose a polished grant application response.

APPLICANT PROFILE:
Name: ${PROFILE.personal.name}
Genre: ${PROFILE.artist.genre}
Label: ${PROFILE.artist.label}
Bio: ${PROFILE.content.biography.short}
Career: ${PROFILE.content.careerSummary}
International track record: ${PROFILE.content.internationalTrackRecord}
Key achievements: ${PROFILE.achievements.slice(0, 8).join('; ')}

GRANT CONTEXT:
${grantContext || 'Australian arts/music grant application'}

FIELD:
Label: ${field.label}
${field.wordLimit ? 'Word limit: ' + field.wordLimit + ' words' : ''}

MARK'S QUICK ANSWERS:
${helpAnswers.map((a, i) => `Q${i + 1}: ${a.question} → ${a.answer}`).join('\n')}

INSTRUCTIONS:
1. Write in first person from Mark's perspective
2. Use Australian English spelling
3. Weave in specific achievements, tour history, album titles naturally
4. Be confident and professional but genuine
5. ${field.wordLimit ? `Stay under ${field.wordLimit} words` : 'Be concise'}
6. Return ONLY the response text

Write the response now.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function buildPreFillPlan(classifiedFields) {
  // Filter out UI chrome (navigation elements, filters, etc.)
  const applicationFields = classifiedFields.filter(f => f.classifiedType !== 'ui_chrome');
  return applicationFields.map(field => {
    let status, value;

    switch (field.preFillStrategy) {
      case 'profile_lookup':
      case 'profile_match': {
        // If dropdown has real options, pick the best match from those options
        if (field.options && field.options.length > 0) {
          const profileValue = preFillFromProfile(field);
          const pv = (profileValue || '').toLowerCase();
          // Find best matching option
          const match = field.options.find(o => pv.includes(o.toLowerCase()) || o.toLowerCase().includes(pv));
          if (match) {
            status = 'auto';
            value = match;
          } else {
            // No match — leave for user to pick from buttons
            status = 'needs_input';
            value = '';
          }
        } else {
          const profileValue = preFillFromProfile(field);
          if (profileValue && !profileValue.includes('[TO BE ADDED]')) {
            status = 'auto';
            value = profileValue;
          } else {
            status = 'needs_input';
            value = '';
          }
        }
        break;
      }
      case 'template': {
        const template = generateTemplate(field);
        if (template) {
          status = 'template';
          value = template;
        } else {
          status = 'needs_input';
          value = '';
        }
        break;
      }
      case 'file_upload':
        status = 'ready';
        value = '';
        break;
      case 'skip':
        status = 'skip';
        value = '';
        break;
      case 'needs_input':
        status = 'needs_input';
        value = '';
        break;
      case 'generate':
      default:
        status = 'needs_input';
        value = '';
        break;
    }

    return {
      ...field,
      status,
      value,
      wordCount: value ? value.split(/\s+/).length : 0,
    };
  });
}

module.exports = { buildPreFillPlan, generateContent, generateFromHelp, preFillFromProfile };
