const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Stripe = require('stripe');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { validateCsv } = require('./validateCsvOutput');

const app = express();
const port = process.env.PORT || 3000;

/* ============================================================
   SERVICES
============================================================ */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const stripe = new Stripe(process.env.STRIPE_API_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ============================================================
   MIDDLEWARE
============================================================ */

app.use(cors());

/* ============================================================
   SHARED PROMPT BLOCK (Restored Rules)
============================================================ */

const DETAILED_EXTRACTION_PROMPT = `Analyze this financial document (invoice, receipt, statement, medical bill, bank statement, or financial report).

Extract every transactional line item into clean CSV rows.

Return exactly one row for each charge, payment, adjustment, refund, service, or transaction found in the document.

Use the following columns in this exact order:

Document Type,
Provider/Issuer Name,
Document/Account ID,
Transaction Date,
Line Item Description,
Quantity,
CPT/Procedure Code,
Gross Amount,
Adjustments/Discounts/Tax,
Net Responsibility,
Currency,
Issuer Contact Phone,
Issuer Mailing Address

Rules:

- Include a single header row as the first line, and do not repeat the header anywhere else in the output.
- Return one CSV row for every transaction or service line item.
- Repeat the Provider/Issuer Name, Contact Phone, and Mailing Address on every row.
- Preserve dates exactly as shown in the document.
- Separate Quantity and CPT/Procedure Code into different columns.
- True CPT/HCPCS/Procedure codes are numeric codes (e.g., 99205, 99214, 93010) or alphanumeric HCPCS codes (e.g., G2211). Only these belong in the CPT/Procedure Code column.
- Descriptive visit-level labels such as "New Patient," "Established Patient," "Level IV," or "Level V" are part of the Line Item Description, not the CPT/Procedure Code column.
- If a numeric CPT code and a visit-level label both appear in the same line item, place the code in CPT/Procedure Code and append the visit-level label to Line Item Description.
- Never place CPT codes, account numbers, invoice numbers, phone numbers, ZIP codes, document IDs, or other identifiers into any monetary column.
- Monetary columns (Gross Amount, Adjustments/Discounts/Tax, Net Responsibility) must contain only monetary values formatted with exactly two decimal places (e.g., 30.00, -4.56, 593.00). Do not include currency symbols.
- Populate the Currency column using the document's currency (USD, CAD, EUR, GBP, etc.). Infer USD whenever the document shows a U.S. address, U.S. phone number, or dollar amounts and no other currency is indicated. Only leave Currency blank if the currency truly cannot be inferred from any contextual clue in the document.
- Quantity should contain only numeric values when available. If no quantity exists, leave it blank.
- Leave any unknown or missing values blank rather than guessing.
- Preserve negative values for credits, discounts, refunds, or adjustments.
- Do not merge multiple transactions into a single row.
- Do not invent or infer information that is not present in the document.
- Every row must contain exactly 13 comma-separated fields, matching the 13 header columns, including trailing commas for any blank fields at the end of a row.
- If any field contains a comma, line break, or double quote, wrap that field in double quotes and escape internal double quotes by doubling them, per standard CSV escaping rules.
- Return only raw CSV rows.
- Do not include Markdown, code blocks, explanations, notes, or additional text.`;

/* ============================================================
   HELPER FUNCTION
============================================================ */

async function upsertSubscription(subscription, status) {
  const customerId = subscription.customer;
  const userId = subscription.metadata?.user_id || null;
  const priceId = subscription.items?.data?.[0]?.price?.id || null;

  const planName =
    priceId === process.env.STARTER_PRICE_ID ? 'starter' :
    priceId === process.env.PRO_PRICE_ID ? 'pro' :
    priceId === process.env.BUSINESS_PRICE_ID ? 'business' : 'free';

  const payload = {
    firebase_uid: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan_name: planName,
    status: status,
    price_id: priceId,
    current_period_end: subscription.current_period_end
       ? new Date(subscription.current_period_end * 1000)
      : null,
    cancel_at_period_end: subscription.cancel_at_period_end || false,
    updated_at: new Date(),
  };

  await supabase
    .from('Subscriptions')
    .upsert(payload, { onConflict: 'stripe_customer_id' });
}

/* ============================================================
   STRIPE WEBHOOK
============================================================ */

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            await upsertSubscription(subscription, 'active');
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          await upsertSubscription(subscription, subscription.status);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          await upsertSubscription(subscription, 'canceled');
          break;
        }
      }
      return res.json({ received: true });
    } catch (err) {
      return res.status(500).json({ error: 'Webhook processing failed.' });
    }
  }
);

