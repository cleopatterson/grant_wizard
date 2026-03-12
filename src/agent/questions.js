const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

function buildQuestionsPrompt(grant) {
  return `You are an expert on Australian arts and music grant applications. Your task is to identify the specific application questions for this grant.

GRANT DETAILS:
Name: ${grant.name}
Body: ${grant.body}
URL: ${grant.url || 'Not available'}
Description: ${grant.description || ''}
Eligibility: ${grant.eligibility || ''}
Amount: ${grant.amount || ''}

INSTRUCTIONS:
1. Search for the actual application form questions for this grant. Check the grant URL, the funding body's website, SmartyGrants pages, and any published guidelines.
2. Look for assessment criteria, required fields, and specific questions applicants must answer.
3. If you find the actual form questions, use those exactly.
4. If you cannot find the exact questions, predict the likely questions based on:
   - Common Australian grant application patterns
   - The funding body's known requirements
   - The grant type and purpose
   - Standard SmartyGrants form fields for this category

Return a JSON array of question objects. Each object must have:
{
  "label": "Short section label (e.g. 'Project Description', 'Artistic Merit')",
  "text": "The full question text as it would appear on the form",
  "word_limit": number or null (word limit if known),
  "tips": "Brief tip for answering this specific question well"
}

Include 6-12 questions covering typical sections like:
- Project description / what you want to do
- Artistic merit / creative vision
- Track record / career highlights
- Budget / how funds will be used
- Timeline / project plan
- Impact / outcomes / audience reach
- Why this project needs funding

Return ONLY the JSON array, no other text.`;
}

async function fetchGrantQuestions(grant) {
  const prompt = buildQuestionsPrompt(grant);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 8,
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

  const textBlocks = response.content.filter(b => b.type === 'text');
  const fullText = textBlocks.map(b => b.text).join('\n');

  let questions = [];
  try {
    questions = JSON.parse(fullText.trim());
  } catch {
    const jsonMatch = fullText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      questions = JSON.parse(jsonMatch[0]);
    }
  }

  if (!Array.isArray(questions)) {
    questions = [];
  }

  return questions;
}

module.exports = { fetchGrantQuestions };
