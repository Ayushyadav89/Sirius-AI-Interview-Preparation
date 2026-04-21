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
  const model = client.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent(prompt);

  // SDK responses may expose a response.text() helper
  const text = result?.response && typeof result.response.text === "function"
    ? result.response.text()
    : (result?.response?.text || "");

  if (!text) throw new Error("No text content in Gemini response");
  return text;
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