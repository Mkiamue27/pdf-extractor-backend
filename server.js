const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Stripe = require('stripe');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { validateCsv, HEADER, toCsvLine } = require('./validateCsvOutput');

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

  console.log('Price ID received:', priceId);
  console.log('Plan name resolved:', planName);
  console.log('current_period_end raw:', subscription.current_period_end);

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

  const { error } = await supabase
    .from('Subscriptions')
    .upsert(payload, { onConflict: 'stripe_customer_id' });

  if (error) {
    console.error('Supabase upsert error:', error.message);
  } else {
    console.log('Supabase subscription updated:', customerId);
  }
}

/* ============================================================
   STRIPE WEBHOOK
   MUST COME BEFORE express.json()
============================================================ */

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        endpointSecret
      );
    } catch (err) {
      console.error('Webhook verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {

      switch (event.type) {

        case 'checkout.session.completed': {
          const session = event.data.object;
          console.log('Checkout Completed');

          if (session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(
              session.subscription
            );
            await upsertSubscription(subscription, 'active');
          }

          break;
        }

        case 'customer.subscription.created': {
           const subscription = await stripe.subscriptions.retrieve(event.data.object.id);
           console.log('Subscription Created');
           await upsertSubscription(subscription, subscription.status);
           break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          console.log('Subscription Updated');
          await upsertSubscription(subscription, subscription.status);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          console.log('Subscription Deleted');
          await upsertSubscription(subscription, 'canceled');
          break;
        }

        default:
          console.log(`Unhandled event: ${event.type}`);
      }

      res.json({ received: true });

    } catch (err) {
      console.error(err);
      res.status(500).json({
        error: 'Webhook processing failed.',
      });
    }
  }
);

/* ============================================================
   NORMAL JSON PARSER
============================================================ */

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
});

/* ============================================================
   HEALTH ROUTES
============================================================ */

