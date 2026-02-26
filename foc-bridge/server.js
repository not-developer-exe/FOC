require('dotenv').config();
const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
const Joi = require('joi'); // Run: npm install joi

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

// --- VALIDATION SCHEMA ---
const leadSchema = Joi.object({
    name: Joi.string().min(2).required(),
    email: Joi.string().email().allow('', null),
    mobile: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
    course: Joi.string().allow('', null),
    city: Joi.string().allow('', null),
    medium: Joi.string().default('General_Portal')
});

app.get('/status', (req, res) => {
    res.status(200).json({
        status: "Online",
        timestamp: new Date().toISOString(),
        bridge: "Future On Campus - Collegedunia Integration",
        config_status: process.env.NEODOVE_API_URL ? "Ready" : "Missing Config"
    });
});

// --- THE BRIDGE ROUTE ---
app.post('/api/leads/collegedunia', async (req, res) => {
    // 1. Auth Check
    const incomingKey = req.headers['x-api-key'];
    if (incomingKey !== COLLEGEDUNIA_KEY) {
        console.error(`[AUTH ERROR] Unauthorized attempt from IP: ${req.ip}`);
        return res.status(401).json({ status: "error", message: "Unauthorized." });
    }

    // 2. Data Validation
    const { error, value } = leadSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ status: "error", message: error.details[0].message });
    }

    try {
        // 3. Robust Phone Cleaning (Strips +91, 0, spaces, hyphens)
        let cleanMobile = value.mobile.toString().replace(/\D/g, '');
        if (cleanMobile.length > 10) {
            cleanMobile = cleanMobile.slice(-10); // Take last 10 digits
        }

        if (cleanMobile.length !== 10) {
            throw new Error("Mobile number must be exactly 10 digits.");
        }

        // 4. Final Payload Mapping
        const neoDovePayload = {
            name: value.name,
            mobile: cleanMobile,
            email: value.email || "no-email@foc.com",
            detail1: value.course || "General Inquiry", // Maps to 'Course' in CRM
            detail2: value.city || "Not Specified",     // Maps to 'City' in CRM
            source: "COLLEGEDUNIA",                    // Hardcoded Source Policy
            medium: value.medium                       // Dynamic Medium from partner
        };

        // 5. Execute Push to NeoDove
        const response = await axios.post(NEODOVE_API, neoDovePayload, {
            timeout: 5000 // If NeoDove doesn't respond in 5s, timeout
        });

        console.log(`[SUCCESS] Lead synced for: ${neoDovePayload.name} (${cleanMobile})`);
        
        return res.status(200).json({ 
            status: "success", 
            message: "Lead received and pushed to CRM" 
        });

    } catch (err) {
        console.error(`[SYNC FAILED] ${err.message}`);
        return res.status(500).json({ 
            status: "error", 
            message: err.message || "Internal Server Error" 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Future On Campus Bridge is Live on Port ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/api/leads/collegedunia`);
});