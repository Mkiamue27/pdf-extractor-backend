const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Stripe = require('stripe');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

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
   EXTRACTION ROUTES
============================================================ */

app.post('/extract-invoice', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded under the field name "file".' });
        }

        // Convert file buffer to base64 for the OpenAI API payload
        const pdfBase64 = req.file.buffer.toString('base64');

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: text: "Convert the text content of this invoice into raw CSV rows. Provide columns for Invoice Number, Invoice Date, Bill To, Address, Phone, Email, Description, Quantity, Unit Price, and Total. Return only the raw CSV rows without markdown blocks." 
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

        const extractedCsv = response.choices[0].message.content;

        res.setHeader('Content-Type', 'text/csv');
        return res.status(200).send(extractedCsv);

    } catch (error) {
        console.error('Extraction Endpoint Error:', error.message);
        return res.status(500).json({ error: 'Internal server error during PDF extraction.' });
    }
});

/* ============================================================
   SERVER
============================================================ */

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
