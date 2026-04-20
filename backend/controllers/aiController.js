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

// Helper to check for blocked content
const checkResponseValidity = (result) => {
  if (!result) {
    throw new Error("No result from API");
  }

  // Check for blocked content or safety issues
  if (result.promptFeedback?.blockReason) {
    throw new Error(`Request blocked: ${result.promptFeedback.blockReason}`);
  }

  // Check if candidates exist
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error("No candidates in response");
  }

  const candidate = result.candidates[0];
  
  // Check for content filter reasons
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Content filtered or stopped: ${candidate.finishReason}`);
  }

  // Check if content is blocked
  if (candidate.content?.parts?.length === 0) {
    throw new Error("Response content is empty (possibly blocked)");
  }

  return true;
};

// @desc Generate interview questions and answers using Gemini
// @route POST /api/ai/generate-questions
// @access Private
const generateInterviewQuestions = async (req, res) => {
  try {
    console.log("=== Generate Questions Request ===");
    
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not configured");
      return res.status(500).json({ message: "AI service not configured" });
    }

    const { role, experience, topicsToFocus, numberOfQuestions } = req.body;
    console.log("Request params:", { role, experience, topicsToFocus, numberOfQuestions });

    if (!role || !experience || !topicsToFocus || !numberOfQuestions) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const prompt = questionAnswerPrompt(
      role,
      experience,
      topicsToFocus,
      numberOfQuestions
    );
    console.log("Generated prompt length:", prompt.length);

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
    console.log("Model initialized");

    const result = await model.generateContent(prompt);
    console.log("Response received:", result ? "Yes" : "No");

    // Validate response structure
    checkResponseValidity(result);

    if (!result.response) {
      console.error("Invalid response structure:", result);
      throw new Error("No response from AI model");
    }

    console.log("Response object keys:", Object.keys(result.response));
    
    let rawText = "";
    try {
      rawText = result.response.text();
      console.log("Raw text length:", rawText.length);
      console.log("Raw text preview:", rawText.substring(0, 200));
    } catch (textError) {
      console.error("Error getting text from response:", textError);
      throw new Error(`Failed to extract text from response: ${textError.message}`);
    }

    const data = parseJsonResponse(rawText);
    console.log("Parsed data type:", Array.isArray(data) ? "array" : typeof data);
    console.log("Data length/keys:", Array.isArray(data) ? data.length : Object.keys(data));

    // Ensure it's an array
    if (!Array.isArray(data)) {
      throw new Error("AI response is not a valid array");
    }

    // Validate each item has question and answer
    if (data.some((item) => !item.question || !item.answer)) {
      throw new Error("AI response missing question or answer field");
    }

    console.log("Successfully generated", data.length, "questions");
    res.status(200).json(data);
  } catch (error) {
    console.error("=== Error generating questions ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);
    console.error("Full error:", error);
    
    res.status(500).json({
      message: "Failed to generate questions",
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// @desc Generate explains a interview question
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

    const prompt = conceptExplainPrompt(question);
    console.log("Generated prompt length:", prompt.length);

    const model = ai.getGenerativeModel({ model: "gemini-1.5-flash" });

    const result = await model.generateContent(prompt);
    console.log("Response received:", result ? "Yes" : "No");

    // Validate response structure
    checkResponseValidity(result);

    if (!result || !result.response) {
      console.error("Invalid response structure:", result);
      throw new Error("No response from AI model");
    }

    let rawText = "";
    try {
      rawText = result.response.text();
      console.log("Raw text length:", rawText.length);
    } catch (textError) {
      console.error("Error getting text from response:", textError);
      throw new Error(`Failed to extract text from response: ${textError.message}`);
    }

    const data = parseJsonResponse(rawText);
    console.log("Parsed data keys:", Object.keys(data));

    // Validate structure
    if (!data.title || !data.explanation) {
      throw new Error("AI response missing title or explanation field");
    }

    console.log("Successfully generated explanation");
    res.status(200).json(data);
  } catch (error) {
    console.error("=== Error generating explanation ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);
    console.error("Full error:", error);
    
    res.status(500).json({
      message: "Failed to generate questions",
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

module.exports = { generateInterviewQuestions, generateConceptExplanation };
