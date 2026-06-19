require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function verify() {
  console.log('=== Gemini API Key Verification ===\n');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('FAIL: No GEMINI_API_KEY found in server/.env');
    console.error('  → Get a free key at https://aistudio.google.com/apikey and add it.');
    process.exit(1);
  }

  console.log(`Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`Model: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}\n`);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
    
    console.log('Sending test prompt to Gemini...');
    const result = await model.generateContent('Say "Hello World! Gemini API key is working!"');
    const response = await result.response;
    const text = response.text();
    console.log(`\nResponse: "${text.trim()}"`);
    console.log('\n=== Success! Gemini API key is valid. ===');
  } catch (err) {
    console.error(`\nFAIL: ${err.message}`);
    console.error('  → Please verify that your API key is correct and active.');
    process.exit(1);
  }
}

verify();
