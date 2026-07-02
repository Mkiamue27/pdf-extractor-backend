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

  const payload = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    status: status,
    price_id: subscription.items?.data?.[0]?.price?.id || null,
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
          const subscription = event.data.object;
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
   EXTRACTION ROUTES
============================================================ */

// Paste your /extract-invoice route here

/* ============================================================
   SERVER
============================================================ */

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
