const express = require('express')
const cors = require('cors')
const Stripe = require('stripe')

const app = express()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://adl-landscape-supplies.sintra.site'
const PORT = process.env.PORT || 3001

app.use(cors())
app.use('/api/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.post('/api/create-checkout', async (req, res) => {
  try {
    const { items, customer, fulfillment, address, suburb, preferredDate, notes } = req.body
    if (!items || !items.length) return res.status(400).json({ error: 'No items' })

    const lineItems = items.map(item => ({
      price_data: {
        currency: 'aud',
        product_data: { name: item.name + ' — ' + item.qty + ' ' + item.unit },
        unit_amount: Math.max(Math.round((item.priceCents || 0) * item.qty), 1),
      },
      quantity: 1,
    }))

    const metadata = {
      customer_name: customer?.name || '',
      customer_phone: customer?.phone || '',
      customer_email: customer?.email || '',
      fulfillment: fulfillment || 'pickup',
      address: fulfillment === 'delivery' ? (address + ', ' + suburb) : 'Yard pickup',
      preferred_date: preferredDate || 'ASAP',
      order_notes: notes || '',
      items_summary: items.map(i => i.name + ': ' + i.qty + ' ' + i.unit).join(' | '),
    }

    const origin = req.headers.origin || FRONTEND_URL

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: origin + '/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/cart',
      customer_email: customer?.email || undefined,
      metadata,
      payment_intent_data: { metadata },
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  let event
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString())
  } catch (err) {
    return res.status(400).send('Webhook Error: ' + err.message)
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object
    const m = s.metadata || {}
    const msg = [
      'PAYMENT CONFIRMED — $' + (s.amount_total / 100).toFixed(2) + ' AUD',
      'Customer: ' + m.customer_name,
      'Phone: ' + m.customer_phone,
      'Email: ' + (m.customer_email || s.customer_email || ''),
      'Fulfillment: ' + m.address,
      'Date: ' + m.preferred_date,
      'Items: ' + m.items_summary,
      m.order_notes ? 'Notes: ' + m.order_notes : '',
    ].filter(Boolean).join('\n')

    fetch('https://alluring-encouragement-production.up.railway.app/public/lead_v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: m.customer_name || 'Online Customer',
        email: m.customer_email || s.customer_email || '',
        phone: m.customer_phone || '',
        message: msg,
        source: 'ADL Website Stripe Payment',
        type: 'paid_order',
      }),
    }).catch(console.error)
  }

  res.json({ received: true })
})

app.get('/api/session/:id', async (req, res) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(req.params.id)
    res.json({
      customerName: s.metadata?.customer_name || '',
      customerEmail: s.customer_email || '',
      amountTotal: s.amount_total,
      fulfillment: s.metadata?.fulfillment || 'pickup',
      itemsSummary: s.metadata?.items_summary || '',
    })
  } catch (err) {
    res.status(404).json({ error: 'Not found' })
  }
})

app.listen(PORT, () => console.log('ADL Checkout API on port ' + PORT))
