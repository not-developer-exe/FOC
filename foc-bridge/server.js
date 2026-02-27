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
app.use(express.json({ limit: '10mb' })); // Increased limit for heavy bulk batches

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const NEODOVE_API = process.env.NEODOVE_API_URL;
const COLLEGEDUNIA_KEY = process.env.COLLEGEDUNIA_SECRET_KEY || "FOC_SECURE_2026";

// In-memory store for duplicates (Note: Resets on server restart)
let duplicateLog = [];

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

// --- UTILITY ENDPOINTS ---

// Check server status
app.get('/status', (req, res) => {
    res.status(200).json({
        status: "Online",
        timestamp: new Date().toISOString(),
        bridge: "Future On Campus - Collegedunia Integration",
        config_status: process.env.NEODOVE_API_URL ? "Ready" : "Missing Config"
    });
});

// Retrieve duplicate/failed leads for refund claims
app.get('/api/leads/duplicates', (req, res) => {
    res.status(200).json({
        total_duplicates: duplicateLog.length,
        entries: duplicateLog
    });
});

// Clear the duplicate log
app.delete('/api/leads/duplicates', (req, res) => {
    duplicateLog = [];
    res.status(200).json({ message: "Duplicate log cleared." });
});

// --- THE MAIN BRIDGE ROUTE ---

app.post('/api/leads/collegedunia', async (req, res) => {
    // 1. Auth Check
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey !== COLLEGEDUNIA_KEY) {
        console.error(`[AUTH ERROR] Unauthorized attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: "error", message: "Unauthorized." });
    }

    // 2. Normalize Input (Handle single object or array)
    const rawLeads = Array.isArray(req.body) ? req.body : [req.body];

    // 3. IMMEDIATE RESPONSE (Prevents 502 Timeout)
    res.status(202).json({ 
        status: "accepted", 
        message: `Received ${rawLeads.length} leads. Processing in background.`,
        duplicate_check_url: "/api/leads/duplicates"
    });

    // 4. BACKGROUND PROCESSING FUNCTION
    const processLeads = async () => {
        console.log(`[BATCH START] Processing ${rawLeads.length} leads...`);
        let success = 0;
        const seenNumbers = new Set(); // Tracks numbers ALREADY processed in this batch
    
        for (const leadData of rawLeads) {
            const { error, value } = leadSchema.validate(leadData);
            
            if (error) {
                duplicateLog.push({ ...leadData, reason: `Validation: ${error.details[0].message}` });
                continue; 
            }
    
            try {
                let cleanMobile = value.student_contact.toString().replace(/\D/g, '');
                if (cleanMobile.length > 10) cleanMobile = cleanMobile.slice(-10);
    
                // --- NEW LOCAL DUPLICATE CHECK ---
                if (seenNumbers.has(cleanMobile)) {
                    console.warn(`[LOCAL DUPE] Skipping ${value.student_name} (${cleanMobile})`);
                    duplicateLog.push({ ...leadData, reason: "Duplicate within the same batch" });
                    continue; // Skip the API call to save time and capture for refund
                }
                seenNumbers.add(cleanMobile);
                // ---------------------------------
    
                const neoDovePayload = {
                    name: value.student_name,
                    mobile: cleanMobile,
                    student_email: value.student_email || "no-email@foc.com",
                    interested_course: value.interested_course || "General Inquiry", 
                    student_city: value.student_city || "Not Specified",     
                    interested_city: value.interested_city || "Not Specified",  
                    source: "COLLEGEDUNIA",                    
                    medium: value.medium                       
                };
    
                await axios.post(NEODOVE_API, neoDovePayload, { timeout: 4000 });
                success++;
    
            } catch (err) {
                const isDuplicate = err.response && (err.response.status === 409 || JSON.stringify(err.response.data).toLowerCase().includes("duplicate"));
                if (isDuplicate) {
                    duplicateLog.push({ ...leadData, reason: "Duplicate in CRM" });
                } else {
                    duplicateLog.push({ ...leadData, reason: `System Error: ${err.message}` });
                }
            }
        }
        console.log(`[BATCH COMPLETE] Success: ${success}, Refund Log: ${duplicateLog.length}`);
    };

    // Trigger processing
    processLeads();
});

app.listen(PORT, () => {
    console.log(`Future On Campus Bridge is Live on Port ${PORT}`);
});