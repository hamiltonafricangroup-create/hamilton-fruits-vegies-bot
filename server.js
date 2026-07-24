// ============================================================================
// WhatsApp Fruit & Vegetable Delivery Bot
// ----------------------------------------------------------------------------
// Handles: main menu, FAQs, full order taking, Individual vs Corporate
// detection, and sends order summaries to the business owner's WhatsApp.
//
// EDIT THESE WITHOUT TOUCHING CODE:
//   - products.json  -> your catalog & prices
//   - faqs.json       -> your frequently asked questions
//   - .env            -> business name, currency, owner number, tokens
// ============================================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const {
  WHATSAPP_TOKEN,          // permanent access token from Meta
  PHONE_NUMBER_ID,         // your WhatsApp Business phone number ID
  VERIFY_TOKEN,            // any string you choose, used to verify webhook
  OWNER_WHATSAPP_NUMBER,   // YOUR number (with country code, no +) to receive order alerts
  CATALOG_ID,              // your Commerce Manager catalog ID (for product photo cards)
  BUSINESS_NAME = "Our Fruit & Veg Delivery",
  CURRENCY = "KES",
  PORT = 3000,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// Fail loudly on startup instead of silently dropping orders later
const missingVars = [];
if (!WHATSAPP_TOKEN) missingVars.push("WHATSAPP_TOKEN");
if (!PHONE_NUMBER_ID) missingVars.push("PHONE_NUMBER_ID");
if (!VERIFY_TOKEN) missingVars.push("VERIFY_TOKEN");
if (!OWNER_WHATSAPP_NUMBER) missingVars.push("OWNER_WHATSAPP_NUMBER");
if (!CATALOG_ID) missingVars.push("CATALOG_ID (needed for product photo catalog)");
if (missingVars.length > 0) {
  console.warn(
    `⚠️  WARNING: Missing .env values: ${missingVars.join(", ")}.\n` +
    `   The bot will still run and reply to customers, but order alerts to the ` +
    `owner will NOT be sent until these are set in your .env file.`
  );
}

const PRODUCTS = JSON.parse(fs.readFileSync(path.join(__dirname, "products.json")));
const FAQS = JSON.parse(fs.readFileSync(path.join(__dirname, "faqs.json")));

// ---------------------------------------------------------------------------
// Very simple persistent session store (file-based, survives restarts)
// ---------------------------------------------------------------------------
const SESSIONS_FILE = path.join(__dirname, "sessions.json");

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE));
  } catch {
    return {};
  }
}
function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
function getSession(waId) {
  const sessions = loadSessions();
  if (!sessions[waId]) {
    sessions[waId] = { state: "MENU", cart: [], type: null, address: null, date: null, name: null };
    saveSessions(sessions);
  }
  return sessions[waId];
}
function setSession(waId, data) {
  const sessions = loadSessions();
  sessions[waId] = { ...sessions[waId], ...data };
  saveSessions(sessions);
  return sessions[waId];
}
function resetSession(waId) {
  setSession(waId, { state: "MENU", cart: [], type: null, address: null, date: null, name: null });
}

