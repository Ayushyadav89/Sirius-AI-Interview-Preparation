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

<<<<<<< HEAD
  const candidates = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];

  const is503 = (err) => err?.message?.includes("503") || err?.message?.includes("Service Unavailable");

  let lastError;
  for (const modelName of candidates) {
    // try each model up to 2 times if it returns 503 (temporary overload)
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        console.log(`Trying Gemini model: ${modelName} (attempt ${attempt})`);
        const model = client.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text =
          result?.response && typeof result.response.text === "function"
            ? result.response.text()
            : result?.response?.text || "";
        if (text && text.trim()) return text;
        lastError = new Error(`Empty response from model: ${modelName}`);
        break;
      } catch (err) {
        lastError = err;
        if (is503(err) && attempt < attempts) {
          console.warn(`Model ${modelName} returned 503, retrying in 5s...`);
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          console.error(`Model ${modelName} failed:`, err.message);
          break;
        }
      }
    }
  }
  throw lastError;
=======
  // Require the deploying environment to specify a model id via GEMINI_MODEL.
  // Many SDK/account combinations don't expose listModels in the same way,
  // so prefer an explicit model id to avoid runtime failures.
  const modelId = process.env.GEMINI_MODEL;
  if (!modelId) throw new Error("GEMINI_MODEL is not set. Please set GEMINI_MODEL to a valid model id (e.g. gemini-1.5 or gemini-1.5-flash) in the environment.");

  const model = client.getGenerativeModel({ model: modelId });

  // Try common invocation shapes supported by SDKs
  let result;
  if (typeof model.generateContent === "function") {
    result = await model.generateContent(prompt);
  } else if (typeof model.generate === "function") {
    try {
      result = await model.generate({ input: prompt });
    } catch (_) {
      result = await model.generate({ prompt });
    }
  } else {
    throw new Error(`Selected model (${modelId}) exposes no supported generate method.`);
  }

  const text = result?.response && typeof result.response.text === 'function'
    ? result.response.text()
    : (result?.response?.text || '');

  return text;
>>>>>>> fe8e298df4f1a6cc92070a163d06684d8f12ce8a
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