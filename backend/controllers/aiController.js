const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  conceptExplainPrompt,
  questionAnswerPrompt,
} = require("../utils/prompts");

// Initialize AI only if API key is available
let ai = null;
const initializeAI = () => {
  if (!ai && process.env.GEMINI_API_KEY) {
    ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return ai;
};

// Helper: wraps a promise with a timeout
const withTimeout = (promise, ms) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
};

// Helper function to extract and parse JSON from text
const parseJsonResponse = (text) => {
  if (!text) {
    throw new Error("Empty response from AI");
  }

  // Remove markdown code blocks
  let cleanedText = text
    .replace(/^```(?:json)?\s*/gm, "")
    .replace(/```\s*$/gm, "")
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch (directParseError) {
    console.log("Direct parse failed, attempting to extract JSON...");
  }

  // Try to find array first (for questions)
  const arrayMatch = cleanedText.match(/\[\s*\{[\s\S]*?\}\s*(?:,\s*\{[\s\S]*?\}\s*)*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) {}
  }

  // Try to find object (for explanations)
  const objectMatch = cleanedText.match(/\{\s*"[\s\S]*?\s*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
  }

  console.error("Could not extract valid JSON from response:", cleanedText.substring(0, 500));
  throw new Error(`Could not extract valid JSON from AI response. Response: ${cleanedText.substring(0, 200)}`);
};

// Helper to check for blocked content
const checkResponseValidity = (result) => {
  if (!result) throw new Error("No result from API");

  if (result.promptFeedback?.blockReason) {
    throw new Error(`Request blocked by Google: ${result.promptFeedback.blockReason}`);
  }

  if (!result.candidates || result.candidates.length === 0) {
    throw new Error("No candidates in response - possible content filter");
  }

  const candidate = result.candidates[0];

  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Response incomplete (finishReason: ${candidate.finishReason}).`);
  }

  if (candidate.content?.parts?.length === 0) {
    throw new Error("Response content is empty (possibly blocked by safety filters)");
  }

  return true;
};

// Ordered list of current, available Gemini models to try
const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

// Returns a working model instance
const getWorkingModel = async (aiInstance) => {
  for (const modelName of GEMINI_MODELS) {
    try {
      console.log(`Trying model: ${modelName}`);
      const model = aiInstance.getGenerativeModel({ model: modelName });
      // Quick probe to confirm availability
      await withTimeout(model.generateContent("ping"), 8000);
      console.log(`✓ Using model: ${modelName}`);
      return model;
    } catch (err) {
      console.log(`✗ ${modelName} unavailable: ${err.message}`);
    }
  }
  throw new Error(
    "No suitable Gemini model found. Check your API key permissions at https://aistudio.google.com/apikey"
  );
};

// @desc Generate interview questions and answers using Gemini
// @route POST /api/ai/generate-questions
// @access Private
const generateInterviewQuestions = async (req, res) => {
  try {
    console.log("=== Generate Questions Request ===");

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ message: "AI service not configured" });
    }

    const aiInstance = initializeAI();
    if (!aiInstance) {
      return res.status(500).json({ message: "AI service not available" });
    }

    const { role, experience, topicsToFocus, numberOfQuestions } = req.body;
    console.log("Request params:", { role, experience, topicsToFocus, numberOfQuestions });

    if (!role || !experience || !topicsToFocus || !numberOfQuestions) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const prompt = questionAnswerPrompt(role, experience, topicsToFocus, numberOfQuestions);
    console.log("Generated prompt length:", prompt.length);

    const model = await getWorkingModel(aiInstance);
    const result = await withTimeout(model.generateContent(prompt), 30000);

    console.log("Response received:", result ? "Yes" : "No");
    checkResponseValidity(result);

    if (!result.response) {
      throw new Error("No response from AI model");
    }

    const rawText = result.response.text();
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
      return res.status(500).json({ message: "AI service not configured" });
    }

    const aiInstance = initializeAI();
    if (!aiInstance) {
      return res.status(500).json({ message: "AI service not available" });
    }

    const prompt = conceptExplainPrompt(question);
    console.log("Generated prompt length:", prompt.length);

    const model = await getWorkingModel(aiInstance);
    const result = await withTimeout(model.generateContent(prompt), 30000);

    console.log("Response received:", result ? "Yes" : "No");
    checkResponseValidity(result);

    if (!result.response) {
      throw new Error("No response from AI model");
    }

    const rawText = result.response.text();
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