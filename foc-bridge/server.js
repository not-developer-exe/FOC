require('dotenv').config();
const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const Joi = require('joi');

const app = express();
app.use(helmet());
app.use(cors({ origin: ['https://futureoncampus.com', 'https://www.futureoncampus.com'] }));
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const COLLEGEDUNIA_KEY = process.env.COLLEGEDUNIA_SECRET_KEY;

// --- CONFIGURATION: ZONE MAPPING ---
// This moves your UUIDs out of .env and into a structured map
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

let refundLog = []; 

const leadSchema = Joi.object({
    student_name: Joi.string().min(2).required(),
    student_email: Joi.string().email().allow('', null),
    student_contact: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    student_city: Joi.string().allow('', null),
    interested_city: Joi.string().allow('', null),
    interested_course: Joi.string().allow('', null),
    medium: Joi.string().default('COLLEGEDUNIA')
});

// --- API ENDPOINTS ---

// Check server status
app.get('/status', (req, res) => {
    res.status(200).json({ status: "Online", bridge: "FOC Multi-Zone Bridge" });
});

// Retrieve refund reports for the owner
app.get('/api/leads/refunds', (req, res) => {
    res.status(200).json({ total: refundLog.length, entries: refundLog });
});

// Clear report after submission
app.delete('/api/leads/refunds', (req, res) => {
    refundLog = [];
    res.status(200).json({ message: "Refund report cleared." });
});

// --- THE MULTI-ZONE BRIDGE ROUTE ---
// Partners will now send to /api/leads/central or /api/leads/south
app.post('/api/leads/:zone', async (req, res) => {
    const { zone } = req.params;
    const incomingKey = req.headers['x-api-key'];

    if (incomingKey !== COLLEGEDUNIA_KEY) return res.status(401).json({ error: "Unauthorized." });
    if (!ZONE_MAP[zone]) return res.status(404).json({ error: "Zone not found. Use 'central' or 'south'." });

    const rawLeads = Array.isArray(req.body) ? req.body : [req.body];

    // Immediate response to prevent timeouts
    res.status(202).json({ 
        status: "accepted", 
        zone: ZONE_MAP[zone].name,
        count: rawLeads.length,
        message: "Processing in background." 
    });

    // Background processing
    processZoneBatch(rawLeads, zone);
});

async function processZoneBatch(leads, zoneKey) {
    const config = ZONE_MAP[zoneKey];
    const seenInBatch = new Set();

    for (const lead of leads) {
        const { error, value } = leadSchema.validate(lead);
        if (error) {
            refundLog.push({ ...lead, zone: zoneKey, reason: `Validation: ${error.message}` });
            continue;
        }

        let mobile = value.student_contact.toString().replace(/\D/g, '').slice(-10);

        // Local Duplicate Check
        if (seenInBatch.has(mobile)) {
            refundLog.push({ ...lead, zone: zoneKey, reason: "Duplicate in file" });
            continue;
        }
        seenInBatch.add(mobile);

        try {
            await axios.post(config.url, {
                name: value.student_name,
                mobile: mobile,
                email: value.student_email || "no-email@foc.com",
                interested_course: value.interested_course,
                student_city: value.student_city,
                interested_city: value.interested_city,
                source: zoneKey.toUpperCase(),
                medium: value.medium
            }, { timeout: 5000 });

            // Throttling to prevent CRM API blocks
            await new Promise(resolve => setTimeout(resolve, 150));

        } catch (err) {
            const isDupe = err.response && (err.response.status === 409 || JSON.stringify(err.response.data).toLowerCase().includes("duplicate"));
            refundLog.push({ 
                ...lead, 
                zone: zoneKey, 
                reason: isDupe ? "Duplicate in CRM" : `Error: ${err.message}` 
            });
        }
    }
}

app.listen(PORT, () => console.log(`FOC Multi-Zone Bridge Live on Port ${PORT}`));