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
app.use(express.json());

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
    medium: Joi.string().default('COLLEGEDUNIA') // Defaulting to the partner name
});

app.get('/status', (req, res) => {
    res.status(200).json({
        status: "Online",
        timestamp: new Date().toISOString(),
        bridge: "Future On Campus - Collegedunia Integration",
        config_status: process.env.NEODOVE_API_URL ? "Ready" : "Missing Config"
    });
});

// --- UPDATED BULK BRIDGE ROUTE ---
app.post('/api/leads/collegedunia', async (req, res) => {
    // 1. Auth Check
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey !== COLLEGEDUNIA_KEY) {
        console.error(`[AUTH ERROR] Unauthorized attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: "error", message: "Unauthorized." });
    }

    // 2. Normalize Input (Handle single object or array)
    const rawLeads = Array.isArray(req.body) ? req.body : [req.body];
    const results = { success: 0, failed: 0, errors: [] };

    // 3. Process Leads Loop
    for (const leadData of rawLeads) {
        const { error, value } = leadSchema.validate(leadData);
        
        if (error) {
            results.failed++;
            results.errors.push({ name: leadData.student_name || "Unknown", error: error.details[0].message });
            continue; 
        }

        try {
            // Robust Phone Cleaning
            let cleanMobile = value.student_contact.toString().replace(/\D/g, '');
            if (cleanMobile.length > 10) {
                cleanMobile = cleanMobile.slice(-10);
            }

            if (cleanMobile.length !== 10) {
                throw new Error("Mobile number must be exactly 10 digits.");
            }

            // 4. Final Payload Mapping to NeoDove
            const neoDovePayload = {
                name: value.student_name,
                mobile: cleanMobile,
                email: value.student_email || "no-email@foc.com",
                detail1: value.interested_course || "General Inquiry", 
                detail2: value.student_city || "Not Specified",     
                detail3: value.interested_city || "Not Specified",  // New field mapping
                source: "COLLEGEDUNIA",                    
                medium: value.medium                       
            };

            // 5. Execute Push to NeoDove
            await axios.post(NEODOVE_API, neoDovePayload, { timeout: 5000 });
            results.success++;
            console.log(`[SUCCESS] Lead synced: ${value.student_name}`);

        } catch (err) {
            results.failed++;
            results.errors.push({ name: value.student_name, error: err.message });
            console.error(`[SYNC FAILED] ${value.student_name}: ${err.message}`);
        }
    }

    // 6. Summary Response
    return res.status(200).json({ 
        status: "complete", 
        processed: rawLeads.length,
        success_count: results.success,
        failed_count: results.failed,
        errors: results.errors 
    });
});

app.listen(PORT, () => {
    console.log(`Future On Campus Bridge is Live on Port ${PORT}`);
});