app.get('/', (req, res) => {
  res.send('PDF CSV Extractor API Running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/* ============================================================
   USAGE LIMIT MIDDLEWARE
   Must run AFTER multer (upload.single / upload.array) so that
   req.body and req.files are already populated.
============================================================ */

async function checkUsageLimit(req, res, next) {
  const { firebase_uid } = req.body;
  if (!firebase_uid) return res.status(400).json({ error: "Missing firebase_uid" });

  try {
    // 1. Fetch user subscription status
    const { data: subscription } = await supabase
      .from('Subscriptions')
      .select('status, plan_name')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    const currentPlan = (subscription && subscription.status === 'active') ? subscription.plan_name : 'free';

    // If they are on a paid plan, skip the free cap checks completely
    if (currentPlan !== 'free') return next();

    // 2. Count current usage for the calendar month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count, error } = await supabase
      .from('Extractions')
      .select('*', { count: 'exact', head: true })
      .eq('firebase_uid', firebase_uid)
      .gte('created_at', startOfMonth.toISOString());

    if (error) throw error;

    // 3. Count incoming batch files (req.files for array uploads, else 1 for single)
    const incomingFilesCount = req.files ? req.files.length : 1;
    const totalProjectedCount = count + incomingFilesCount;

    const FREE_LIMIT = 10;
    if (totalProjectedCount > FREE_LIMIT) {
      const remainingRows = FREE_LIMIT - count;
      return res.status(403).json({
        error: "Limit reached",
        message: `You only have ${remainingRows} free extraction(s) left this month, but you uploaded ${incomingFilesCount} files. Please upgrade your tier to process them all.`,
        limitReached: true
      });
    }

    next();
  } catch (err) {
    console.error("Usage limit verification error:", err);
    return res.status(500).json({ error: "Server check error" });
  }
}

/* ============================================================
   GET SUBSCRIPTION ROUTE
============================================================ */

app.get('/get-subscription', async (req, res) => {
  const { uid } = req.query;

  if (!uid) {
    return res.status(400).json({ error: 'uid is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('Subscriptions')
      .select('plan_name, status, current_period_end, cancel_at_period_end')
      .eq('firebase_uid', uid)
      .single();

    if (error || !data) {
      return res.json({
        plan: 'free',
        status: 'inactive',
        current_period_end: null,
        cancel_at_period_end: false,
      });
    }

    res.json({
      plan: data.plan_name || 'free',
      status: data.status || 'inactive',
      current_period_end: data.current_period_end,
      cancel_at_period_end: data.cancel_at_period_end,
    });

  } catch (err) {
    console.error('Get subscription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CHECKOUT SESSION ROUTE
============================================================ */

app.post('/create-checkout-session', async (req, res) => {
  const { priceId, userId, successUrl, cancelUrl } = req.body;

  if (!priceId || !userId) {
    return res.status(400).json({
      error: 'priceId and userId are required.',
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          user_id: userId,
        },
      },
      success_url: successUrl || 'https://yourapp.com/success',
      cancel_url: cancelUrl || 'https://yourapp.com/cancel',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   SHARED EXTRACTION PROMPT
   (Used by both single-file and batch routes so behavior stays
   consistent regardless of how many files are uploaded.)
============================================================ */

const EXTRACTION_PROMPT = `Analyze this financial document (invoice, receipt, statement, medical bill, bank statement, or financial report).

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

- Include a single header row as the first line, and do not repeat the header anywhere else in the output. Under no circumstances repeat the header row anywhere in the output, including inside markdown formatting such as bold or italics.
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
   EXTRACTION ROUTES
============================================================ */

// Single-file extraction
app.post('/extract-invoice', upload.single('file'), checkUsageLimit, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded under the field name "file".' });
        }

        const pdfBase64 = req.file.buffer.toString('base64');

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: EXTRACTION_PROMPT,
                        },
                        {
                            type: "file",
                            file: {
                               filename: "invoice.pdf",
                               file_data: "data:application/pdf;base64," + pdfBase64
                            }
                        }
                    ]
                },
            ]
        });

        const rawCsv = response.choices[0].message.content;
        const result = validateCsv(rawCsv);

        if (!result.valid) {
            console.warn('CSV validation issues:', result.errors);
        }

        res.setHeader('Content-Type', 'text/csv');
        return res.status(200).send(result.cleanedCsv);

    } catch (error) {
        console.error('Extraction Endpoint Error:', error.message);
        return res.status(500).json({ error: 'Internal server error during PDF extraction.' });
    }
});

// Multi-file batch extraction
app.post('/extract-csv', upload.array('files'), checkUsageLimit, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    // Collect validated rows from every file into one combined dataset,
    // rather than trusting each file's raw text directly.
    const allRows = [];
    const allErrors = [];

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
                  text: EXTRACTION_PROMPT
                },
                {
                  type: "file",
                  file: {
                    filename: file.originalname || "invoice.pdf",
                    file_data: "data:application/pdf;base64," + pdfBase64
                  }
                }
              ]
            }
          ]
        });

        const rawCsv = response.choices[0]?.message?.content || '';
        const result = validateCsv(rawCsv);

        if (!result.valid) {
          console.warn(`CSV validation issues for ${file.originalname}:`, result.errors);
          allErrors.push({ file: file.originalname, errors: result.errors });
        }

        // result.rows already excludes header rows and pads short rows,
        // so we only need the data rows here — the combined header gets
        // added once at the very end.
        allRows.push(...result.rows);

      } catch (fileError) {
        console.error(`Failed to process file ${file.originalname}:`, fileError.message);
        allErrors.push({ file: file.originalname, errors: [fileError.message] });
        // Continue processing remaining files even if one fails
      }
    }

    // Build one combined CSV from the shared HEADER + every file's rows.
    const finalCsvString = [HEADER, ...allRows].map(toCsvLine).join('\n');

    if (allErrors.length > 0) {
      console.warn('Batch extraction completed with some issues:', allErrors);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=extracted_data.csv');
    return res.status(200).send(finalCsvString);

  } catch (error) {
    console.error("Batch extraction endpoint error:", error);
    return res.status(500).json({ error: "Internal server extraction error" });
  }
});

/* ============================================================
   SERVER
============================================================ */

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