/* ============================================================
   NORMAL JSON PARSER & MULTER STORAGE CONFIG
============================================================ */

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

/* ============================================================
   HEALTH ROUTES
============================================================ */

app.get('/', (req, res) => res.send('PDF CSV Extractor API Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ============================================================
   USAGE LIMIT ENFORCEMENT MIDDLEWARE
============================================================ */

async function checkUsageLimit(req, res, next) {
  const { firebase_uid } = req.body; 
  if (!firebase_uid) return res.status(400).json({ error: "Missing firebase_uid" });

  try {
    const { data: subscription } = await supabase
      .from('Subscriptions')
      .select('status, plan_name')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    const currentPlan = (subscription && subscription.status === 'active') ? subscription.plan_name : 'free';
    if (currentPlan !== 'free') return next();

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0,0,0,0);

    const { count, error } = await supabase
      .from('Extractions')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_uid', firebase_uid)
      .gte('created_at', startOfMonth.toISOString());

    if (error) throw error;

    const incomingFilesCount = req.files ? req.files.length : (req.file ? 1 : 0); 
    const totalProjectedCount = count + incomingFilesCount;
    
    const FREE_LIMIT = 10;
    if (totalProjectedCount > FREE_LIMIT) {
      return res.status(403).json({ 
        error: "Limit reached", 
        message: `Upgrade your tier to process more files.`,
        limitReached: true 
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: "Server check error" });
  }
}

/* ============================================================
   GET SUBSCRIPTION ROUTE
============================================================ */

app.post('/get-subscription-status', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const { data, error } = await supabase
      .from('Subscriptions')
      .select('plan_name, status, current_period_end, cancel_at_period_end')
      .eq('firebase_uid', uid)
      .single();

    if (error || !data) {
      return res.json({ plan: 'free', status: 'inactive', current_period_end: null, cancel_at_period_end: false });
    }

    return res.json({
      plan: data.plan_name || 'free',
      status: data.status || 'inactive',
      current_period_end: data.current_period_end,
      cancel_at_period_end: data.cancel_at_period_end,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CHECKOUT SESSION ROUTE
============================================================ */

app.post('/create-checkout-session', async (req, res) => {
  const { priceId, userId, successUrl, cancelUrl } = req.body;
  if (!priceId || !userId) return res.status(400).json({ error: 'priceId and userId are required.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { user_id: userId } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return res.json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   EXTRACTION ROUTE - SINGLE FILE
============================================================ */

app.post('/extract-invoice', upload.single('file'), checkUsageLimit, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const pdfBase64 = req.file.buffer.toString('base64');

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "user",
                content: [
                    { 
                        type: "text", 
                        text: DETAILED_EXTRACTION_PROMPT
                    },
                    {
                        type: "file",
                        file: {
                           filename: "invoice.pdf",
                           file_data: "data:application/pdf;base64," + pdfBase64
                        }
                    }
                ]
            }
        ]
    });

    const rawCsv = response.choices[0].message.content;
    const result = validateCsv(rawCsv);

    res.setHeader('Content-Type', 'text/csv');
    return res.status(200).send(result.cleanedCsv);

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error during extraction.' });
  }
});

/* ============================================================
   EXTRACTION ROUTE - BATCH MULTI-FILE
============================================================ */

app.post('/extract-csv', upload.array('files'), checkUsageLimit, async (req, res) => { 
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded." });

    const allCsvRows = [];
    let headersAdded = false;

    for (const file of req.files) {
      try {
        const pdfBase64 = file.buffer.toString('base64');

        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: DETAILED_EXTRACTION_PROMPT
                },
                {
                  type: "file",
                  file: {
                    filename: "invoice.pdf",
                    file_data: "data:application/pdf;base64," + pdfBase64
                  }
                }
              ]
            }
          ]
        });

        if (response.choices && response.choices[0]) {
          const rawCsv = response.choices[0].message.content || '';
          const cleanText = rawCsv.replace(/```csv/g, '').replace(/```/g, '').trim();
          const cleanLines = cleanText.split('\n').filter(line => line.trim() !== '');

          if (cleanLines.length > 0) {
            // Include headers exactly once from the first parsed document
            if (!headersAdded) {
              allCsvRows.push(cleanLines[0]); 
              headersAdded = true;
            }
            allCsvRows.push(...cleanLines.slice(1));
          }
        }
      } catch (fileError) {
        console.error(fileError);
      }
    }

    const finalCsvString = allCsvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=extracted_data.csv');
    return res.status(200).send(finalCsvString);

  } catch (error) {
    return res.status(500).json({ error: "Internal batch error" });
  }
});   

/* ============================================================
   SERVER LISTENER
============================================================ */

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
