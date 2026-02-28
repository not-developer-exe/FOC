require('dotenv').config();
const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const Joi = require('joi');
const rateLimit = require('express-rate-limit'); // New dependency for security

const app = express();
app.use(helmet());
app.use(cors({ origin: ['https://futureoncampus.com', 'https://www.futureoncampus.com'] }));
app.use(express.json({ limit: '15mb' }));

// Prevents brute-force or accidental DoS from partners
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});
app.use('/api/', limiter);

const PORT = process.env.PORT || 3000;
const COLLEGEDUNIA_KEY = process.env.COLLEGEDUNIA_SECRET_KEY;

const ZONE_MAP = {
    'central': {
        name: 'Central Zone',
        url: 'https://15dcccc1-084b-492a-8444-28992cd90433.neodove.com/integration/custom/e37b53e9-d4a4-45ad-9229-cf808235f1fa/leads'
    },
    'south': {
        name: 'South Zone',
        url: 'https://15dcccc1-084b-492a-8444-28992cd90433.neodove.com/integration/custom/31814184-5242-467a-817f-c1770d451110/leads'
    }
};

// In a real "Stark" lab, we'd use Redis or MongoDB here. 
// For now, I've kept the array but added timestamps for better reporting.
let refundLog = []; 

const leadSchema = Joi.object({
    student_name: Joi.string().trim().min(2).required(),
    student_email: Joi.string().email().lowercase().allow('', null),
    student_contact: Joi.string().pattern(/^[0-9]+$/).min(10).required(),
    student_city: Joi.string().allow('', null),
    interested_city: Joi.string().allow('', null),
    interested_course: Joi.string().allow('', null),
    medium: Joi.string().default('COLLEGEDUNIA')
});

// --- API ENDPOINTS ---

app.get('/status', (req, res) => {
    res.status(200).json({ 
        status: "Online", 
        uptime: process.uptime(),
        zones: Object.keys(ZONE_MAP) 
    });
});

app.get('/api/leads/refunds', (req, res) => {
    res.status(200).json({ 
        total: refundLog.length, 
        last_updated: new Date().toISOString(),
        entries: refundLog 
    });
});

app.delete('/api/leads/refunds', (req, res) => {
    refundLog = [];
    res.status(200).json({ message: "Refund report cleared." });
});

// --- IMPROVED PROCESSING ROUTE ---
app.post('/api/leads/:zone', async (req, res) => {
    const { zone } = req.params;
    const incomingKey = req.headers['x-api-key'];

    if (incomingKey !== COLLEGEDUNIA_KEY) return res.status(401).json({ error: "Unauthorized access attempt." });
    if (!ZONE_MAP[zone]) return res.status(404).json({ error: "Invalid Zone." });

    const rawLeads = Array.isArray(req.body) ? req.body : [req.body];

    // Send 202 Accepted immediately
    res.status(202).json({ 
        status: "accepted", 
        zone: ZONE_MAP[zone].name,
        count: rawLeads.length,
        received_at: new Date().toISOString()
    });

    // Fire and forget background task
    setImmediate(() => processZoneBatch(rawLeads, zone));
});

async function processZoneBatch(leads, zoneKey) {
    const config = ZONE_MAP[zoneKey];
    const seenInBatch = new Set();

    for (const lead of leads) {
        try {
            const { error, value } = leadSchema.validate(lead);
            
            if (error) {
                addToRefundLog(lead, zoneKey, `Validation: ${error.details[0].message}`);
                continue;
            }

            const mobile = value.student_contact.toString().replace(/\D/g, '').slice(-10);

            if (seenInBatch.has(mobile)) {
                addToRefundLog(lead, zoneKey, "Duplicate in current batch");
                continue;
            }
            seenInBatch.add(mobile);

            await axios.post(config.url, {
                name: value.student_name,
                mobile: mobile,
                email: value.student_email || "no-email@foc.com",
                interested_course: value.interested_course,
                student_city: value.student_city,
                interested_city: value.interested_city,
                source: zoneKey.toUpperCase(),
                medium: value.medium
            }, { timeout: 8000 }); // Increased timeout for slower CRM responses

            // Slightly dynamic throttling
            await new Promise(r => setTimeout(r, 200));

        } catch (err) {
            const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            const isDupe = errorMsg.toLowerCase().includes("duplicate") || err.response?.status === 409;
            
            addToRefundLog(lead, zoneKey, isDupe ? "Duplicate in CRM" : `External Error: ${errorMsg}`);
        }
    }
}

function addToRefundLog(lead, zone, reason) {
    refundLog.push({
        timestamp: new Date().toISOString(),
        zone,
        reason,
        data: lead
    });
    // Optional: Keep log size manageable in memory
    if (refundLog.length > 1000) refundLog.shift(); 
}

app.listen(PORT, () => console.log(`🚀 Bridge active on port ${PORT}`));