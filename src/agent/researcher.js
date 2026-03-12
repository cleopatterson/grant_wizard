const Anthropic = require('@anthropic-ai/sdk');
const PROFILE = require('../data/profile');
const { getAllGrants, upsertGrant, logResearchRun } = require('../db');

const client = new Anthropic();

let isResearching = false;
let lastResult = null;

function buildResearchPrompt(existingGrants) {
  const existingNames = existingGrants.map(g => `- ${g.name} (${g.body})`).join('\n');

  return `You are a grant research specialist for Australian musicians. Your task is to find current grant opportunities relevant to the following artist:

ARTIST PROFILE:
- Name: ${PROFILE.name}
- Location: ${PROFILE.location}
- Genre: ${PROFILE.genre}
- Label: ${PROFILE.label}
- Career highlights: ${PROFILE.achievements.slice(0, 8).join('; ')}

SEARCH STRATEGY:
Search for Australian music grants, arts funding, touring grants, recording grants, and export grants. Check these organisations and programs:
1. Creative Australia (formerly Australia Council) — arts projects, music export
2. Sound NSW — touring, recording, content creation grants
3. Create NSW — creative development, professional development
4. APRA AMCOS — professional development awards, songwriting grants
5. Music Australia — export development, marketing grants
6. Austrade EMDG — export market development grants
7. American Australian Association — arts fund
8. Regional Arts Fund — quick response grants
9. Any new or recently announced Australian music/arts grants for 2026
10. State government arts grants (NSW focus but also national)

EXISTING GRANTS IN DATABASE (skip these unless you find updated information):
${existingNames}

IMPORTANT INSTRUCTIONS:
- Search thoroughly using multiple queries
- For each grant found, assess its relevance to this specific artist (0-100 score)
- Include grants that are currently open or expected to open soon
- Note specific deadlines where available
- Return ONLY valid JSON

Return your findings as a JSON array. Each grant object must have exactly these fields:
{
  "name": "Full grant name",
  "body": "Funding body name",
  "amount": "Amount range as string",
  "type": "One of: Project, Export, Touring, Recording, Marketing, International, Professional Development, Creative Development, Quick Response",
  "url": "Official URL",
  "description": "What the grant funds",
  "eligibility": "Who can apply",
  "tips": "Specific tips for Mark Wilkinson's application",
  "tags": ["relevant", "tags"],
  "status": "Current status / deadline info",
  "deadline_date": "YYYY-MM-DD or null if unknown",
  "relevance_score": 85,
  "is_new": true
}

Set "is_new" to true for grants NOT in the existing database, false for updated existing grants.
Return ONLY the JSON array, no other text.`;
}

async function researchGrants() {
  if (isResearching) {
    return { status: 'already_running' };
  }

  isResearching = true;
  lastResult = null;

  try {
    const existingGrants = getAllGrants();
    const prompt = buildResearchPrompt(existingGrants);

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8000,
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 10,
        user_location: {
          type: "approximate",
          country: "AU",
          region: "New South Wales",
          city: "Sydney",
          timezone: "Australia/Sydney"
        }
      }],
      messages: [{ role: "user", content: prompt }]
    });

    // Extract text from response
    const textBlocks = response.content.filter(b => b.type === 'text');
    const fullText = textBlocks.map(b => b.text).join('\n');

    // Parse JSON from the response
    let grants = [];
    try {
      // Try direct parse first
      grants = JSON.parse(fullText.trim());
    } catch {
      // Try extracting JSON from markdown code block
      const jsonMatch = fullText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        grants = JSON.parse(jsonMatch[0]);
      }
    }

    if (!Array.isArray(grants)) {
      grants = [];
    }

    // Upsert discovered grants into database
    let newCount = 0;
    let updatedCount = 0;

    for (const grant of grants) {
      const wasNew = grant.is_new;
      delete grant.is_new;
      upsertGrant(grant);
      if (wasNew) newCount++;
      else updatedCount++;
    }

    logResearchRun('auto-research', grants.length);

    lastResult = {
      status: 'completed',
      new_grants: newCount,
      updated_grants: updatedCount,
      total_found: grants.length,
      timestamp: new Date().toISOString()
    };

    return lastResult;

  } catch (error) {
    lastResult = {
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    };
    throw error;
  } finally {
    isResearching = false;
  }
}

function getResearchStatus() {
  if (isResearching) {
    return { status: 'running' };
  }
  if (lastResult) {
    return lastResult;
  }
  return { status: 'idle' };
}

module.exports = { researchGrants, getResearchStatus };