// ---------------------------------------------------------------------------
// WhatsApp send helpers
// ---------------------------------------------------------------------------
async function sendText(to, body) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function sendButtons(to, bodyText, buttons) {
  // buttons: [{ id, title }] max 3
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Sends a WhatsApp catalog message: photo cards for each product, with a
// native "Add to cart" flow. WhatsApp allows up to 30 product items per
// message, so 16 products fits comfortably in a single message.
async function sendProductList(to) {
  const productItems = PRODUCTS.map((p) => ({
    product_retailer_id: p.id, // must match the Retailer ID you set in Commerce Manager
  }));

  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "product_list",
        header: { type: "text", text: BUSINESS_NAME },
        body: { text: "Browse our catalog below and tap items to add them to your cart, then tap the cart icon to checkout." },
        footer: { text: "Cash on delivery available" },
        action: {
          catalog_id: CATALOG_ID,
          sections: [
            {
              title: "Available Produce",
              product_items: productItems,
            },
          ],
        },
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// ---------------------------------------------------------------------------
// Conversation logic
// ---------------------------------------------------------------------------
async function sendMainMenu(to) {
  await sendButtons(to, `Welcome to ${BUSINESS_NAME}! 🍎🥦\nWhat would you like to do?`, [
    { id: "MENU_ORDER", title: "Place an Order" },
    { id: "MENU_FAQ", title: "FAQs" },
    { id: "MENU_HUMAN", title: "Talk to a Person" },
  ]);
}

function findFaqAnswer(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQS) {
    if (faq.keywords.some((k) => lower.includes(k))) return faq.answer;
  }
  return null;
}

function cartSummary(cart) {
  if (cart.length === 0) return "Your cart is empty.";
  let total = 0;
  const lines = cart.map((item) => {
    const sub = item.qty * item.price;
    total += sub;
    return `• ${item.qty} ${item.unit} ${item.name} — ${CURRENCY} ${sub}`;
  });
  lines.push(`\nTotal: ${CURRENCY} ${total}`);
  return lines.join("\n");
}

async function notifyOwner(waId, session) {
  if (!OWNER_WHATSAPP_NUMBER) {
    console.error(
      `❌ Could not send order alert: OWNER_WHATSAPP_NUMBER is not set in .env. ` +
      `This order from ${waId} was NOT delivered to the owner.`
    );
    return;
  }
  const tag = session.type === "corporate" ? "🏢 CORPORATE ORDER" : "🙋 INDIVIDUAL ORDER";
  const msg =
    `${tag}\n\n` +
    `Customer: ${session.name}\n` +
    `Phone: ${waId}\n` +
    `Delivery address: ${session.address}\n` +
    `Requested date: ${session.date}\n\n` +
    `Items:\n${cartSummary(session.cart)}\n\n` +
    `Payment: Cash on delivery`;
  try {
    await sendText(OWNER_WHATSAPP_NUMBER, msg);
  } catch (err) {
    console.error("❌ Failed to send order alert to owner:", err.response?.data || err.message);
  }
}

async function handleMessage(waId, incoming) {
  const session = getSession(waId);
  const text = (incoming.text || "").trim();
  const lowerText = text.toLowerCase();

  // Global reset command
  if (["menu", "hi", "hello", "start"].includes(lowerText) && incoming.type === "text") {
    resetSession(waId);
    return sendMainMenu(waId);
  }

  switch (session.state) {
    // -----------------------------------------------------------------
    case "MENU": {
      const choice = incoming.buttonId;
      if (choice === "MENU_ORDER") {
        setSession(waId, { state: "ASK_TYPE" });
        return sendButtons(waId, "Are you ordering as an Individual or a Corporate client?", [
          { id: "TYPE_INDIVIDUAL", title: "Individual" },
          { id: "TYPE_CORPORATE", title: "Corporate" },
        ]);
      }
      if (choice === "MENU_FAQ") {
        setSession(waId, { state: "FAQ" });
        return sendText(waId, "Ask me anything about delivery, payment, or our produce. Type 'menu' anytime to go back.");
      }
      if (choice === "MENU_HUMAN") {
        setSession(waId, { state: "HUMAN" });
        return sendText(waId, `Sure — send your message and we'll get back to you personally as soon as possible.`);
      }
      return sendMainMenu(waId);
    }

    // -----------------------------------------------------------------
    case "ASK_TYPE": {
      const choice = incoming.buttonId;
      if (choice === "TYPE_INDIVIDUAL" || choice === "TYPE_CORPORATE") {
        setSession(waId, { type: choice === "TYPE_CORPORATE" ? "corporate" : "individual", state: "ORDERING" });
        await sendText(waId, "Great! Let's build your order.");
        return sendProductList(waId);
      }
      return sendButtons(waId, "Please choose one:", [
        { id: "TYPE_INDIVIDUAL", title: "Individual" },
        { id: "TYPE_CORPORATE", title: "Corporate" },
      ]);
    }

    // -----------------------------------------------------------------
    case "ORDERING": {
      // Customer checked out using the native WhatsApp catalog cart
      if (incoming.order) {
        const cart = [];
        const notFound = [];
        for (const item of incoming.order) {
          const product = PRODUCTS.find((p) => p.id === item.product_retailer_id);
          if (product) {
            cart.push({ name: product.name, unit: product.unit, price: product.price, qty: item.quantity });
          } else {
            notFound.push(item.product_retailer_id);
          }
        }
        if (cart.length === 0) {
          await sendText(waId, "Sorry, we couldn't match those items to our current catalog. Let's try again.");
          return sendProductList(waId);
        }
        setSession(waId, { cart, state: "ASK_ADDRESS" });
        if (notFound.length > 0) {
          await sendText(waId, `Note: some items in your cart are no longer available and were skipped.`);
        }
        await sendText(waId, `Great! Here's your cart:\n\n${cartSummary(cart)}`);
        return sendText(waId, "What's the delivery address?");
      }
      // Product picked from the old-style list (fallback, in case catalog isn't set up yet)
      if (incoming.listId && incoming.listId.startsWith("PROD_")) {
        const productId = incoming.listId.replace("PROD_", "");
        const product = PRODUCTS.find((p) => p.id === productId);
        if (!product) return sendProductList(waId);
        setSession(waId, { state: "ASK_QTY", pendingProduct: product });
        return sendText(waId, `How many ${product.unit} of ${product.name} would you like? (just type a number)`);
      }
      // No product picked yet — resend catalog
      return sendProductList(waId);
    }

    // -----------------------------------------------------------------
    case "ASK_QTY": {
      const qty = parseFloat(text);
      if (isNaN(qty) || qty <= 0) {
        return sendText(waId, "Please enter a valid quantity, e.g. 2");
      }
      const product = session.pendingProduct;
      const cart = [...session.cart, { name: product.name, unit: product.unit, price: product.price, qty }];
      setSession(waId, { cart, pendingProduct: null, state: "MORE_ITEMS" });
      await sendText(waId, `Added: ${qty} ${product.unit} ${product.name}\n\n${cartSummary(cart)}`);
      return sendButtons(waId, "Add another item, or checkout?", [
        { id: "ADD_MORE", title: "Add Another" },
        { id: "CHECKOUT", title: "Checkout" },
      ]);
    }

    // -----------------------------------------------------------------
    case "MORE_ITEMS": {
      const choice = incoming.buttonId;
      if (choice === "ADD_MORE") {
        setSession(waId, { state: "ORDERING" });
        return sendProductList(waId);
      }
      if (choice === "CHECKOUT") {
        if (session.cart.length === 0) {
          setSession(waId, { state: "ORDERING" });
          return sendProductList(waId);
        }
        setSession(waId, { state: "ASK_ADDRESS" });
        return sendText(waId, "What's the delivery address?");
      }
      return sendButtons(waId, "Add another item, or checkout?", [
        { id: "ADD_MORE", title: "Add Another" },
        { id: "CHECKOUT", title: "Checkout" },
      ]);
    }

    // -----------------------------------------------------------------
    case "ASK_ADDRESS": {
      if (!text) return sendText(waId, "Please type the delivery address.");
      setSession(waId, { address: text, state: "ASK_DATE" });
      return sendText(waId, "What date would you like this delivered? (e.g. 18 July, or 'tomorrow')");
    }

    // -----------------------------------------------------------------
    case "ASK_DATE": {
      if (!text) return sendText(waId, "Please type a preferred delivery date.");
      setSession(waId, { date: text, state: "ASK_NAME" });
      const prompt =
        session.type === "corporate"
          ? "What's your company name and your name (contact person)?"
          : "What name should we deliver under?";
      return sendText(waId, prompt);
    }

    // -----------------------------------------------------------------
    case "ASK_NAME": {
      if (!text) return sendText(waId, "Please provide a name.");
      const updated = setSession(waId, { name: text, state: "CONFIRM" });
      const summary =
        `Please confirm your order:\n\n` +
        `Type: ${updated.type === "corporate" ? "Corporate" : "Individual"}\n` +
        `Name: ${updated.name}\n` +
        `Address: ${updated.address}\n` +
        `Delivery date: ${updated.date}\n\n` +
        `${cartSummary(updated.cart)}\n\n` +
        `Payment: Cash on delivery`;
      await sendText(waId, summary);
      return sendButtons(waId, "Confirm this order?", [
        { id: "CONFIRM_YES", title: "Confirm" },
        { id: "CONFIRM_NO", title: "Start Over" },
      ]);
    }

    // -----------------------------------------------------------------
    case "CONFIRM": {
      const choice = incoming.buttonId;
      if (choice === "CONFIRM_YES") {
        await notifyOwner(waId, session);
        await sendText(
          waId,
          `Thank you! Your order has been received and we'll deliver to ${session.address} on ${session.date}. Payment is cash on delivery. 🙏`
        );
        resetSession(waId);
        return;
      }
      if (choice === "CONFIRM_NO") {
        resetSession(waId);
        await sendText(waId, "No problem, let's start again.");
        return sendMainMenu(waId);
      }
      return sendButtons(waId, "Confirm this order?", [
        { id: "CONFIRM_YES", title: "Confirm" },
        { id: "CONFIRM_NO", title: "Start Over" },
      ]);
    }

    // -----------------------------------------------------------------
    case "FAQ": {
      const answer = findFaqAnswer(text);
      if (answer) {
        await sendText(waId, answer);
      } else {
        await sendText(waId, "I'm not sure about that one — type 'menu' to go back, or ask another question.");
      }
      return;
    }

    // -----------------------------------------------------------------
    case "HUMAN": {
      // Just let the message through — owner should be monitoring WhatsApp
      // for messages in this state, or you can forward it via notifyOwner-style call.
      if (OWNER_WHATSAPP_NUMBER) {
        await sendText(OWNER_WHATSAPP_NUMBER, `💬 Message from ${waId} (wants a person): ${text}`);
      }
      return sendText(waId, "Got it, message forwarded. We'll reply soon. Type 'menu' to return to the main menu.");
    }

    // -----------------------------------------------------------------
    default: {
      resetSession(waId);
      return sendMainMenu(waId);
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

// Verification (Meta calls this once when you set up the webhook)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // acknowledge immediately, WhatsApp requires fast response

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return; // could be a status update, ignore

    const waId = message.from;
    let incoming = { type: message.type };

    if (message.type === "text") {
      incoming.text = message.text.body;
    } else if (message.type === "interactive") {
      const interactive = message.interactive;
      if (interactive.type === "button_reply") {
        incoming.buttonId = interactive.button_reply.id;
        incoming.text = interactive.button_reply.title;
      } else if (interactive.type === "list_reply") {
        incoming.listId = interactive.list_reply.id;
        incoming.text = interactive.list_reply.title;
      }
    } else if (message.type === "order") {
      // Customer used the native catalog cart and tapped checkout.
      // product_items: [{ product_retailer_id, quantity, item_price, currency }]
      incoming.order = message.order.product_items;
    } else {
      incoming.text = "";
    }

    await handleMessage(waId, incoming);
  } catch (err) {
    console.error("Error handling message:", err.response?.data || err.message);
  }
});

app.get("/", (req, res) => res.send("WhatsApp fruit & veg bot is running."));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
