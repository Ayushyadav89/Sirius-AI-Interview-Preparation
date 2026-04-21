const {
  conceptExplainPrompt,
  questionAnswerPrompt,
} = require("../utils/prompts");

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
    console.log("Direct parse failed, attempting to extract JSON...");
  }

  const arrayMatch = cleanedText.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch (_) {}
  }

  const objectMatch = cleanedText.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch (_) {}
  }

  throw new Error(`Could not extract valid JSON from AI response. Preview: ${cleanedText.substring(0, 200)}`);
};

// Call Gemini (Google Generative AI) via SDK
const callGemini = async (prompt) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);

  // Allow overriding model via env, otherwise try common model names until one works
  const preferred = process.env.GEMINI_MODEL;
  const candidates = (preferred ? [preferred] : []).concat([
    "gemini-1.5-flash",
    "gemini-1.5",
    "gemini-1.0",
    "models/gemini-1.5-flash",
    "models/gemini-1.5",
    "text-bison-001",
    "chat-bison",
    "models/text-bison-001",
  ]);

  let lastError = null;

  for (const name of candidates) {
    try {
      const model = client.getGenerativeModel({ model: name });
      const result = await model.generateContent(prompt);

      const text = result?.response && typeof result.response.text === "function"
        ? result.response.text()
        : (result?.response?.text || "");

      if (text && text.trim()) return text;
      // If empty, keep trying other candidates
      lastError = new Error(`Empty response from model ${name}`);
    } catch (err) {
      lastError = err;
      // try next candidate
    }
  }
  // If none of the candidate models worked, query available models and try one that supports generateContent
  try {
    const listResp = await client.listModels();
    const models = listResp?.models || listResp?.model || listResp || [];

    // normalize to array of objects with id/name
    const modelInfos = Array.isArray(models) ? models : Object.values(models || {});

    const available = [];
    for (const m of modelInfos) {
      const id = m?.name || m?.id || m?.model || (typeof m === 'string' ? m : undefined);
      if (!id) continue;
      const supported = m?.supportedMethods || m?.methods || m?.capabilities || [];
      const supportsGenerate = Array.isArray(supported)
        ? supported.includes('generateContent') || supported.includes('generate')
        : false;
      available.push({ id, supportsGenerate, raw: m });
    }

    // prefer any model that declares support for generateContent
    const pick = available.find((a) => a.supportsGenerate) || available[0];
    if (pick) {
      try {
        const model = client.getGenerativeModel({ model: pick.id });
        const result = await model.generateContent(prompt);
        const text = result?.response && typeof result.response.text === 'function'
          ? result.response.text()
          : (result?.response?.text || '');
        if (text && text.trim()) return text;
      } catch (err) {
        lastError = err;
      }
    }

    const names = available.map((a) => `${a.id}${a.supportsGenerate ? ' (supports generateContent)' : ''}`);
    throw new Error(
      `No usable Gemini model found. Tried candidates and listModels results. Available models: ${names.slice(0,20).join(', ')}`
    );
  } catch (err) {
    // Prefer the last SDK error if present, otherwise the listModels error
    throw lastError || err || new Error('No available Gemini model produced output');
  }
};

// @desc Generate interview questions and answers using Claude
// @route POST /api/ai/generate-questions
// @access Private
const generateInterviewQuestions = async (req, res) => {
  try {
    console.log("=== Generate Questions Request ===");

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "AI service not configured. Set GEMINI_API_KEY in environment variables." });
    }

    const { role, experience, topicsToFocus, numberOfQuestions } = req.body;
    console.log("Request params:", { role, experience, topicsToFocus, numberOfQuestions });

    if (!role || !experience || !topicsToFocus || !numberOfQuestions) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const prompt = questionAnswerPrompt(role, experience, topicsToFocus, numberOfQuestions);
    console.log("Generated prompt length:", prompt.length);

    const rawText = await withTimeout(callGemini(prompt), 30000);
    console.log("Raw text length:", rawText.length);

    const data = parseJsonResponse(rawText);

    if (!Array.isArray(data)) throw new Error("AI response is not a valid array");
    if (data.length === 0) throw new Error("AI response returned empty array");
    if (data.some((item) => !item.question || !item.answer)) {
      throw new Error("AI response missing question or answer field");
    }

    console.log("Successfully generated", data.length, "questions");
    res.status(200).json(data);
  } catch (error) {
    console.error("=== Error generating questions ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);

    res.status(500).json({
      message: "Failed to generate questions",
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// @desc Explain an interview concept/question
// @route POST /api/ai/generate-explanation
// @access Private
const generateConceptExplanation = async (req, res) => {
  try {
    console.log("=== Generate Explanation Request ===");

    const { question } = req.body;
    console.log("Question:", question ? question.substring(0, 100) : "missing");

    if (!question) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "AI service not configured. Set GEMINI_API_KEY in environment variables." });
    }

    const prompt = conceptExplainPrompt(question);
    console.log("Generated prompt length:", prompt.length);

    const rawText = await withTimeout(callGemini(prompt), 30000);
    console.log("Raw text length:", rawText.length);

    const data = parseJsonResponse(rawText);
    console.log("Parsed data keys:", Object.keys(data));

    if (!data.title || !data.explanation) {
      throw new Error("AI response missing title or explanation field");
    }

    console.log("Successfully generated explanation");
    res.status(200).json(data);
  } catch (error) {
    console.error("=== Error generating explanation ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);

    res.status(500).json({
      message: "Failed to generate explanation",
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

module.exports = { generateInterviewQuestions, generateConceptExplanation };