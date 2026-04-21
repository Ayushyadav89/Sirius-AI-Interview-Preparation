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

// Helper function to add timeout to promises
const withTimeout = (promise, timeoutMs = 30000) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`API call timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
};

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

  // Try parsing the cleaned text first
  try {
    const data = JSON.parse(cleanedText);
    return data;
  } catch (directParseError) {
    console.log("Direct parse failed, attempting to extract JSON...");
  }

  // If direct parsing fails, try to extract JSON more carefully
  let jsonMatch = null;
  
  // Try to find array first (for questions)
  const arrayMatch = cleanedText.match(/\[\s*\{[\s\S]*?\}\s*(?:,\s*\{[\s\S]*?\}\s*)*\]/);
  if (arrayMatch) {
    jsonMatch = arrayMatch[0];
  }
  
  // If no array found, try to find object (for explanations)
  if (!jsonMatch) {
    const objectMatch = cleanedText.match(/\{\s*"[\s\S]*?\s*\}/);
    if (objectMatch) {
      jsonMatch = objectMatch[0];
    }
  }
  
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch);
      return data;
    } catch (matchParseError) {
      console.error("Failed to parse extracted JSON:", jsonMatch);
      throw new Error(`Invalid JSON extracted: ${matchParseError.message}`);
    }
  }

  // If still no match, throw detailed error
  console.error("Could not extract valid JSON from response:", cleanedText.substring(0, 500));
  throw new Error(`Could not extract valid JSON from AI response. Response: ${cleanedText.substring(0, 200)}`);
};

// Helper to check for blocked content
const checkResponseValidity = (result) => {
  if (!result) {
    throw new Error("No result from API");
  }

  // Check for blocked content or safety issues
  if (result.promptFeedback?.blockReason) {
    throw new Error(`Request blocked by Google: ${result.promptFeedback.blockReason}`);
  }

  // Check if candidates exist
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error("No candidates in response - possible content filter");
  }

  const candidate = result.candidates[0];
  
  // Check for content filter reasons
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Response incomplete (finishReason: ${candidate.finishReason}). This might indicate the content was filtered or the response was truncated.`);
  }

  // Check if content is blocked
  if (candidate.content?.parts?.length === 0) {
    throw new Error("Response content is empty (content might be blocked by Google's safety filters)");
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

    const aiInstance = initializeAI();
    if (!aiInstance) {
      console.error("Failed to initialize AI");
      return res.status(500).json({ message: "AI service not available" });
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

    // Try gemini-2.0-flash-exp first, fallback to gemini-pro if not available
    let model;
    let modelName = "gemini-2.0-flash-exp";
    
    try {
      model = aiInstance.getGenerativeModel({ model: modelName });
      // Try to get a response to test if model is available
      console.log("Attempting to use", modelName);
    } catch (modelError) {
      console.log(`${modelName} not available, switching to gemini-pro`);
      modelName = "gemini-pro";
      model = aiInstance.getGenerativeModel({ model: modelName });
    }
    console.log("Model initialized:", modelName);

    let result;
    try {
      result = await withTimeout(model.generateContent(prompt), 30000);
    } catch (timeoutError) {
      // If model not found, try gemini-pro as fallback
      if (timeoutError.message.includes("not found") && modelName !== "gemini-pro") {
        console.log(`${modelName} failed, trying gemini-pro...`);
        modelName = "gemini-pro";
        model = aiInstance.getGenerativeModel({ model: modelName });
        result = await withTimeout(model.generateContent(prompt), 30000);
      } else {
        throw timeoutError;
      }
    }
    } catch (timeoutError) {
      console.error("Gemini API call timeout or failed:", timeoutError.message);
      throw new Error(`Gemini API error: ${timeoutError.message}`);
    }
    
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
    if (data.length === 0) {
      throw new Error("AI response returned empty array");
    }

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

    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not configured");
      return res.status(500).json({ message: "AI service not configured" });
    }

    const aiInstance = initializeAI();
    if (!aiInstance) {
      console.error("Failed to initialize AI");
      return res.status(500).json({ message: "AI service not available" });
    }

    const prompt = conceptExplainPrompt(question);
    console.log("Generated prompt length:", prompt.length);

    // Try gemini-2.0-flash-exp first, fallback to gemini-pro if not available
    let model;
    let modelName = "gemini-2.0-flash-exp";
    
    try {
      model = aiInstance.getGenerativeModel({ model: modelName });
      console.log("Attempting to use", modelName);
    } catch (modelError) {
      console.log(`${modelName} not available, switching to gemini-pro`);
      modelName = "gemini-pro";
      model = aiInstance.getGenerativeModel({ model: modelName });
    }

    let result;
    try {
      result = await withTimeout(model.generateContent(prompt), 30000);
    } catch (timeoutError) {
      // If model not found, try gemini-pro as fallback
      if (timeoutError.message.includes("not found") && modelName !== "gemini-pro") {
        console.log(`${modelName} failed, trying gemini-pro...`);
        modelName = "gemini-pro";
        model = aiInstance.getGenerativeModel({ model: modelName });
        result = await withTimeout(model.generateContent(prompt), 30000);
      } else {
        throw timeoutError;
      }
    }
    } catch (timeoutError) {
      console.error("Gemini API call timeout or failed:", timeoutError.message);
      throw new Error(`Gemini API error: ${timeoutError.message}`);
    }
    
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
      message: "Failed to generate explanation",
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

module.exports = { generateInterviewQuestions, generateConceptExplanation };
