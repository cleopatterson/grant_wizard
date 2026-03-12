const Anthropic = require('@anthropic-ai/sdk');
const PROFILE = require('../data/profile');

const client = new Anthropic();

function buildDraftPrompt(grant, projectDescription, amountRequested, sectionType) {
  return `You are a professional grant writer specialising in Australian music industry funding applications. Write a compelling grant application draft for the following:

APPLICANT PROFILE:
Name: ${PROFILE.name}
Location: ${PROFILE.location}
Genre: ${PROFILE.genre}
Instruments: ${PROFILE.instruments}
Label: ${PROFILE.label}
Publisher: ${PROFILE.publisher}
Education: ${PROFILE.education}
Career Start: ${PROFILE.careerStart}
Bio: ${PROFILE.bio}
Key Achievements: ${PROFILE.achievements.join('; ')}
Discography: ${PROFILE.discography.map(d => d.title + ' (' + d.year + ', ' + d.type + ')').join('; ')}

GRANT BEING APPLIED FOR:
Name: ${grant.name}
Body: ${grant.body}
Amount: ${grant.amount}
Description: ${grant.description}
Eligibility: ${grant.eligibility}

PROJECT DESCRIPTION (from applicant): ${projectDescription}
REQUESTED AMOUNT: ${amountRequested || "Not specified — suggest appropriate amount"}
SECTION TO WRITE: ${sectionType === "full" ? "Complete application draft" : sectionType}

Write a professional, compelling grant application that:
1. Opens with a strong artistic statement tailored to this specific grant
2. Clearly describes the project and its goals
3. Demonstrates Mark's track record with specific achievements and numbers
4. Explains why this project needs funding and why now
5. Shows alignment with the grant body's objectives
6. Includes a realistic timeline
7. Is written in first person from Mark's perspective
8. Uses Australian English spelling
9. References actual achievements, album titles, tour history
Format with clear section headings. Make it ready to copy-paste with minor edits.`;
}

async function generateDraft(grant, projectDescription, amountRequested, sectionType) {
  const prompt = buildDraftPrompt(grant, projectDescription, amountRequested, sectionType);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return text;
}

async function* streamDraft(grant, projectDescription, amountRequested, sectionType) {
  const prompt = buildDraftPrompt(grant, projectDescription, amountRequested, sectionType);

  const stream = client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

function buildAnswerPrompt(grant, question, projectDescription, allQuestions) {
  const otherQuestions = allQuestions
    .filter(q => q.id !== question.id)
    .map(q => `- ${q.question_label || ''}: ${q.question_text}`)
    .join('\n');

  const wordLimitNote = question.word_limit
    ? `\nWORD LIMIT: Keep your answer under ${question.word_limit} words. This is strict.`
    : '';

  return `You are a professional grant writer specialising in Australian music industry funding applications. Write a compelling answer to ONE specific application question.

APPLICANT PROFILE:
Name: ${PROFILE.name}
Location: ${PROFILE.location}
Genre: ${PROFILE.genre}
Instruments: ${PROFILE.instruments}
Label: ${PROFILE.label}
Publisher: ${PROFILE.publisher}
Education: ${PROFILE.education}
Career Start: ${PROFILE.careerStart}
Bio: ${PROFILE.bio}
Key Achievements: ${PROFILE.achievements.join('; ')}
Discography: ${PROFILE.discography.map(d => d.title + ' (' + d.year + ', ' + d.type + ')').join('; ')}

GRANT BEING APPLIED FOR:
Name: ${grant.name}
Body: ${grant.body}
Amount: ${grant.amount}
Description: ${grant.description}
Eligibility: ${grant.eligibility}

PROJECT DESCRIPTION (from applicant): ${projectDescription}

QUESTION TO ANSWER:
${question.question_label ? question.question_label + ': ' : ''}${question.question_text}
${question.tips ? 'Tip: ' + question.tips : ''}${wordLimitNote}

OTHER QUESTIONS IN THIS APPLICATION (do NOT repeat information that belongs in these other answers):
${otherQuestions}

INSTRUCTIONS:
1. Answer ONLY this specific question — do not include content that belongs in other questions
2. Write in first person from Mark's perspective
3. Use Australian English spelling
4. Be specific — reference actual achievements, album titles, tour history, numbers
5. Be compelling and professional, tailored to this grant body
6. Make it ready to paste directly into the application form
${question.word_limit ? '7. STRICT word limit: ' + question.word_limit + ' words maximum' : ''}

Write the answer now. Do not include the question text or any preamble — just the answer.`;
}

async function* streamAnswer(grant, question, projectDescription, allQuestions) {
  const prompt = buildAnswerPrompt(grant, question, projectDescription, allQuestions);

  const stream = client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }]
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

module.exports = { generateDraft, streamDraft, streamAnswer };
