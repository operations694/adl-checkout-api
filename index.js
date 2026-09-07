1	require('dotenv').config()
2	const express = require('express')
3	const cors = require('cors')
4	const Stripe = require('stripe')
5	
6	const app = express()
7	const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
8	
9	const FRONTEND_URL = process.env.FRONTEND_URL || 'https://adl-landscape-supplies.sintra.site'
10	const PORT = process.env.PORT || 3001
11	
12	// Accept requests from any origin — the backend only creates Stripe sessions,
13	// so there is no sensitive data to protect via CORS.
14	app.use(cors())
15	
16	// Raw body required for Stripe webhook signature verification
17	app.use('/api/webhook', express.raw({ type: 'application/json' }))
18	app.use(express.json())
19	
20	// ── Health check ─────────────────────────────────────────────────────────────
21	app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'ADL Checkout API' }))
22	
23	// ── Create Stripe Checkout Session ───────────────────────────────────────────
24	app.post('/api/create-checkout', async (req, res) => {
25	  try {
26	    const { items, customer, fulfillment, address, suburb, preferredDate, notes } = req.body
27	
28	    if (!items || !items.length) {
29	      return res.status(400).json({ error: 'No items provided' })
30	    }
31	
32	    const lineItems = items.map(item => {
33	      const totalCents = Math.round((item.priceCents || 0) * item.qty)
34	      return {
35	        price_data: {
36	          currency: 'aud',
37	          product_data: {
38	            name: `${item.name} — ${item.qty} ${item.unit}`,
39	            description: item.notes || undefined,
40	          },
41	          unit_amount: Math.max(totalCents, 1),
42	        },
43	        quantity: 1,
44	      }
45	    })
46	
47	    const metadata = {
48	      customer_name: customer?.name || '',
49	      customer_phone: customer?.phone || '',
50	      customer_email: customer?.email || '',
51	      fulfillment: fulfillment || 'pickup',
52	      address: fulfillment === 'delivery' ? `${address || ''}, ${suburb || ''}` : 'Yard pickup',
53	      preferred_date: preferredDate || 'ASAP',
54	      order_notes: notes || '',
55	      items_summary: items.map(i => `${i.name}: ${i.qty} ${i.unit}`).join(' | '),
56	    }
57	
58	    // Redirect back to wherever the request came from
59	    const origin = req.headers.origin || FRONTEND_URL
60	
61	    const session = await stripe.checkout.sessions.create({
62	      payment_method_types: ['card'],
63	      line_items: lineItems,
64	      mode: 'payment',
65	      success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
66	      cancel_url: `${origin}/cart`,
67	      customer_email: customer?.email || undefined,
68	      metadata,
69	      payment_intent_data: { metadata },
70	      billing_address_collection: 'auto',
71	      phone_number_collection: { enabled: true },
72	      custom_text: {
73	        submit: {
74	          message: fulfillment === 'delivery'
75	            ? 'We\'ll confirm your delivery time within business hours.'
76	            : 'We\'ll have your order ready at Keswick Terminal. We\'ll call to confirm.'
77	        }
78	      },
79	    })
80	
81	    res.json({ url: session.url, sessionId: session.id })
82	  } catch (err) {
83	    console.error('Checkout session error:', err)
84	    res.status(500).json({ error: err.message || 'Failed to create checkout session' })
85	  }
86	})
87	
88	// ── Stripe Webhook ────────────────────────────────────────────────────────────
89	app.post('/api/webhook', async (req, res) => {
90	  const sig = req.headers['stripe-signature']
91	  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
92	
93	  let event
94	  try {
95	    event = webhookSecret
96	      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
97	      : JSON.parse(req.body.toString())
98	  } catch (err) {
99	    console.error('Webhook signature error:', err.message)
100	    return res.status(400).send(`Webhook Error: ${err.message}`)
101	  }
102	
103	  if (event.type === 'checkout.session.completed') {
104	    await handleOrderConfirmed(event.data.object)
105	  }
106	
107	  res.json({ received: true })
108	})
109	
110	async function handleOrderConfirmed(session) {
111	  const m = session.metadata || {}
112	  const amountPaid = (session.amount_total / 100).toFixed(2)
113	
114	  const orderDetails = [
115	    `✅ PAYMENT CONFIRMED — $${amountPaid} AUD`,
116	    ``,
117	    `Customer: ${m.customer_name}`,
118	    `Phone: ${m.customer_phone}`,
119	    `Email: ${m.customer_email || session.customer_email || 'Not provided'}`,
120	    ``,
121	    `Fulfillment: ${m.fulfillment === 'delivery' ? `Delivery to ${m.address}` : 'Yard Pickup — Keswick Terminal'}`,
122	    `Preferred Date: ${m.preferred_date}`,
123	    ``,
124	    `ORDER ITEMS:`,
125	    ...(m.items_summary || '').split(' | ').map(i => `  • ${i}`),
126	    ``,
127	    m.order_notes ? `Notes: ${m.order_notes}` : '',
128	    `Stripe Session: ${session.id}`,
129	  ].filter(Boolean).join('\n')
130	
131	  try {
132	    await fetch('https://alluring-encouragement-production.up.railway.app/public/lead_v3', {
133	      method: 'POST',
134	      headers: { 'Content-Type': 'application/json' },
135	      body: JSON.stringify({
136	        name: m.customer_name || 'Online Customer',
137	        email: m.customer_email || session.customer_email || '',
138	        phone: m.customer_phone || '',
139	        message: orderDetails,
140	        source: 'ADL Website — Stripe Payment',
141	        type: 'paid_order',
142	      }),
143	    })
144	    console.log('Order notification sent:', session.id)
145	  } catch (err) {
146	    console.error('Failed to send order notification:', err)
147	  }
148	}
149	
150	// ── Retrieve session (for success page) ──────────────────────────────────────
151	app.get('/api/session/:id', async (req, res) => {
152	  try {
153	    const session = await stripe.checkout.sessions.retrieve(req.params.id, {
154	      expand: ['line_items'],
155	    })
156	    res.json({
157	      customerName: session.metadata?.customer_name || session.customer_details?.name || '',
158	      customerEmail: session.customer_email || session.customer_details?.email || '',
159	      amountTotal: session.amount_total,
160	      fulfillment: session.metadata?.fulfillment || 'pickup',
161	      address: session.metadata?.address || '',
162	      preferredDate: session.metadata?.preferred_date || '',
163	      itemsSummary: session.metadata?.items_summary || '',
164	    })
165	  } catch (err) {
166	    res.status(404).json({ error: 'Session not found' })
167	  }
168	})
169	
170	app.listen(PORT, () => {
171	  console.log(`ADL Checkout API running on port ${PORT}`)
172	})
173
