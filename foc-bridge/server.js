require('dotenv').config();
const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const Joi = require('joi');

const app = express();
app.use(helmet());
app.use(cors({
    origin: ['https://futureoncampus.com', 'https://www.futureoncampus.com']
}));
app.use(express.json({ limit: '5mb' })); // Increased limit for large bulk objects

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const NEODOVE_API = process.env.NEODOVE_API_URL;
const COLLEGEDUNIA_KEY = process.env.COLLEGEDUNIA_SECRET_KEY || "FOC_SECURE_2026";

// --- UPDATED VALIDATION SCHEMA ---
const leadSchema = Joi.object({
    student_name: Joi.string().min(2).required(),
    student_email: Joi.string().email().allow('', null),
    student_contact: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    student_city: Joi.string().allow('', null),
    interested_city: Joi.string().allow('', null),
    interested_course: Joi.string().allow('', null),
    medium: Joi.string().default('COLLEGEDUNIA')
});

app.get('/status', (req, res) => {
    res.status(200).json({
        status: "Online",
        timestamp: new Date().toISOString(),
        bridge: "Future On Campus - Collegedunia Integration",
        config_status: process.env.NEODOVE_API_URL ? "Ready" : "Missing Config"
    });
});

// --- OPTIMIZED BRIDGE ROUTE (Solves 502 Timeout) ---
app.post('/api/leads/collegedunia', async (req, res) => {
    // 1. Auth Check
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey !== COLLEGEDUNIA_KEY) {
        console.error(`[AUTH ERROR] Unauthorized attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: "error", message: "Unauthorized." });
    }

    // 2. Normalize Input (Handle single object or array)
    const rawLeads = Array.isArray(req.body) ? req.body : [req.body];

    // 3. IMMEDIATE RESPONSE
    // We send a 202 Accepted status right away. This closes the connection with 
    // the sender (Collegedunia) so the request doesn't hit Render's timeout limit.
    res.status(202).json({ 
        status: "accepted", 
        message: `Received ${rawLeads.length} leads. Processing in background.`,
        request_id: new Date().getTime()
    });

    // 4. BACKGROUND PROCESSING
    // This function continues running even after the response is sent.
    const processInBackground = async () => {
        console.log(`[BATCH START] Processing ${rawLeads.length} leads...`);
        let success = 0;
        let failed = 0;

        for (const leadData of rawLeads) {
            const { error, value } = leadSchema.validate(leadData);
            
            if (error) {
                failed++;
                continue; 
            }

            try {
                // Robust Phone Cleaning
                let cleanMobile = value.student_contact.toString().replace(/\D/g, '');
                if (cleanMobile.length > 10) cleanMobile = cleanMobile.slice(-10);

                if (cleanMobile.length !== 10) {
                    failed++;
                    continue;
                }

                const neoDovePayload = {
                    name: value.student_name,
                    mobile: cleanMobile,
                    email: value.student_email || "no-email@foc.com",
                    detail1: value.interested_course || "General Inquiry", 
                    detail2: value.student_city || "Not Specified",     
                    detail3: value.interested_city || "Not Specified",  
                    source: "COLLEGEDUNIA",                    
                    medium: value.medium                       
                };

                // Push to NeoDove with a shorter timeout per request
                await axios.post(NEODOVE_API, neoDovePayload, { timeout: 3000 });
                success++;

            } catch (err) {
                failed++;
                console.error(`[SYNC FAILED] ${value.student_name}: ${err.message}`);
            }
        }
        console.log(`[BATCH COMPLETE] Success: ${success}, Failed: ${failed}`);
    };

    // Trigger the background task
    processInBackground();
});

app.listen(PORT, () => {
    console.log(`Future On Campus Bridge is Live on Port ${PORT}`);
});