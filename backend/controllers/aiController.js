const { conceptExplainPrompt, questionAnswerPrompt } = require("../utils/prompts");

// Helper: wraps a promise with a timeout
const withTimeout = (promise, ms) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
};

// Helper function to extract and parse JSON from text
const parseJsonResponse = (text) => {
  if (!text) throw new Error("Empty response from AI");

  let cleanedText = text
    .replace(/^```(?:json)?\s*/gm, "")
    .replace(/```\s*$/gm, "")
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch (_) {
    // fallthrough to extract
  }

  const arrayMatch = cleanedText.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) {}
  }

  const objectMatch = cleanedText.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
  }

  throw new Error(`Could not extract valid JSON from AI response. Preview: ${cleanedText.substring(0,200)}`);
};

// Call Gemini (Google Generative AI) via SDK. This implementation lists models
// and picks a model that supports generation so we don't hard-code names that
// may not exist for the account or API version.
const callGemini = async (prompt) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);

  // List models and pick a usable one (prefer GEMINI_MODEL env if set)
  const listResp = await client.listModels();
  const models = listResp?.models || listResp || [];
  const modelInfos = Array.isArray(models) ? models : Object.values(models || {});

  const preferred = process.env.GEMINI_MODEL;
  let pick = null;

  // find preferred in list
  if (preferred) {
    pick = modelInfos.find((m) => (m?.name || m?.id || m?.model || '') === preferred || (typeof m === 'string' && m === preferred));
  }

  // otherwise pick first model that declares generate or generateContent support
  if (!pick) {
    for (const m of modelInfos) {
      const id = m?.name || m?.id || m?.model || (typeof m === 'string' ? m : undefined);
      if (!id) continue;
      const supported = m?.supportedMethods || m?.methods || m?.capabilities || [];
      const supportsGenerate = Array.isArray(supported)
        ? supported.includes('generateContent') || supported.includes('generate')
        : false;
      if (supportsGenerate || /gemini|bison|chat/i.test(id)) {
        pick = m;
        break;
      }
    }
  }

  if (!pick) throw new Error('No Gemini-like model found via listModels. Ensure your API key has access to Generative models.');

  const id = pick?.name || pick?.id || pick?.model || (typeof pick === 'string' ? pick : undefined);
  const model = client.getGenerativeModel({ model: id });

  // Try common invocation shapes
  let result;
  if (typeof model.generateContent === 'function') {
    result = await model.generateContent(prompt);
  } else if (typeof model.generate === 'function') {
    // some SDKs expect an object
    try {
      result = await model.generate({ input: prompt });
    } catch (_) {
      result = await model.generate({ prompt });
    }
  } else {
    throw new Error(`Selected model (${id}) exposes no supported generate method.`);
  }

  const text = result?.response && typeof result.response.text === 'function'
    ? result.response.text()
    : (result?.response?.text || '');

  return text;
};

// @desc Generate interview questions and answers using Gemini
// @route POST /api/ai/generate-questions
// @access Private
const generateInterviewQuestions = async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY not configured' });

    const { role, experience, topicsToFocus, numberOfQuestions } = req.body;
    if (!role || !experience || !topicsToFocus || !numberOfQuestions) return res.status(400).json({ message: 'Missing required fields' });

    const prompt = questionAnswerPrompt(role, experience, topicsToFocus, numberOfQuestions);
    const rawText = await withTimeout(callGemini(prompt), 30000);
    const data = parseJsonResponse(rawText);
    if (!Array.isArray(data)) throw new Error('AI response is not an array');

    res.status(200).json(data);
  } catch (error) {
    console.error('=== Error generating questions ===', error);
    res.status(500).json({ message: 'Failed to generate questions', error: error.message });
  }
};

// @desc Explain an interview concept/question
// @route POST /api/ai/generate-explanation
// @access Private
const generateConceptExplanation = async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ message: 'GEMINI_API_KEY not configured' });

    const { question } = req.body;
    if (!question) return res.status(400).json({ message: 'Missing required fields' });

    const prompt = conceptExplainPrompt(question);
    const rawText = await withTimeout(callGemini(prompt), 30000);
    const data = parseJsonResponse(rawText);
    if (!data || !data.title || !data.explanation) throw new Error('AI response missing expected fields');

    res.status(200).json(data);
  } catch (error) {
    console.error('=== Error generating explanation ===', error);
    res.status(500).json({ message: 'Failed to generate explanation', error: error.message });
  }
};

module.exports = { generateInterviewQuestions, generateConceptExplanation };