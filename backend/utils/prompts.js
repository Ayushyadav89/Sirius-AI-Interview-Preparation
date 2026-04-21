const questionAnswerPrompt = (
  role,
  experience,
  topicsToFocus,
  numberOfQuestions
) => `You are an expert AI that generates technical interview questions and answers in STRICT JSON format ONLY.

CRITICAL: Output ONLY valid JSON array. NO explanations, NO markdown, NO extra text before or after.

Generate exactly ${numberOfQuestions} interview questions with this information:
- Role: ${role}
- Candidate Experience: ${experience} years
- Focus Topics: ${topicsToFocus}

Each question should have:
1. A clear, concise question
2. A detailed, beginner-friendly answer
3. Code examples if relevant (inline in the answer)

OUTPUT FORMAT (VALID JSON ARRAY ONLY):
[
  {
    "question": "Your question here?",
    "answer": "Your detailed answer here."
  }
]

RULES:
- Output ONLY the JSON array, nothing else
- No markdown code blocks
- No explanations before or after
- Ensure all quotes are properly escaped
- All strings must use double quotes
- NO trailing commas`;

const conceptExplainPrompt = (question) => `You are an expert AI that generates concept explanations in STRICT JSON format ONLY.

CRITICAL: Output ONLY valid JSON object. NO explanations, NO markdown, NO extra text before or after.

Explain this interview question and concept in depth:
"${question}"

Provide:
1. A short, clear title summarizing the concept
2. A detailed explanation suitable for beginners
3. Include code examples if relevant

OUTPUT FORMAT (VALID JSON OBJECT ONLY):
{
  "title": "Concept Title Here",
  "explanation": "Your detailed explanation here."
}

RULES:
- Output ONLY the JSON object, nothing else
- No markdown code blocks
- No explanations before or after
- Ensure all quotes are properly escaped
- All strings must use double quotes
- Keep explanation clear but comprehensive`;

module.exports = { questionAnswerPrompt, conceptExplainPrompt };
