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
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Set GEMINI_API_KEY in your environment.");

  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const client = new GoogleGenerativeAI(apiKey);

  // Choose model: prefer GEMINI_MODEL env, otherwise default to a modern Gemini model
  const preferred = process.env.GEMINI_MODEL;
  const defaultCandidates = ["gemini-1.5-flash", "gemini-1.5", "gemini-1.0", "models/gemini-1.5-flash", "models/gemini-1.5"];
  const candidates = (preferred ? [preferred] : []).concat(defaultCandidates);

  let lastError = null;

  // Helper to attempt calling a model using common SDK methods
  const tryCall = async (modelInstance) => {
    // Try generateContent (used by some SDK versions)
    if (typeof modelInstance.generateContent === "function") {
      return await modelInstance.generateContent(prompt);
    }
    // Try generate with a simple input shape (some SDKs use { input })
    if (typeof modelInstance.generate === "function") {
      try {
        return await modelInstance.generate({ input: prompt });
      } catch (e) {
        // fallback to other signature
        return await modelInstance.generate({ prompt });
      }
    }
    throw new Error("Model instance exposes no supported generate method");
  };

  // Try candidate list first
  for (const name of candidates) {
    try {
      const model = client.getGenerativeModel({ model: name });
      const result = await tryCall(model);

      const text = result?.response && typeof result.response.text === "function"
        ? result.response.text()
        : (result?.response?.text || "");

      if (text && text.trim()) return text;
      lastError = new Error(`Empty response from model ${name}`);
    } catch (err) {
      lastError = err;
      console.error(`Model ${name} failed:`, err && err.message ? err.message : err);
      // try next candidate
    }
  }

  // If no candidate worked, list available models and pick one that supports generate or generateContent
  try {
    const listResp = await client.listModels();
    const models = listResp?.models || listResp?.model || listResp || [];
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

    const pick = available.find((a) => a.supportsGenerate) || available[0];
    if (pick) {
      try {
        const model = client.getGenerativeModel({ model: pick.id });
        const result = await tryCall(model);
        const text = result?.response && typeof result.response.text === 'function'
          ? result.response.text()
          : (result?.response?.text || '');
        if (text && text.trim()) return text;
      } catch (err) {
        lastError = err;
        console.error(`Picked model ${pick.id} failed:`, err && err.message ? err.message : err);
      }
    }

    const names = available.map((a) => `${a.id}${a.supportsGenerate ? ' (supports generateContent)' : ''}`);
    throw new Error(`No usable Gemini model found. Available models: ${names.slice(0,20).join(', ')}`);
  } catch (err) {
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