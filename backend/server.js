require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes"); 
const sessionRoutes = require("./routes/sessionRoutes"); 
const questionRoutes = require("./routes/questionRoutes"); 
const { protect } = require("./middlewares/authMiddleware");
const { generateInterviewQuestions, generateConceptExplanation } = require("./controllers/aiController");

const app = express();

// Middleware to handle CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST" , "PUT" , "DELETE"],
    allowedHeaders: ["Content-Type" , "Authorization"],

  })
);

connectDB()

// Middleware
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API is running!');
});

// Debug endpoint to test Gemini API
app.get('/api/debug/test-gemini', (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const hasKey = !!apiKey;
  const keyPreview = apiKey ? `${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 5)}` : "NOT SET";
  
  res.json({
    message: "Gemini API Debug",
    apiKeyConfigured: hasKey,
    keyPreview: keyPreview,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

// Debug endpoint to list available Gemini models (helps pick a usable model)
app.get('/api/debug/list-gemini-models', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' });

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const client = new GoogleGenerativeAI(apiKey);
    const list = await client.listModels();
    return res.json({ success: true, models: list });
  } catch (error) {
    console.error('Error listing Gemini models:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Test endpoint to actually call Gemini
app.post('/api/debug/test-gemini-call', async (req, res) => {
  try {
    console.log("Testing Gemini API call...");
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "GEMINI_API_KEY not configured" });
    }

    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const testAI = new GoogleGenerativeAI(apiKey);
    const model = testAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    console.log("Making test request to Gemini API...");
    const result = await model.generateContent("Say 'Hello' and nothing else.");
    
    console.log("Result received:", result ? "Yes" : "No");
    console.log("Response:", result.response ? "Yes" : "No");
    
    const text = result.response.text();
    
    res.json({
      success: true,
      message: "Gemini API is working!",
      response: text,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Gemini API test error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      errorType: error.constructor.name,
      timestamp: new Date().toISOString(),
    });
  }
});

// Routes
app.use("/api/auth", authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/questions', questionRoutes);

app.post("/api/ai/generate-questions", protect, generateInterviewQuestions);
app.post("/api/ai/generate-explanation", protect, generateConceptExplanation);


// Serve uploads folder
app.use("/uploads" , express.static(path.join(__dirname , "uploads"), {}));


// start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY is missing in .env");
  } else {
    console.log(`🔑 GEMINI_API_KEY loaded: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  }
});

