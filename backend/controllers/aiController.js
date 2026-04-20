const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  conceptExplainPrompt,
  questionAnswerPrompt,
} = require("../utils/prompts");

const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to extract and parse JSON from text
const parseJsonResponse = (text) => {
  if (!text) {
    throw new Error("Empty response from AI");
  }

  // Remove markdown code blocks
  let cleanedText = text
    .replace(/^```(?:json)?\s*/gm, "") // remove starting ``` or ```json
    .replace(/```\s*$/gm, "") // remove ending ```
    .trim();

  // Try to find JSON in the text
  let jsonMatch = cleanedText.match(/\[[\s\S]*\]/) || cleanedText.match(/\{[\s\S]*\}/);
  
  if (jsonMatch) {
    cleanedText = jsonMatch[0];
  }

  // Try parsing
  try {
    const data = JSON.parse(cleanedText);
    return data;
  } catch (parseError) {
    console.error("Failed to parse JSON:", cleanedText);
    throw new Error(`Invalid JSON from AI: ${parseError.message}`);
  }
};

// @desc Generate interview questions and answers using Gemini
// @route POST /api/ai/generate-questions
// @access Private
const generateInterviewQuestions = async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not configured");
      return res.status(500).json({ message: "AI service not configured" });
    }

    const { role, experience, topicsToFocus, numberOfQuestions } = req.body;

    if (!role || !experience || !topicsToFocus || !numberOfQuestions) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const prompt = questionAnswerPrompt(
      role,
      experience,
      topicsToFocus,
      numberOfQuestions
    );

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(prompt);

    if (!result.response) {
      throw new Error("No response from AI model");
    }

    const rawText = result.response.text();
    const data = parseJsonResponse(rawText);

    // Ensure it's an array
    if (!Array.isArray(data)) {
      throw new Error("AI response is not a valid array");
    }

    // Validate each item has question and answer
    if (data.some((item) => !item.question || !item.answer)) {
      throw new Error("AI response missing question or answer field");
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("Error generating questions:", error);
    res.status(500).json({
      message: "Failed to generate questions",
      error: error.message,
    });
  }
};

// @desc Generate explains a interview question
// @route POST /api/ai/generate-explanation
// @access Private
const generateConceptExplanation = async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const prompt = conceptExplainPrompt(question);

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(prompt);

    if (!result.response) {
      throw new Error("No response from AI model");
    }

    const rawText = result.response.text();
    const data = parseJsonResponse(rawText);

    // Validate structure
    if (!data.title || !data.explanation) {
      throw new Error("AI response missing title or explanation field");
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("Error generating explanation:", error);
    res.status(500).json({
      message: "Failed to generate questions",
      error: error.message,
    });
  }
};

module.exports = { generateInterviewQuestions, generateConceptExplanation };
