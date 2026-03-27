import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { initializeApp, cert, getApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin (using environment variables if available, or default)
if (!getApps().length) {
  initializeApp();
}
const db = getFirestore();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia" as any,
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cookieParser());
  
  // Stripe Webhook (must be before express.json())
  app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig!,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (err: any) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.metadata?.userId;
          const customerId = session.customer as string;

          if (userId) {
            await db.collection("users").doc(userId).set({
              isSubscribed: true,
              stripeCustomerId: customerId,
              subscriptionId: session.subscription as string,
              updatedAt: new Date()
            }, { merge: true });
            console.log(`User ${userId} subscribed successfully.`);
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;

          const userQuery = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
          if (!userQuery.empty) {
            const userDoc = userQuery.docs[0];
            await userDoc.ref.update({
              isSubscribed: false,
              updatedAt: new Date()
            });
            console.log(`User ${userDoc.id} subscription deleted.`);
          }
          break;
        }
        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = subscription.customer as string;
          const status = subscription.status;

          const userQuery = await db.collection("users").where("stripeCustomerId", "==", customerId).limit(1).get();
          if (!userQuery.empty) {
            const userDoc = userQuery.docs[0];
            await userDoc.ref.update({
              isSubscribed: status === "active" || status === "trialing",
              updatedAt: new Date()
            });
            console.log(`User ${userDoc.id} subscription updated to ${status}.`);
          }
          break;
        }
        default:
          console.log(`Unhandled event type ${event.type}`);
      }
    } catch (err: any) {
      console.error(`Error processing webhook ${event.type}:`, err);
      return res.status(500).send("Internal Server Error");
    }

    res.json({ received: true });
  });

  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/create-checkout-session", async (req, res) => {
    const { priceId, userId, email } = req.body;

    try {
      // Check if user already has a Stripe customer ID
      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.data();
      let customerId = userData?.stripeCustomerId;

      if (!customerId) {
        // Create a new customer if they don't have one
        const customer = await stripe.customers.create({
          email: email,
          metadata: { userId },
        });
        customerId = customer.id;
        // Save it immediately
        await db.collection("users").doc(userId).set({ stripeCustomerId: customerId }, { merge: true });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${process.env.APP_URL || 'http://localhost:3000'}/?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/pricing`,
        metadata: { userId },
      });

      res.json({ url: session.url });
    } catch (err: any) {
      console.error("Error creating checkout session:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
