require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json());

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

app.get('/', (req, res) => res.json({ status: 'Silbis chatbot activo 🍔' }));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
