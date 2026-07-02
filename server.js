const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Stripe = require('stripe');
const { OpenAI } = require('openai');
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

/* ============================================================
   MIDDLEWARE
============================================================ */

app.use(cors());

/*
============================================================
STRIPE WEBHOOK
MUST COME BEFORE express.json()
============================================================
*/

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
          console.log(session);

          // TODO:
          // Update Firebase/Supabase
          // Save Stripe Customer ID
          // Save Subscription ID
          // Activate User Plan

          break;
        }

        case 'customer.subscription.created': {

          const subscription = event.data.object;

          console.log('Subscription Created');
          console.log(subscription);

          // TODO:
          // Update subscription status

          break;
        }

        case 'customer.subscription.updated': {

          const subscription = event.data.object;

          console.log('Subscription Updated');
          console.log(subscription);

          // TODO:
          // Update subscription status

          break;
        }

        case 'customer.subscription.deleted': {

          const subscription = event.data.object;

          console.log('Subscription Deleted');
          console.log(subscription);

          // TODO:
          // Downgrade user to Free plan

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

/*
============================================================
NORMAL JSON PARSER
Everything below this line uses express.json()
============================================================
*/

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

/*
Paste your existing /extract-invoice route here.
No changes are required to that route.
*/

/* ============================================================
   SERVER
============================================================ */

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
