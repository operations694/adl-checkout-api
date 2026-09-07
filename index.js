require('dotenv').config()
const express = require('express')
const cors = require('cors')
const Stripe = require('stripe')

const app = express()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'
const PORT = process.env.PORT || 3001

// ── Allowed origins ──────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:3000',
  'https://adl-landscape-supplies.sintra.site',
  FRONTEND_URL,
].filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true)
    cb(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST'],
}))

// Raw body required for Stripe webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ADL Checkout API' }))

// ── Create Stripe Checkout Session ───────────────────────────────────────────
// Body: { items: [{ name, qty, unit, priceCents }], customer: { name, phone, email }, fulfillment, address, notes }
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { items, customer, fulfillment, address, suburb, preferredDate, paymentNotes, notes } = req.body

    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items provided' })
    }

    // Build Stripe line items — qty is decimal so we embed it in the product name
    // and set quantity=1 with unit_amount = price × qty
    const lineItems = items.map(item => {
      const totalCents = Math.round(item.priceCents * item.qty)
      return {
        price_data: {
          currency: 'aud',
          product_data: {
            name: `${item.name} — ${item.qty} ${item.unit}`,
            description: item.notes || undefined,
          },
          unit_amount: Math.max(totalCents, 1),
        },
        quantity: 1,
      }
    })

    // Metadata stored on the session for webhook / fulfilment reference
    const metadata = {
      customer_name: customer?.name || '',
      customer_phone: customer?.phone || '',
      customer_email: customer?.email || '',
      fulfillment: fulfillment || 'pickup',
      address: fulfillment === 'delivery' ? `${address || ''}, ${suburb || ''}` : 'Yard pickup',
      preferred_date: preferredDate || 'ASAP',
      order_notes: notes || '',
      items_summary: items.map(i => `${i.name}: ${i.qty} ${i.unit}`).join(' | '),
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/cart`,
      customer_email: customer?.email || undefined,
      metadata,
      payment_intent_data: { metadata },
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      custom_text: {
        submit: {
          message: fulfillment === 'delivery'
            ? 'We\'ll confirm your delivery time and pricing within business hours.'
            : 'We\'ll have your order ready at Keswick Terminal. We\'ll call to confirm.'
        }
      },
    })

    res.json({ url: session.url, sessionId: session.id })
  } catch (err) {
    console.error('Checkout session error:', err)
    res.status(500).json({ error: err.message || 'Failed to create checkout session' })
  }
})

// ── Stripe Webhook ────────────────────────────────────────────────────────────
// Handles payment confirmation and sends order notification to ADL
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  let event
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body.toString())
  } catch (err) {
    console.error('Webhook signature error:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    await handleOrderConfirmed(session)
  }

  res.json({ received: true })
})

async function handleOrderConfirmed(session) {
  const m = session.metadata || {}
  const amountPaid = (session.amount_total / 100).toFixed(2)

  const orderDetails = [
    `✅ PAYMENT CONFIRMED — $${amountPaid} AUD`,
    ``,
    `Customer: ${m.customer_name}`,
    `Phone: ${m.customer_phone}`,
    `Email: ${m.customer_email || session.customer_email || 'Not provided'}`,
    ``,
    `Fulfillment: ${m.fulfillment === 'delivery' ? `Delivery to ${m.address}` : 'Yard Pickup — Keswick Terminal'}`,
    `Preferred Date: ${m.preferred_date}`,
    ``,
    `ORDER ITEMS:`,
    ...(m.items_summary || '').split(' | ').map(i => `  • ${i}`),
    ``,
    m.order_notes ? `Notes: ${m.order_notes}` : '',
    ``,
    `Stripe Session ID: ${session.id}`,
  ].filter(l => l !== undefined).join('\n')

  // Notify ADL via Sintra lead endpoint
  try {
    await fetch('https://alluring-encouragement-production.up.railway.app/public/lead_v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: m.customer_name || 'Online Customer',
        email: m.customer_email || session.customer_email || '',
        phone: m.customer_phone || '',
        message: orderDetails,
        source: 'ADL Website — Stripe Payment',
        type: 'paid_order',
      }),
    })
    console.log('Order notification sent for session:', session.id)
  } catch (err) {
    console.error('Failed to send order notification:', err)
  }
}

// ── Retrieve session (for success page) ──────────────────────────────────────
app.get('/api/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id, {
      expand: ['line_items'],
    })
    res.json({
      customerName: session.metadata?.customer_name || session.customer_details?.name || '',
      customerEmail: session.customer_email || session.customer_details?.email || '',
      amountTotal: session.amount_total,
      fulfillment: session.metadata?.fulfillment || 'pickup',
      address: session.metadata?.address || '',
      preferredDate: session.metadata?.preferred_date || '',
      itemsSummary: session.metadata?.items_summary || '',
    })
  } catch (err) {
    res.status(404).json({ error: 'Session not found' })
  }
})

app.listen(PORT, () => {
  console.log(`ADL Checkout API running on port ${PORT}`)
  console.log(`Frontend URL: ${FRONTEND_URL}`)
})
