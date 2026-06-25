const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Root check endpoint
app.get('/', (req, res) => {
  res.send('PDF CSV Extractor API Running');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// The Extraction Route
app.post(
  '/extract-invoice',
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded.' });
      }

      console.log('File received:', {
        name: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype,
      });

      // Convert document buffer to base64 string
      const base64Pdf = req.file.buffer.toString('base64');

      // Request structured output from OpenAI 
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: {
          type: 'json_object',
        },
        messages: [
          {
            role: 'system',
            content: 'Return only valid JSON with fields vendor, date, invoice_number, tax_amount',
          },
          {
            role: 'user',
            content: `Extract invoice information from this PDF data: ${base64Pdf}`,
          },
        ],
      });

      // Parse JSON from OpenAI
      const jsonString = response.choices[0].message.content;
      const data = JSON.parse(jsonString);

      // Convert parsed JSON into raw CSV row format strings
      const headers = 'vendor,date,invoice_number,tax_amount\n';
      const csvRow = `"${data.vendor || ''}","${data.date || ''}","${data.invoice_number || ''}","${data.tax_amount || ''}"\n`;
      const csvContent = headers + csvRow;

      // Send the text string back to FlutterFlow as a downloadable CSV content stream
      res.setHeader('Content-Type', 'text/csv');
      res.status(200).send(csvContent);

    } catch (error) {
      console.error('Extraction Error:', error);
      res.status(500).json({ error: 'Failed to extract invoice data.' });
    }
  }
);

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

