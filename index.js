const functions = require("@google-cloud/functions-framework");
const axios = require("axios");
const { Firestore } = require("@google-cloud/firestore");
const { GoogleGenAI } = require("@google/genai");

// Initialize the Firestore database client
const firestore = new Firestore();

// Initialize the Google GenAI client
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);


// Read the IP whitelist from the separate JSON file
const WHITELISTED_IPS = require("./whitelist.json").ips;

// --- Main Function: The Router ---
// This is the "Entry Point" for your Cloud Function.
functions.http("apiProxy", async (req, res) => {
  const path = req.path;
  const userData = req.body;

  // Enhanced IP detection for Google Cloud Functions
  console.log("=== IP DETECTION DEBUG ===");
  console.log("req.ip:", req.ip);
  console.log("req.connection.remoteAddress:", req.connection?.remoteAddress);
  console.log("req.socket.remoteAddress:", req.socket?.remoteAddress);
  console.log("X-Forwarded-For header:", req.get("X-Forwarded-For"));
  console.log("X-Real-IP header:", req.get("X-Real-IP"));
  console.log("All headers:", req.headers);

  // Get the real IP address, handling proxies
  let ipAddress = req.ip;
  const forwardedFor = req.get("X-Forwarded-For");
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    ipAddress = forwardedFor.split(",")[0].trim();
  }

  console.log("Final IP address used:", ipAddress);
  console.log("=== IP DETECTION DEBUG END ===");

  // --- Throttling Logic ---
  // This checks the IP against the whitelist first, then checks the database.
  const isAllowed = await checkAndRecordUsage(ipAddress);
  if (!isAllowed) {
    return res.status(429).send({ error: "Rate limit exceeded." });
  }

  // --- Route to the correct API handler based on the URL path ---
  try {
    if (path.includes("/tts")) {
      const base64Audio = await handleTTS(userData.prompt);
      res.set("Content-Type", "text/plain").status(200).send(base64Audio);
    } else if (path.includes("/openai")) {
      const textResponse = await handleOpenAI(userData.prompt);
      res.status(200).send({ reply: textResponse });
    } else if (path.includes("/gemini")) {
      const textResponse = await handleGemini(userData.prompt);
      res.status(200).send({ reply: textResponse });
    } else {
      res.status(404).send({ error: "Endpoint not found." });
    }
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).send({ error: "An internal server error occurred." });
  }
});

// --- Throttling Function with Whitelist and Database Logic ---
async function checkAndRecordUsage(ipAddress) {
  console.log("=== RATE LIMIT DEBUG START ===");
  console.log("Raw IP Address:", ipAddress);
  console.log("IP Address type:", typeof ipAddress);
  console.log("Whitelist IPs:", WHITELISTED_IPS);
  console.log("Whitelist type:", typeof WHITELISTED_IPS);

  // TEMPORARY DEBUG BYPASS - Remove this after debugging
  const BYPASS_RATE_LIMITING = process.env.BYPASS_RATE_LIMITING === "true";
  if (BYPASS_RATE_LIMITING) {
    console.log("⚠️  RATE LIMITING BYPASSED FOR DEBUGGING ⚠️");
    console.log("=== RATE LIMIT DEBUG END: ALLOWED (BYPASS) ===");
    return true;
  }

  // Step 1: Whitelist Check
  // If the incoming IP is in our whitelist, approve the request immediately.
  const isWhitelisted = WHITELISTED_IPS.includes(ipAddress);
  console.log("Is IP whitelisted?", isWhitelisted);

  if (isWhitelisted) {
    console.log(`Whitelisted IP ${ipAddress} accessed. Bypassing limits.`);
    console.log("=== RATE LIMIT DEBUG END: ALLOWED (WHITELIST) ===");
    return true;
  }

  // Step 2: Proceed with database rate-limiting for all other users
  const IP_LIMIT = 100;
  const GLOBAL_LIMIT = 1000;
  const today = new Date().toISOString().split("T")[0]; // Gets date as YYYY-MM-DD

  console.log("Today's date:", today);
  console.log("IP Limit:", IP_LIMIT);
  console.log("Global Limit:", GLOBAL_LIMIT);

  // Define references to the documents in our database
  const ipDocRef = firestore
    .collection("ip-usage")
    .doc(`${ipAddress}_${today}`);
  const globalDocRef = firestore.collection("global-usage").doc(today);

  console.log("IP Document ID:", `${ipAddress}_${today}`);
  console.log("Global Document ID:", today);

  // Use a transaction to safely read and update counts
  try {
    console.log("Starting Firestore transaction...");

    const result = await firestore.runTransaction(async (transaction) => {
      console.log("Inside transaction - fetching documents...");

      const ipDoc = await transaction.get(ipDocRef);
      const globalDoc = await transaction.get(globalDocRef);

      console.log("IP document exists:", ipDoc.exists);
      console.log("Global document exists:", globalDoc.exists);

      const ipCount = ipDoc.exists ? ipDoc.data().count : 0;
      const globalCount = globalDoc.exists ? globalDoc.data().count : 0;

      console.log("Current IP count:", ipCount);
      console.log("Current global count:", globalCount);

      // Check if either limit has been reached
      if (ipCount >= IP_LIMIT) {
        console.log("IP LIMIT EXCEEDED:", ipCount, ">=", IP_LIMIT);
        return false; // Deny the request
      }

      if (globalCount >= GLOBAL_LIMIT) {
        console.log("GLOBAL LIMIT EXCEEDED:", globalCount, ">=", GLOBAL_LIMIT);
        return false; // Deny the request
      }

      console.log("Limits OK - updating counts...");
      console.log("New IP count will be:", ipCount + 1);
      console.log("New global count will be:", globalCount + 1);

      // If limits are okay, increment and save the new counts
      transaction.set(ipDocRef, { count: ipCount + 1 }, { merge: true });
      transaction.set(
        globalDocRef,
        { count: globalCount + 1 },
        { merge: true }
      );

      console.log("Transaction completed successfully");
      return true; // Allow the request
    });

    console.log("Transaction result:", result);
    console.log(
      "=== RATE LIMIT DEBUG END: " + (result ? "ALLOWED" : "DENIED") + " ==="
    );
    return result;
  } catch (e) {
    console.error("=== TRANSACTION FAILURE ===");
    console.error("Error type:", e.constructor.name);
    console.error("Error message:", e.message);
    console.error("Error stack:", e.stack);
    console.error("Full error object:", e);
    console.log("=== RATE LIMIT DEBUG END: DENIED (ERROR) ===");
    return false; // Block request if the database transaction fails for any reason
  }
}

// --- API Handler Functions ---

// Handles Google Text-to-Speech requests
async function handleTTS(text) {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
  const body = {
    input: { text },
    voice: { languageCode: "en-GB", name: "en-GB-Chirp3-HD-Algenib" },
    audioConfig: { audioEncoding: "MP3" },
  };
  const response = await axios.post(url, body);
  return response.data.audioContent;
}

// Handles OpenAI requests
async function handleOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
  };
  const headers = { Authorization: `Bearer ${apiKey}` };
  const response = await axios.post(url, body, { headers: headers });
  return response.data.choices[0].message.content;
}

// Handles Google Gemini requests
async function handleGemini(prompt) {
  // Get the generative model
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  // Generate content
  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();
  return text;
}
