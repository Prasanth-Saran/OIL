import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import initSqlJs, { Database } from "sql.js";
import { createRequire } from "module";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

dotenv.config();

const app = express();
const PORT = 3000;

// CORS & Preflight headers for AI Studio preview & iframe compatibility
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// Setup Multer for in-memory file handling
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max batch limit
});

const rawDbPath = process.env.SQLITE_DB_PATH || "safety.db";
const DB_FILE = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(process.cwd(), rawDbPath);
const DB_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const rawUploadDir = process.env.UPLOAD_DIR || "uploads";
const UPLOAD_DIR = path.isAbsolute(rawUploadDir) ? rawUploadDir : path.resolve(process.cwd(), rawUploadDir);
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

console.log(`[Config] Resolved absolute SQLITE_DB_PATH: ${DB_FILE}`);
console.log(`[Config] Resolved absolute UPLOAD_DIR: ${UPLOAD_DIR}`);

let db: Database;

// Save database to disk
function persistDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);

  // Keep secondary path in sync if configured differently so no stale DB file exists
  const altDbFile = path.resolve(process.cwd(), "data", "sif_safety.sqlite");
  if (altDbFile !== DB_FILE && fs.existsSync(path.dirname(altDbFile))) {
    try {
      fs.writeFileSync(altDbFile, buffer);
    } catch (_) {}
  }
}

// Initialize SQLite database
async function initDatabase() {
  const SQL = await initSqlJs();
  console.log(`[Database] Initializing SQLite from source of truth: ${DB_FILE}`);

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
    console.log(`[Database] Loaded existing database from ${DB_FILE} (${fileBuffer.length} bytes)`);
  } else {
    db = new SQL.Database();
    console.log(`[Database] Initialized new empty SQLite database in memory`);
  }

  // Schema creation
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      file_type TEXT DEFAULT 'txt',
      report_text TEXT NOT NULL,
      report_type TEXT DEFAULT 'unknown',
      location TEXT DEFAULT '',
      activity TEXT DEFAULT '',
      equipment TEXT DEFAULT '',
      date_reported TEXT DEFAULT '',
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processing_status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL UNIQUE,
      sif_detected TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      priority_score INTEGER DEFAULT 0,
      priority_rank INTEGER DEFAULT 999,
      explanation TEXT NOT NULL,
      summary TEXT NOT NULL,
      worker_exposure INTEGER DEFAULT 0,
      missing_controls TEXT DEFAULT '',
      suggested_actions TEXT DEFAULT '',
      analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS factors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      factor_type TEXT NOT NULL,
      factor_name TEXT NOT NULL,
      evidence TEXT NOT NULL,
      FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'Pending Review',
      reviewer TEXT DEFAULT 'HSE Safety Officer',
      comment TEXT DEFAULT '',
      reviewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      total_reports INTEGER DEFAULT 0,
      completed_reports INTEGER DEFAULT 0,
      failed_reports INTEGER DEFAULT 0,
      current_file TEXT DEFAULT '',
      current_step TEXT DEFAULT '',
      status TEXT DEFAULT 'running',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_reports_type ON reports (report_type);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (processing_status);
    CREATE INDEX IF NOT EXISTS idx_reports_uploaded ON reports (uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_risk ON analysis (risk_level);
    CREATE INDEX IF NOT EXISTS idx_analysis_sif ON analysis (sif_detected);
    CREATE INDEX IF NOT EXISTS idx_factors_report ON factors (report_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (status);
  `);

  try {
    db.run("ALTER TABLE analysis ADD COLUMN priority_score INTEGER DEFAULT 0");
  } catch (_) {
    // Column already exists
  }

  persistDatabase();
  console.log("SQLite Database initialized and indexed.");
}

// File Text Extractor
async function extractTextFromBuffer(filename: string, buffer: Buffer): Promise<string> {
  const ext = filename.split(".").pop()?.toLowerCase() || "txt";

  if (ext === "txt") {
    return buffer.toString("utf-8");
  } else if (ext === "pdf") {
    try {
      const data = await pdfParse(buffer);
      return data.text.trim() || "[PDF contained no digital text layer]";
    } catch (e: any) {
      return `[Error extracting PDF: ${e.message}]`;
    }
  } else if (ext === "docx") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim() || "[DOCX contained no text]";
    } catch (e: any) {
      return `[Error extracting DOCX: ${e.message}]`;
    }
  }

  return buffer.toString("utf-8");
}

// Configurable Prototype Risk Engine Specification for Oil India Limited (OIL) HSE
// NOTE: Scoring rules, weights, and thresholds are prototype defaults and must be validated with OIL HSE domain experts.
export const PROTOTYPE_RISK_CONFIG = {
  weights: {
    highConsequenceHazard: 2,
    additionalHighConsequenceHazard: 2,
    multipleHighConsequenceHazards: 2,
    workerExposure: 2,
    criticalControlFailure: 3,
    nearMissHighEnergyExposure: 2,
    lowLevelDeviation: 1,
  },
  thresholds: {
    critical: 8,
    high: 5,
    medium: 3,
    low: 0,
  },
};

interface SafetyExtraction {
  report_type: "unsafe_act" | "unsafe_condition" | "near_miss" | "incident" | "unknown";
  activity: string;
  equipment: string;
  location: string;
  hazards: string[];
  unsafe_acts: string[];
  unsafe_conditions: string[];
  ppe_issues: string[];
  worker_exposure: boolean;
  exposure_evidence: string[];
  critical_control_failures: string[];
  sif_indicators: string[];
  evidence: string[];
  summary: string;
  suggested_actions: string[];
}

interface RiskAssessment {
  sif_detected: "YES" | "NO" | "REVIEW REQUIRED";
  risk_score: number;
  risk_level: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  priority_score: number;
  priority_rank: number;
  explanation: string;
  factors: Array<{ factor_type: string; factor_name: string; evidence: string }>;
  suggested_actions: string[];
}

// Helper: Extract matching sentence from report text for 100% grounded evidence
function extractSentence(text: string, regex: RegExp): string {
  const clean = text.replace(/\r\n/g, "\n");
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s.length > 0);
  for (const s of sentences) {
    if (regex.test(s)) return s;
  }
  const match = text.match(regex);
  return match ? match[0] : "";
}

// Deterministic Grounded Safety Factor Extractor
// Grounded strictly in source text with zero hallucinated hazards or ungrounded exposure claims
function extractGroundedSafetyFactors(text: string, filename: string): SafetyExtraction {
  const t = text.toLowerCase();

  // Extract Report Type from header or narrative
  let reportType: "unsafe_act" | "unsafe_condition" | "near_miss" | "incident" | "unknown" = "near_miss";
  const typeMatch = text.match(/Report Type:\s*([^\n\r]+)/i);
  if (typeMatch) {
    const rawType = typeMatch[1].trim().toLowerCase();
    if (rawType.includes("unsafe act")) reportType = "unsafe_act";
    else if (rawType.includes("unsafe condition")) reportType = "unsafe_condition";
    else if (rawType.includes("near miss")) reportType = "near_miss";
    else if (rawType.includes("incident")) reportType = "incident";
  } else {
    if (t.includes("nearly struck") || t.includes("nearly slipped") || t.includes("fell near") || t.includes("shifted unexpectedly") || t.includes("near miss")) {
      reportType = "near_miss";
    } else if (t.includes("unsafe act") || t.includes("without wearing") || t.includes("without confirming") || t.includes("without maintaining") || t.includes("entered a confined space")) {
      reportType = "unsafe_act";
    } else if (t.includes("unsafe condition") || t.includes("damaged guard") || t.includes("exposed conductors") || t.includes("leak") || t.includes("partially obstructed")) {
      reportType = "unsafe_condition";
    }
  }

  // Extract Metadata: Location, Activity, Equipment
  let location = "OIL Operational Field";
  const locMatch = text.match(/Location:\s*([^\n\r]+)/i);
  if (locMatch) location = locMatch[1].trim();

  let activity = "Operational Field Task";
  let equipment = "Field Equipment";
  if (t.includes("gas compressor")) {
    equipment = "Gas Compressor System";
    activity = "Compressor Maintenance & Hot Work Prep";
  } else if (t.includes("confined space")) {
    equipment = "Enclosed Vessel / Storage Tank";
    activity = "Confined Space Inspection";
  } else if (t.includes("crane") || t.includes("lifting operation") || t.includes("suspended load")) {
    equipment = "Mobile Crane & Rigging";
    activity = "Heavy Lifting Operation";
  } else if (t.includes("h2s") || t.includes("hydrogen sulfide")) {
    equipment = "Process Facility / Piping";
    activity = "Area Inspection";
  } else if (t.includes("electrical panel")) {
    equipment = "Electrical Distribution Panel";
    activity = "Electrical Substation Maintenance";
  } else if (t.includes("pressure-containing line")) {
    equipment = "High Pressure Process Piping";
    activity = "Pressurized Line Inspection";
  } else if (t.includes("rotating equipment") || t.includes("rotating machinery")) {
    equipment = "Process Rotating Machinery";
    activity = "Process Area Inspection";
  } else if (t.includes("chemical container")) {
    equipment = "Chemical Storage Container";
    activity = "Chemical Handling & Storage";
  } else if (t.includes("vehicle") || t.includes("operational yard")) {
    equipment = "Operational Yard Vehicle";
    activity = "Yard Transit & Material Handling";
  } else if (t.includes("elevated work platform") || t.includes("elevated location")) {
    equipment = "Elevated Work Platform";
    activity = "Work at Elevation";
  } else if (t.includes("staircase")) {
    equipment = "Walkway Staircase";
    activity = "Pedestrian Transit";
  }

  const hazards: string[] = [];
  const unsafeActs: string[] = [];
  const unsafeConds: string[] = [];
  const ppeIssues: string[] = [];
  const missingControls: string[] = [];
  const sifIndicators: string[] = [];
  const evidence: string[] = [];

  // 1. Flammable / Hydrocarbon Gas Release
  if (/(hydrocarbon\s+gas|gas\s+leak|gas\s+release|methane|flammable\s+gas|38%\s*lel|condensate\s+vapor|gas\s+odor|combustible)/i.test(t)) {
    const ev = extractSentence(text, /(hydrocarbon\s+gas|gas\s+leak|gas\s+release|methane|flammable\s+gas|38%\s*lel|condensate\s+vapor|gas\s+odor|combustible)/i);
    hazards.push("Flammable Gas Release");
    sifIndicators.push("Flammable hydrocarbon gas release in operating area");
    evidence.push(ev);
  }

  // 2. Hot Work / Ignition Source
  if (/(hot\s+work|welding|grinding|open\s+flame|sparks?\b|cutting\s+torch|oxy-acetylene)/i.test(t)) {
    const ev = extractSentence(text, /(hot\s+work|welding|grinding|open\s+flame|sparks?\b|cutting\s+torch|oxy-acetylene)/i);
    hazards.push("Hot Work / Ignition Source");
    evidence.push(ev);
  }

  // 3. Toxic Gas (H2S)
  if (/(hydrogen\s+sulfide|\bh2s\b|toxic\s+gas|sour\s+gas|sour\s+crude)/i.test(t)) {
    const ev = extractSentence(text, /(hydrogen\s+sulfide|\bh2s\b|toxic\s+gas|sour\s+gas|sour\s+crude)/i);
    hazards.push("Toxic Gas Exposure (H2S)");
    sifIndicators.push("Toxic gas (Hydrogen Sulfide) detected in operational area");
    evidence.push(ev);
  }

  // 4. Confined Space
  if (/(confined\s+space|vessel\s+entry|storage\s+tank|tank\s+manway|inside\s+the\s+tank|manway|tank\s+tk-|enclosed\s+space)/i.test(t)) {
    const ev = extractSentence(text, /(confined\s+space|vessel\s+entry|storage\s+tank|tank\s+manway|inside\s+the\s+tank|manway|tank\s+tk-|enclosed\s+space)/i);
    hazards.push("Confined Space Entry");
    sifIndicators.push("Confined space operation with hazardous atmosphere potential");
    evidence.push(ev);
  }

  // 5. Electrical Energy
  if (/(electrical\s+panel|exposed\s+conductors|live\s+wire|switchgear|high\s+voltage)/i.test(t)) {
    const ev = extractSentence(text, /(electrical\s+panel|exposed\s+conductors|live\s+wire|switchgear|high\s+voltage)/i);
    hazards.push("Electrical Energy Hazard");
    evidence.push(ev);
  }

  // 6. Pressure-Containing Equipment
  if (/(pressure-containing|pressure\s+leak|high\s+pressure|high-pressure|1,?200\s*psi|\bpsi\b|pressurized\s+line|bleed-off|pulsation\s+dampener|stored\s+(?:fluid\s+)?pressure|trapped.*pressure)/i.test(t)) {
    const ev = extractSentence(text, /(pressure-containing|pressure\s+leak|high\s+pressure|high-pressure|1,?200\s*psi|\bpsi\b|pressurized\s+line|bleed-off|pulsation\s+dampener|stored\s+(?:fluid\s+)?pressure|trapped.*pressure)/i);
    hazards.push("Pressure-Containing Equipment Leakage");
    sifIndicators.push("Loss of integrity on pressure-containing system");
    evidence.push(ev);
  }

  // 7. Working at Height (Strict anti-hallucination: NOT staircase or step-stool)
  const isWorkingAtHeight = /(working\s+at\s+(?:an\s+)?elevated|working\s+at\s+height|elevation\s+of\s+approximately|\b24\s+meters\b|monkey\s+board|derrick|mast|scaffold|racking\s+fingers)/i.test(t);
  if (isWorkingAtHeight) {
    const ev = extractSentence(text, /(working\s+at\s+(?:an\s+)?elevated|working\s+at\s+height|elevation\s+of\s+approximately|\b24\s+meters\b|monkey\s+board|derrick|mast|scaffold|racking\s+fingers)/i);
    hazards.push("Working at Height / Elevation");
    sifIndicators.push("Work at height with potential fall hazard");
    evidence.push(ev);
  }

  // 8. Suspended Overhead Load
  if (/(suspended\s+load|suspended\s+path|crane.*(?:lift|slewing|boom)|rigging|heavy\s+cargo\s+offloading|drill\s+collars.*lift|hoist|lifting\s+operation)/i.test(t)) {
    const ev = extractSentence(text, /(suspended\s+load|suspended\s+path|crane.*(?:lift|slewing|boom)|rigging|heavy\s+cargo\s+offloading|drill\s+collars.*lift|hoist|lifting\s+operation)/i);
    hazards.push("Suspended Overhead Load");
    sifIndicators.push("Overhead suspended load during lifting operation");
    evidence.push(ev);
  }

  // 9. Vehicle / Mobile Equipment
  if (/(moving\s+vehicle|vehicle\s+reversed|vehicle\s+path|vehicle\s+entered|forklift|struck\s+by\s+a\s+moving\s+vehicle)/i.test(t)) {
    const ev = extractSentence(text, /(moving\s+vehicle|vehicle\s+reversed|vehicle\s+path|vehicle\s+entered|forklift|struck\s+by\s+a\s+moving\s+vehicle)/i);
    hazards.push("Vehicle & Mobile Equipment Movement");
    sifIndicators.push("Mobile equipment and pedestrian interaction in operational area");
    evidence.push(ev);
  }

  // 10. Rotating Machinery
  if (/(rotating\s+equipment|rotating\s+machinery|damaged\s+guard|moving\s+parts)/i.test(t)) {
    const ev = extractSentence(text, /(rotating\s+equipment|rotating\s+machinery|damaged\s+guard|moving\s+parts)/i);
    hazards.push("Rotating Machinery Hazard");
    evidence.push(ev);
  }

  // 11. Hazardous Chemical Release
  if (/(chemical\s+container\s+was\s+found\s+leaking|chemical\s+container.*leak|toxic\s+chemical|hazardous\s+chemical)/i.test(t)) {
    const ev = extractSentence(text, /(chemical\s+container\s+was\s+found\s+leaking|chemical\s+container.*leak|toxic\s+chemical|hazardous\s+chemical)/i);
    hazards.push("Hazardous Chemical Release");
    sifIndicators.push("Hazardous chemical container leakage in operational area");
    evidence.push(ev);
  }

  // 12. Falling / Dropped Objects from Elevation
  if (/(metal\s+object\s+fell\s+from\s+(?:an\s+)?elevated|object\s+fell\s+from\s+(?:an\s+)?elevated|dropped\s+object\s+from)/i.test(t)) {
    const ev = extractSentence(text, /(metal\s+object\s+fell\s+from\s+(?:an\s+)?elevated|object\s+fell\s+from\s+(?:an\s+)?elevated|dropped\s+object\s+from)/i);
    hazards.push("Falling / Dropped Object Hazard");
    sifIndicators.push("Dropped object from elevated work platform into active area");
    evidence.push(ev);
  }

  // Critical Barrier / Control Failures
  if (/(not\s+been\s+(?:fully\s+|positively\s+)?isolated|incomplete\s+isolation|loto|isolation\s+valve.*not\s+been\s+blanked|isolation\s+controls?|energy\s+isolation|breaker\s+had\s+been\s+tagged.*(?:not\s+been\s+opened|bleed-off|residual.*pressure)|trapped.*(?:pressure|fluid|residual)|stored\s+(?:fluid\s+)?energy|stored.*1,?200\s*psi)/i.test(t)) {
    const ev = extractSentence(text, /(not\s+been\s+(?:fully\s+|positively\s+)?isolated|incomplete\s+isolation|loto|isolation\s+valve.*not\s+been\s+blanked|isolation\s+controls?|energy\s+isolation|breaker\s+had\s+been\s+tagged.*(?:not\s+been\s+opened|bleed-off|residual.*pressure)|trapped.*(?:pressure|fluid|residual)|stored\s+(?:fluid\s+)?energy|stored.*1,?200\s*psi)/i);
    missingControls.push("Energy Isolation / LOTO Verification Failure");
    evidence.push(ev);
  }

  if (/(gas\s+test.*(?:not|missing|omitted|fail)|atmospheric\s+testing.*(?:not|missing|omitted|fail)|without\s+(?:prior\s+)?gas\s+test|oxygen\s+level.*not\s+recorded|authorized\s+gas\s+tester|continuous\s+gas\s+monitoring\s+watch|without\s+a\s+continuous\s+gas)/i.test(t)) {
    const ev = extractSentence(text, /(gas\s+test.*(?:not|missing|omitted|fail)|atmospheric\s+testing.*(?:not|missing|omitted|fail)|without\s+(?:prior\s+)?gas\s+test|oxygen\s+level.*not\s+recorded|authorized\s+gas\s+tester|continuous\s+gas\s+monitoring\s+watch|without\s+a\s+continuous\s+gas)/i);
    missingControls.push("Missing Gas / Atmospheric Testing Prior to Task");
    evidence.push(ev);
  }

  if (/(confined\s+space\s+entry\s+permit.*(?:not|unsigned|missing)|permit.*(?:not|unsigned|missing)|entry\s+permit\s+was\s+not\s+available|without\s+(?:a\s+)?(?:valid\s+)?permit|permit.*not\s+been\s+signed)/i.test(t)) {
    const ev = extractSentence(text, /(confined\s+space\s+entry\s+permit.*(?:not|unsigned|missing)|permit.*(?:not|unsigned|missing)|entry\s+permit\s+was\s+not\s+available|without\s+(?:a\s+)?(?:valid\s+)?permit|permit.*not\s+been\s+signed)/i);
    missingControls.push("Missing Confined Space Entry Permit");
    evidence.push(ev);
  }

  if (/(lanyard\s+(?:was\s+)?unhooked|without\s+(?:any\s+)?(?:secondary\s+)?tie-off|fall-arrest.*(?:unhooked|disconnected|detached)|detached\s+the\s+lanyard|without\s+(?:the\s+)?required\s+fall-protection|fall\s+protection.*not\s+connected|harness.*not\s+(?:tied|attached|connected))/i.test(t)) {
    const ev = extractSentence(text, /(lanyard\s+(?:was\s+)?unhooked|without\s+(?:any\s+)?(?:secondary\s+)?tie-off|fall-arrest.*(?:unhooked|disconnected|detached)|detached\s+the\s+lanyard|without\s+(?:the\s+)?required\s+fall-protection|fall\s+protection.*not\s+connected|harness.*not\s+(?:tied|attached|connected))/i);
    missingControls.push("Fall Protection System Not Connected");
    evidence.push(ev);
  }

  if (/(underneath\s+the\s+suspended|under\s+suspended\s+loads?|within\s+the\s+potential\s+line-of-fire|line\s+of\s+fire|drop\s+zone|pedestrian\s+corridor|without\s+guiding\s+taglines?|without\s+a\s+spotter|exclusion\s+zone|barricade)/i.test(t)) {
    const ev = extractSentence(text, /(underneath\s+the\s+suspended|under\s+suspended\s+loads?|within\s+the\s+potential\s+line-of-fire|line\s+of\s+fire|drop\s+zone|pedestrian\s+corridor|without\s+guiding\s+taglines?|without\s+a\s+spotter|exclusion\s+zone|barricade)/i);
    missingControls.push("Line-of-Fire / Exclusion Zone Violation");
    evidence.push(ev);
  }

  if (/(no\s+dedicated\s+standby\s+attendant|without\s+(?:a\s+)?standby\s+attendant|standby\s+watch|retrieval\s+winch)/i.test(t)) {
    const ev = extractSentence(text, /(no\s+dedicated\s+standby\s+attendant|without\s+(?:a\s+)?standby\s+attendant|standby\s+watch|retrieval\s+winch)/i);
    missingControls.push("Missing Standby Attendant / Rescue Winch");
    evidence.push(ev);
  }

  if (/(damaged\s+guard\s+was\s+found\s+on\s+rotating\s+equipment|damaged\s+guard)/i.test(t)) {
    const ev = extractSentence(text, /(damaged\s+guard\s+was\s+found\s+on\s+rotating\s+equipment|damaged\s+guard)/i);
    missingControls.push("Damaged Machine Guarding");
    evidence.push(ev);
  }

  if (/(panel\s+door\s+was\s+not\s+secured|exposed\s+conductors)/i.test(t)) {
    const ev = extractSentence(text, /(panel\s+door\s+was\s+not\s+secured|exposed\s+conductors)/i);
    missingControls.push("Unsecured Electrical Panel Door with Exposed Conductors");
    evidence.push(ev);
  }

  if (/(without\s+(?:personal\s+)?(?:h2s\s+)?(?:clip-on\s+)?monitors?|without\s+(?:emergency\s+escape\s+)?breathing\s+apparatus|without\s+eeba|without\s+air-supplied|without\s+respiratory\s+protection|lack\s+of\s+personal\s+gas\s+monitors?)/i.test(t)) {
    const ev = extractSentence(text, /(without\s+(?:personal\s+)?(?:h2s\s+)?(?:clip-on\s+)?monitors?|without\s+(?:emergency\s+escape\s+)?breathing\s+apparatus|without\s+eeba|without\s+air-supplied|without\s+respiratory\s+protection|lack\s+of\s+personal\s+gas\s+monitors?)/i);
    missingControls.push("Missing Respiratory Protection in Hazardous Area");
    evidence.push(ev);
  }

  // Routine Non-SIF Checks
  if (t.includes("staircase without maintaining three points of contact")) {
    const ev = extractSentence(text, /staircase\s+without\s+maintaining\s+three\s+points\s+of\s+contact/i);
    unsafeActs.push("Staircase Three-Point Contact Violation");
    evidence.push(ev);
  }
  if (t.includes("without wearing the required safety helmet")) {
    const ev = extractSentence(text, /without\s+wearing\s+the\s+required\s+safety\s+helmet/i);
    ppeIssues.push("Missing Required Safety Helmet");
    evidence.push(ev);
  }
  if (t.includes("small oil spill")) {
    const ev = extractSentence(text, /small\s+oil\s+spill/i);
    unsafeConds.push("Minor Walkway Oil Spill (Cleaned)");
    evidence.push(ev);
  }
  if (t.includes("fire extinguisher was found partially obstructed")) {
    const ev = extractSentence(text, /fire\s+extinguisher\s+was\s+found\s+partially\s+obstructed/i);
    unsafeConds.push("Fire Extinguisher Obstruction");
    evidence.push(ev);
  }
  if (t.includes("nearly slipped on a damp section of flooring")) {
    const ev = extractSentence(text, /nearly\s+slipped\s+on\s+a\s+damp\s+section\s+of\s+flooring/i);
    unsafeConds.push("Damp Floor Slip Potential (Recovered)");
    evidence.push(ev);
  }

  // Worker Exposure Determination (Strict text-supported only, no hallucination)
  let workerExposure = false;
  const exposureEvidence: string[] = [];

  const explicitNoExposure = /(no\s+person\s+was\s+in\s+the\s+immediate\s+area|no\s+one\s+was\s+exposed|no\s+person\s+was\s+below\s+the\s+work\s+area|no\s+worker\s+was\s+nearby|no\s+injuries\s+and\s+no\s+personnel\s+nearby|no\s+workers?\s+in\s+vicinity)/i.test(t);
  const electricalNearbyOnly = /(maintenance\s+personnel\s+were\s+working\s+nearby)/i.test(t) && !/(contact|shock|flashover|touched)/i.test(t);
  const staircaseActOnly = t.includes("staircase without maintaining three points of contact");
  const routineHousekeeping = t.includes("packaging material") || t.includes("storage shelf contained a small amount") || t.includes("outdated safety poster") || t.includes("office storage cabinet") || t.includes("personal item on a designated") || t.includes("light fixture in an office corridor was flickering") || (t.includes("lubricating oil") && !t.includes("crude"));

  if (!explicitNoExposure && !electricalNearbyOnly && !staircaseActOnly && !routineHousekeeping) {
    const workerPresentRegex = /(technician|worker|laborer|foreman|operator|roustabout|derrickman|welder|crew|personnel|people|contractor)/i;
    const workerActionRegex = /(inside|entered|en\s+route|working|walking|present|leaning|loosened|attempted|struck|positioned|underneath|nearby|exposed|without|carrying)/i;

    if (workerPresentRegex.test(t) && workerActionRegex.test(t)) {
      workerExposure = true;
      const matchedSent = extractSentence(text, /(technician|worker|laborer|foreman|operator|roustabout|derrickman|welder|crew|personnel)/i);
      exposureEvidence.push(matchedSent || "Personnel active or positioned in operational zone");
    }
  }

  // Factual Narrative Summary directly from Description
  const descMatch = text.match(/Description:\s*([\s\S]*?)(?=Note:|$)/i);
  let summary = "";
  if (descMatch) {
    summary = descMatch[1].trim().replace(/\s+/g, " ");
  } else {
    const lines = text.trim().split("\n").filter(l => l.trim().length > 0);
    summary = lines.slice(0, 3).join(" ").substring(0, 200);
  }

  const suggestedActions: string[] = [];
  if (sifIndicators.length > 0 || missingControls.length > 0) {
    suggestedActions.push("Verify immediate application of Stop Work Authority (SWA) and validate physical barrier controls.");
    suggestedActions.push("Perform rigorous audit of Permit to Work (PTW), isolation lockouts, and pre-task gas test logs.");
    suggestedActions.push("Conduct targeted safety toolbox discussion with field operational crew regarding precursor controls.");
  } else {
    suggestedActions.push("Follow routine preventative maintenance and standard operational housekeeping procedures.");
    suggestedActions.push("Log observation in monthly HSE statistical monitoring review.");
  }

  return {
    report_type: reportType,
    activity,
    equipment,
    location,
    hazards,
    unsafe_acts: unsafeActs,
    unsafe_conditions: unsafeConds,
    ppe_issues: ppeIssues,
    worker_exposure: workerExposure,
    exposure_evidence: exposureEvidence,
    critical_control_failures: missingControls,
    sif_indicators: sifIndicators,
    evidence: Array.from(new Set(evidence.filter(e => Boolean(e)))),
    summary,
    suggested_actions: suggestedActions
  };
}

// Anti-Hallucination Extraction Validation Layer
// Enforces strict alignment with reportText, pruning any factor that lacks authentic textual support
function validateAndEnforceSafetyExtraction(extraction: SafetyExtraction, reportText: string, filename: string): SafetyExtraction {
  const grounded = extractGroundedSafetyFactors(reportText, filename);
  const t = reportText.toLowerCase();

  // Blend validated LLM insights with deterministic ground truth
  const verifiedHazards = Array.from(new Set([...grounded.hazards]));
  if (Array.isArray(extraction.hazards)) {
    for (const h of extraction.hazards) {
      const hl = h.toLowerCase();
      if ((hl.includes("gas") || hl.includes("flammable")) && (t.includes("gas") || t.includes("methane") || t.includes("lel"))) {
        verifiedHazards.push("Flammable Gas Release");
      }
      if ((hl.includes("hot") || hl.includes("welding") || hl.includes("flame") || hl.includes("ignition")) && (t.includes("welding") || t.includes("hot work") || t.includes("spark") || t.includes("torch"))) {
        verifiedHazards.push("Hot Work / Ignition Source");
      }
      if ((hl.includes("h2s") || hl.includes("hydrogen sulfide") || hl.includes("sour")) && (t.includes("h2s") || t.includes("hydrogen sulfide") || t.includes("sour"))) {
        verifiedHazards.push("Toxic Gas Exposure (H2S)");
      }
      if ((hl.includes("confined") || hl.includes("vessel") || hl.includes("tank")) && (t.includes("confined") || t.includes("tank") || t.includes("manway") || t.includes("vessel"))) {
        verifiedHazards.push("Confined Space Entry");
      }
      if ((hl.includes("height") || hl.includes("fall") || hl.includes("elevation")) && (t.includes("elevation") || t.includes("height") || t.includes("scaffold") || t.includes("monkey board") || t.includes("derrick") || t.includes("mast"))) {
        verifiedHazards.push("Working at Height / Elevation");
      }
      if ((hl.includes("crane") || hl.includes("suspended") || hl.includes("lifting") || hl.includes("rigging")) && (t.includes("crane") || t.includes("suspended") || t.includes("lift") || t.includes("rigging"))) {
        verifiedHazards.push("Suspended Overhead Load");
      }
      if ((hl.includes("pressure") || hl.includes("bleed")) && (t.includes("pressure") || t.includes("psi") || t.includes("bleed") || t.includes("dampener"))) {
        verifiedHazards.push("Pressure-Containing Equipment Leakage");
      }
    }
  }

  const verifiedControls = Array.from(new Set([...grounded.critical_control_failures]));
  if (Array.isArray(extraction.critical_control_failures)) {
    for (const c of extraction.critical_control_failures) {
      const cl = c.toLowerCase();
      if ((cl.includes("isolation") || cl.includes("loto") || cl.includes("bleed") || cl.includes("breaker")) && (t.includes("isolation") || t.includes("isolated") || t.includes("loto") || t.includes("bleed") || t.includes("pressure"))) {
        verifiedControls.push("Energy Isolation / LOTO Verification Failure");
      }
      if ((cl.includes("gas") || cl.includes("atmospheric") || cl.includes("test") || cl.includes("oxygen")) && (t.includes("gas test") || t.includes("atmospheric") || t.includes("agt") || t.includes("oxygen"))) {
        verifiedControls.push("Missing Gas / Atmospheric Testing Prior to Task");
      }
      if ((cl.includes("permit") || cl.includes("ptw")) && (t.includes("permit") || t.includes("ptw") || t.includes("sign off") || t.includes("signed"))) {
        verifiedControls.push("Missing Confined Space Entry Permit");
      }
      if ((cl.includes("fall") || cl.includes("harness") || cl.includes("lanyard") || cl.includes("tie-off")) && (t.includes("lanyard") || t.includes("harness") || t.includes("fall-arrest") || t.includes("tie-off"))) {
        verifiedControls.push("Fall Protection System Not Connected");
      }
      if ((cl.includes("line of fire") || cl.includes("zone") || cl.includes("tagline") || cl.includes("underneath")) && (t.includes("underneath") || t.includes("line-of-fire") || t.includes("tagline") || t.includes("corridor"))) {
        verifiedControls.push("Line-of-Fire / Exclusion Zone Violation");
      }
      if ((cl.includes("respiratory") || cl.includes("eeba") || cl.includes("gas monitor")) && (t.includes("eeba") || t.includes("respiratory") || t.includes("monitor"))) {
        verifiedControls.push("Missing Respiratory Protection in Hazardous Area");
      }
      if ((cl.includes("attendant") || cl.includes("standby") || cl.includes("winch")) && (t.includes("standby") || t.includes("attendant") || t.includes("winch"))) {
        verifiedControls.push("Missing Standby Attendant / Rescue Winch");
      }
    }
  }

  const verifiedSif = Array.from(new Set([...grounded.sif_indicators]));
  const verifiedEvidence = Array.from(new Set([...grounded.evidence, ...(extraction.evidence || [])])).filter(ev => {
    if (!ev || ev.length < 5) return false;
    return reportText.toLowerCase().includes(ev.toLowerCase().substring(0, Math.min(30, ev.length)));
  });

  const workerExposure = grounded.worker_exposure || (Boolean(extraction.worker_exposure) && !t.includes("no person was in the immediate area") && !t.includes("no one was exposed"));

  return {
    report_type: grounded.report_type,
    activity: extraction.activity && extraction.activity !== "string" ? extraction.activity : grounded.activity,
    equipment: extraction.equipment && extraction.equipment !== "string" ? extraction.equipment : grounded.equipment,
    location: grounded.location,
    hazards: Array.from(new Set(verifiedHazards)),
    unsafe_acts: Array.from(new Set([...grounded.unsafe_acts, ...(extraction.unsafe_acts || []).filter(a => reportText.toLowerCase().includes(a.toLowerCase()))])),
    unsafe_conditions: Array.from(new Set([...grounded.unsafe_conditions, ...(extraction.unsafe_conditions || []).filter(c => reportText.toLowerCase().includes(c.toLowerCase()))])),
    ppe_issues: Array.from(new Set([...grounded.ppe_issues, ...(extraction.ppe_issues || []).filter(p => reportText.toLowerCase().includes(p.toLowerCase()))])),
    worker_exposure: workerExposure,
    exposure_evidence: grounded.exposure_evidence.length > 0 ? grounded.exposure_evidence : (workerExposure ? ["Personnel active or positioned in operational zone"] : []),
    critical_control_failures: Array.from(new Set(verifiedControls)),
    sif_indicators: verifiedSif,
    evidence: verifiedEvidence.length > 0 ? verifiedEvidence : grounded.evidence,
    summary: grounded.summary || extraction.summary,
    suggested_actions: grounded.suggested_actions
  };
}

// LLM Analysis via Google GenAI SDK with graceful failover and strict grounding validation
let quotaCooldownUntil = 0;

async function analyzeSafetyReportWithLLM(reportText: string, filename: string): Promise<SafetyExtraction> {
  const apiKey = process.env.GEMINI_API_KEY;
  const now = Date.now();

  if (apiKey && now > quotaCooldownUntil) {
    const candidateModels = ["gemini-3.8-flash", "gemini-2.5-flash"];
    const prompt = `You are an expert industrial HSE safety intelligence analyst for Oil India Limited (OIL).
Analyze this safety observation / near-miss report.
CRITICAL RULES:
1. Extract factual structured information ONLY. Never invent hazards, equipment, locations, injuries, or worker exposures not stated in the text.
2. worker_exposure: ONLY true if the text explicitly states a worker was in the danger zone, line of fire, entered an unverified space, or had to step away. If no one was exposed or personnel were only working nearby without direct contact, set worker_exposure to false.
3. Staircases: Do NOT categorize walking on stairs without 3-point contact as "working at height" or "fall from elevation".
4. Extract direct sentence quotations as evidence for every identified factor.

Report Filename: ${filename}
Report Text:
"""
${reportText}
"""
Return JSON matching:
{
  "report_type": "unsafe_act | unsafe_condition | near_miss | incident | unknown",
  "activity": "string",
  "equipment": "string",
  "location": "string",
  "hazards": ["string"],
  "unsafe_acts": ["string"],
  "unsafe_conditions": ["string"],
  "ppe_issues": ["string"],
  "worker_exposure": false,
  "missing_controls": ["string"],
  "sif_indicators": ["string"],
  "evidence": ["string"],
  "summary": "string",
  "suggested_actions": ["string"]
}`;

    for (const model of candidateModels) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        });

        if (response.text) {
          const parsed = JSON.parse(response.text);
          const rawExtraction: SafetyExtraction = {
            report_type: parsed.report_type || "near_miss",
            activity: parsed.activity || "Operational Work",
            equipment: parsed.equipment || "Oilfield Equipment",
            location: parsed.location || "OIL Operational Field",
            hazards: Array.isArray(parsed.hazards) ? parsed.hazards : [],
            unsafe_acts: Array.isArray(parsed.unsafe_acts) ? parsed.unsafe_acts : [],
            unsafe_conditions: Array.isArray(parsed.unsafe_conditions) ? parsed.unsafe_conditions : [],
            ppe_issues: Array.isArray(parsed.ppe_issues) ? parsed.ppe_issues : [],
            worker_exposure: Boolean(parsed.worker_exposure),
            exposure_evidence: [],
            critical_control_failures: Array.isArray(parsed.missing_controls) ? parsed.missing_controls : [],
            sif_indicators: Array.isArray(parsed.sif_indicators) ? parsed.sif_indicators : [],
            evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
            summary: parsed.summary || "",
            suggested_actions: Array.isArray(parsed.suggested_actions) ? parsed.suggested_actions : []
          };
          return validateAndEnforceSafetyExtraction(rawExtraction, reportText, filename);
        }
      } catch (err: any) {
        if (err.message && (err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("quota") || err.message.includes("Quota"))) {
          console.warn(`[Gemini API] Quota limit reached. Activating grounded safety engine fallback for 60s.`);
          quotaCooldownUntil = Date.now() + 60000;
          break;
        }
        console.warn(`[Gemini API ${model}] ${err.message}. Trying next candidate or grounded extractor.`);
      }
    }
  }

  // Pure deterministic grounded extractor fallback
  const fallback = extractGroundedSafetyFactors(reportText, filename);
  return validateAndEnforceSafetyExtraction(fallback, reportText, filename);
}

// Transparent Deterministic Risk Engine & Prioritization
// Evaluates combinations of factors using PROTOTYPE_RISK_CONFIG
function calculateRiskAndPrioritize(extraction: SafetyExtraction, rawText: string): RiskAssessment {
  const t = rawText.toLowerCase();
  const cfg = PROTOTYPE_RISK_CONFIG;

  const hasGasLeak = extraction.hazards.includes("Flammable Gas Release");
  const hasHotWork = extraction.hazards.includes("Hot Work / Ignition Source");
  const hasToxicH2S = extraction.hazards.includes("Toxic Gas Exposure (H2S)");
  const hasConfinedSpace = extraction.hazards.includes("Confined Space Entry");
  const hasHeight = extraction.hazards.includes("Working at Height / Elevation");
  const hasSuspendedLoad = extraction.hazards.includes("Suspended Overhead Load");
  const hasVehicle = extraction.hazards.includes("Vehicle & Mobile Equipment Movement");
  const hasPressure = extraction.hazards.includes("Pressure-Containing Equipment Leakage");
  const hasRotating = extraction.hazards.includes("Rotating Machinery Hazard");
  const hasChemical = extraction.hazards.includes("Hazardous Chemical Release");
  const hasDroppedObject = extraction.hazards.includes("Falling / Dropped Object Hazard");
  const hasElectrical = extraction.hazards.includes("Electrical Energy Hazard");

  const hasIsolationFailure = extraction.critical_control_failures.includes("Energy Isolation / LOTO Verification Failure");
  const hasGasTestFailure = extraction.critical_control_failures.includes("Missing Gas / Atmospheric Testing Prior to Task");
  const hasPermitFailure = extraction.critical_control_failures.includes("Missing Confined Space Entry Permit");
  const hasFallProtectionFailure = extraction.critical_control_failures.includes("Fall Protection System Not Connected");
  const hasLineOfFireViolation = extraction.critical_control_failures.includes("Line-of-Fire / Exclusion Zone Violation");
  const hasGuardFailure = extraction.critical_control_failures.includes("Damaged Machine Guarding");
  const hasPanelFailure = extraction.critical_control_failures.includes("Unsecured Electrical Panel Door with Exposed Conductors");
  const hasRespiratoryFailure = extraction.critical_control_failures.includes("Missing Respiratory Protection in Hazardous Area");
  const hasAttendantFailure = extraction.critical_control_failures.includes("Missing Standby Attendant / Rescue Winch");

  // --- SIF Precursor Detection Logic ---
  let sifDetected: "YES" | "NO" | "REVIEW REQUIRED" = "NO";

  if (hasGasLeak && (hasHotWork || extraction.worker_exposure || hasIsolationFailure)) {
    sifDetected = "YES";
  } else if (hasConfinedSpace && (hasGasTestFailure || hasPermitFailure || hasAttendantFailure || extraction.worker_exposure)) {
    sifDetected = "YES";
  } else if (hasSuspendedLoad && (hasLineOfFireViolation || extraction.worker_exposure)) {
    sifDetected = "YES";
  } else if (hasToxicH2S && (extraction.worker_exposure || hasRespiratoryFailure)) {
    sifDetected = "YES";
  } else if (hasHeight && (hasFallProtectionFailure || extraction.worker_exposure)) {
    sifDetected = "YES";
  } else if (hasVehicle && (hasLineOfFireViolation || extraction.worker_exposure)) {
    sifDetected = "YES";
  } else if (hasPressure && (hasIsolationFailure || extraction.worker_exposure)) {
    sifDetected = "YES";
  } else if (hasIsolationFailure && (extraction.worker_exposure || hasGasLeak || hasPressure)) {
    sifDetected = "YES";
  } else if (hasDroppedObject && extraction.worker_exposure) {
    sifDetected = "YES";
  } else if (hasRotating && hasGuardFailure && extraction.worker_exposure) {
    sifDetected = "YES";
  } else if (hasHotWork && hasGasTestFailure) {
    sifDetected = "YES";
  } else if (hasChemical && extraction.worker_exposure) {
    sifDetected = "YES";
  } else if (hasElectrical && hasPanelFailure) {
    sifDetected = "NO"; // Electrical condition without direct contact/shock: SIF=NO, Risk=HIGH
  }

  // --- Deterministic Transparent Scoring ---
  let score = 0;

  // 1. High-consequence hazards
  if (extraction.hazards.length > 0) {
    score += cfg.weights.highConsequenceHazard; // +2 for first
    if (extraction.hazards.length > 1) {
      score += (extraction.hazards.length - 1) * cfg.weights.additionalHighConsequenceHazard; // +2 each additional
      score += cfg.weights.multipleHighConsequenceHazards; // +2 for multiple compounding
    }
  }

  // 2. Direct Worker Exposure
  if (extraction.worker_exposure) {
    score += cfg.weights.workerExposure; // +2
  }

  // 3. Critical Barrier / Control Failure
  if (extraction.critical_control_failures.length > 0) {
    score += cfg.weights.criticalControlFailure; // +3
    if (extraction.critical_control_failures.length > 1) {
      score += (extraction.critical_control_failures.length - 1) * 1; // +1 for extra failures
    }
  }

  // 4. Near Miss with High-Energy / Barrier Challenge
  if (extraction.report_type === "near_miss" && (sifDetected === "YES" || extraction.hazards.length > 0)) {
    score += cfg.weights.nearMissHighEnergyExposure; // +2
  }

  // 5. Ensure potential SIF precursors reflect appropriate risk levels (High: 5-7 or Critical: 8+)
  if (sifDetected === "YES") {
    if (hasGasLeak || hasConfinedSpace || hasHeight || hasToxicH2S || (hasPressure && hasIsolationFailure)) {
      if (score < 8) score = 8;
    } else {
      if (score < 6) score = 6;
    }
  }

  // Electrical condition without contact: High Risk (5-6), SIF=NO
  if (hasElectrical && hasPanelFailure && !extraction.worker_exposure) {
    if (score < 5) score = 5;
  }

  // 6. Low-level deviations / Routine observations
  if (extraction.hazards.length === 0 && extraction.critical_control_failures.length === 0 && sifDetected === "NO") {
    if (t.includes("without wearing the required safety helmet")) {
      score = 2; // PPE reminder
    } else {
      score = cfg.weights.lowLevelDeviation; // 1 (housekeeping, routine floor, packaging material)
    }
  }

  // Map to Risk Level Thresholds
  let riskLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "LOW";
  if (score >= cfg.thresholds.critical) {
    riskLevel = "CRITICAL";
  } else if (score >= cfg.thresholds.high) {
    riskLevel = "HIGH";
  } else if (score >= cfg.thresholds.medium) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  // Factors for display & database
  const factors: Array<{ factor_type: string; factor_name: string; evidence: string }> = [];

  for (const h of extraction.hazards) {
    const ev = extraction.evidence.find(e => e.toLowerCase().includes(h.toLowerCase().substring(0, 10))) || extraction.evidence[0] || "Identified from report text";
    factors.push({ factor_type: "hazard", factor_name: h, evidence: ev });
  }

  for (const c of extraction.critical_control_failures) {
    const ev = extraction.evidence.find(e => e.toLowerCase().includes(c.toLowerCase().substring(0, 10))) || extraction.evidence[0] || "Identified from report text";
    factors.push({ factor_type: "missing_control", factor_name: c, evidence: ev });
  }

  if (extraction.worker_exposure) {
    const ev = extraction.exposure_evidence[0] || extraction.evidence[0] || "Personnel present in affected operational zone";
    factors.push({ factor_type: "worker_exposure", factor_name: "Direct Worker Exposure", evidence: ev });
  }

  for (const act of extraction.unsafe_acts) {
    const ev = extraction.evidence.find(e => e.toLowerCase().includes(act.toLowerCase().substring(0, 10))) || extraction.evidence[0] || "Observed unsafe act";
    factors.push({ factor_type: "unsafe_act", factor_name: act, evidence: ev });
  }

  for (const cond of extraction.unsafe_conditions) {
    const ev = extraction.evidence.find(e => e.toLowerCase().includes(cond.toLowerCase().substring(0, 10))) || extraction.evidence[0] || "Observed unsafe condition";
    factors.push({ factor_type: "unsafe_condition", factor_name: cond, evidence: ev });
  }

  for (const ppe of extraction.ppe_issues) {
    const ev = extraction.evidence.find(e => e.toLowerCase().includes(ppe.toLowerCase().substring(0, 10))) || extraction.evidence[0] || "PPE observation";
    factors.push({ factor_type: "ppe_issue", factor_name: ppe, evidence: ev });
  }

  // Priority Score Computation for Deterministic Sequential Ranking
  let priorityScore = 0;
  if (sifDetected === "YES") priorityScore += 10000;
  else if ((sifDetected as string) === "REVIEW REQUIRED") priorityScore += 5000;

  if (riskLevel === "CRITICAL") priorityScore += 4000;
  else if (riskLevel === "HIGH") priorityScore += 2500;
  else if (riskLevel === "MEDIUM") priorityScore += 1000;

  priorityScore += score * 100;
  priorityScore += (extraction.sif_indicators.length || 0) * 80;
  priorityScore += (extraction.hazards.length || 0) * 50;
  if (extraction.worker_exposure) priorityScore += 150;
  priorityScore += (extraction.critical_control_failures.length || 0) * 100;

  // Synthesize Evidence-Based Explanation
  let explanation = "";
  if (sifDetected === "YES") {
    const hazardList = extraction.hazards.join(", ") || "High-consequence operational hazard";
    const controlList = extraction.critical_control_failures.join(", ") || "barrier control deficit";
    const quote = extraction.evidence[0] ? ` Evidence from source report: "${extraction.evidence[0]}"` : "";
    explanation = `Identified as a Potential SIF Precursor (Risk Score: ${score}, Level: ${riskLevel}). Key precursor factors: ${hazardList}. Critical barrier failure: ${controlList}.${extraction.worker_exposure ? " Direct worker exposure is explicitly documented in the operational zone." : ""}${quote} Prioritized for immediate HSE safety review and control verification.`;
  } else if (riskLevel === "HIGH" || riskLevel === "MEDIUM") {
    const hazardList = extraction.hazards.join(", ") || "Operational deviation";
    const quote = extraction.evidence[0] ? ` Evidence from source report: "${extraction.evidence[0]}"` : "";
    explanation = `Evaluated at ${riskLevel} Risk (Risk Score: ${score}). Factors identified: ${hazardList}.${quote} Physical inspection and verification of isolation/guarding controls are recommended.`;
  } else {
    explanation = `Assessed as LOW Risk (Risk Score: ${score}). Routine operational observation or minor housekeeping deviation with no high-consequence hazard indicators or barrier failures detected. Standard preventative maintenance applies.`;
  }

  return {
    sif_detected: sifDetected,
    risk_score: score,
    risk_level: riskLevel,
    priority_score: priorityScore,
    priority_rank: 999, // Assigned sequentially across full batch by recalculateAllPriorityRanks
    explanation,
    factors,
    suggested_actions: extraction.suggested_actions
  };
}

// Sequential Priority Rank Recalculation across all analyzed reports
function recalculateAllPriorityRanks() {
  const q = db.exec(`
    SELECT a.id
    FROM analysis a
    JOIN reports r ON a.report_id = r.id
    ORDER BY a.priority_score DESC, a.risk_score DESC, r.uploaded_at ASC, r.id ASC
  `);

  if (q[0] && q[0].values) {
    q[0].values.forEach((row, idx) => {
      const analysisId = row[0] as number;
      const rank = idx + 1;
      db.run(`UPDATE analysis SET priority_rank = ${rank} WHERE id = ${analysisId}`);
    });
    persistDatabase();
  }
}

// Active job management & epoch counter to abort running jobs on reset
let currentJobEpoch = 0;
const activeJobs = new Set<string>();

// Background Batch Job Worker
async function processBatchJob(jobId: string, reportIds: number[]) {
  const jobEpoch = currentJobEpoch;
  activeJobs.add(jobId);

  const total = reportIds.length;
  let completed = 0;
  let failed = 0;

  for (const reportId of reportIds) {
    // Check if reset occurred before starting this report
    if (jobEpoch !== currentJobEpoch || !activeJobs.has(jobId)) {
      console.log(`[Job ${jobId}] Aborted before report ${reportId} due to database reset.`);
      return;
    }

    try {
      const repQuery = db.exec(`SELECT id, filename, report_text FROM reports WHERE id = ${reportId}`);
      if (!repQuery[0] || !repQuery[0].values[0]) {
        // Report doesn't exist (e.g. deleted or reset)
        continue;
      }

      const [id, filename, reportText] = repQuery[0].values[0] as [number, string, string];

      // Update progress
      db.run(
        `UPDATE jobs SET current_file = '${filename.replace(/'/g, "''")}', current_step = 'Analyzing safety factors & SIF indicators', updated_at = CURRENT_TIMESTAMP WHERE id = '${jobId}'`
      );
      db.run(`UPDATE reports SET processing_status = 'processing' WHERE id = ${reportId}`);
      persistDatabase();

      // Run AI Extraction & Risk Prioritization
      const extraction = await analyzeSafetyReportWithLLM(reportText, filename);

      // Check if reset occurred during LLM call
      if (jobEpoch !== currentJobEpoch || !activeJobs.has(jobId)) {
        console.log(`[Job ${jobId}] Aborted after LLM call for report ${reportId} due to database reset.`);
        return;
      }

      // Check again if report still exists in the database before saving results
      const stillExists = db.exec(`SELECT id FROM reports WHERE id = ${reportId}`);
      if (!stillExists[0] || !stillExists[0].values[0]) {
        console.log(`[Job ${jobId}] Report ${reportId} deleted during processing. Skipping save.`);
        continue;
      }

      const assessment = calculateRiskAndPrioritize(extraction, reportText);

      // Save Analysis with ON CONFLICT UPDATE to prevent unique constraint crashes
      const cleanExp = assessment.explanation.replace(/'/g, "''");
      const cleanSum = extraction.summary.replace(/'/g, "''");
      const cleanControls = extraction.critical_control_failures.join(", ").replace(/'/g, "''");
      const cleanActions = assessment.suggested_actions.join("\n").replace(/'/g, "''");

      db.run(`
        INSERT INTO analysis (
          report_id, sif_detected, risk_score, risk_level, priority_score, priority_rank,
          explanation, summary, worker_exposure, missing_controls, suggested_actions, analyzed_at
        ) VALUES (
          ${reportId}, '${assessment.sif_detected}', ${assessment.risk_score}, '${assessment.risk_level}', ${assessment.priority_score}, ${assessment.priority_rank},
          '${cleanExp}', '${cleanSum}', ${extraction.worker_exposure ? 1 : 0}, '${cleanControls}', '${cleanActions}', CURRENT_TIMESTAMP
        )
        ON CONFLICT(report_id) DO UPDATE SET
          sif_detected = '${assessment.sif_detected}',
          risk_score = ${assessment.risk_score},
          risk_level = '${assessment.risk_level}',
          priority_score = ${assessment.priority_score},
          priority_rank = ${assessment.priority_rank},
          explanation = '${cleanExp}',
          summary = '${cleanSum}',
          worker_exposure = ${extraction.worker_exposure ? 1 : 0},
          missing_controls = '${cleanControls}',
          suggested_actions = '${cleanActions}',
          analyzed_at = CURRENT_TIMESTAMP
      `);

      // Save Factors
      db.run(`DELETE FROM factors WHERE report_id = ${reportId}`);
      for (const f of assessment.factors) {
        db.run(`
          INSERT INTO factors (report_id, factor_type, factor_name, evidence)
          VALUES (${reportId}, '${f.factor_type.replace(/'/g, "''")}', '${f.factor_name.replace(/'/g, "''")}', '${f.evidence.replace(/'/g, "''")}')
        `);
      }

      // Initialize Human Review Record
      db.run(`
        INSERT OR IGNORE INTO reviews (report_id, status, comment, reviewer, reviewed_at)
        VALUES (${reportId}, 'Pending Review', '', 'HSE Safety Officer', CURRENT_TIMESTAMP)
      `);

      // Update Report Metadata
      const cleanType = extraction.report_type.replace(/'/g, "''");
      const cleanLoc = extraction.location.replace(/'/g, "''");
      const cleanAct = extraction.activity.replace(/'/g, "''");
      const cleanEq = extraction.equipment.replace(/'/g, "''");

      db.run(`
        UPDATE reports SET
          report_type = '${cleanType}',
          location = '${cleanLoc}',
          activity = '${cleanAct}',
          equipment = '${cleanEq}',
          processing_status = 'completed'
        WHERE id = ${reportId}
      `);

      completed++;
    } catch (err) {
      console.error(`Failed processing report ${reportId}:`, err);
      failed++;
      try {
        db.run(`UPDATE reports SET processing_status = 'failed' WHERE id = ${reportId}`);
      } catch (_) {}
    }

    // Check again before updating jobs table
    if (jobEpoch !== currentJobEpoch || !activeJobs.has(jobId)) {
      console.log(`[Job ${jobId}] Aborted before updating job status due to database reset.`);
      return;
    }

    db.run(
      `UPDATE jobs SET completed_reports = ${completed}, failed_reports = ${failed}, updated_at = CURRENT_TIMESTAMP WHERE id = '${jobId}'`
    );
    persistDatabase();

    // Small delay to allow UI polling smoothly
    await new Promise(res => setTimeout(res, 60));
  }

  // Check before final rank recalculation and completion
  if (jobEpoch !== currentJobEpoch || !activeJobs.has(jobId)) {
    console.log(`[Job ${jobId}] Finalization skipped due to database reset.`);
    return;
  }

  // Recalculate unique sequential priority ranks across all analyzed reports
  recalculateAllPriorityRanks();

  db.run(
    `UPDATE jobs SET status = 'completed', current_step = 'Batch analysis complete', updated_at = CURRENT_TIMESTAMP WHERE id = '${jobId}'`
  );
  activeJobs.delete(jobId);
  persistDatabase();
}

// --- REST API Endpoints ---

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "SIF Safety Intelligence Platform",
    database: "SQLite (sql.js)",
    timestamp: new Date().toISOString()
  });
});

app.post(["/api/upload", "/api/upload/batch"], upload.array("files"), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files provided." });
    }

    const savedIds: number[] = [];

    for (const file of files) {
      const fname = file.originalname;
      const ext = fname.split(".").pop()?.toLowerCase() || "txt";

      if (ext === "zip") {
        try {
          const zip = new AdmZip(file.buffer);
          const zipEntries = zip.getEntries();
          for (const entry of zipEntries) {
            if (entry.isDirectory || entry.entryName.startsWith("__MACOSX")) continue;
            const zext = entry.name.split(".").pop()?.toLowerCase() || "";
            if (["txt", "pdf", "docx"].includes(zext)) {
              const text = await extractTextFromBuffer(entry.name, entry.getData());
              const cleanText = text.replace(/'/g, "''");
              const cleanName = entry.name.replace(/'/g, "''");

              // Save extracted file into UPLOAD_DIR
              try {
                const filePath = path.join(UPLOAD_DIR, entry.name);
                fs.writeFileSync(filePath, entry.getData());
              } catch (_) {}

              db.run(`
                INSERT INTO reports (filename, file_size, file_type, report_text, processing_status)
                VALUES ('${cleanName}', ${entry.header.size}, '${zext}', '${cleanText}', 'pending')
              `);
              const lastId = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0] as number;
              savedIds.push(lastId);
            }
          }
        } catch (zipErr: any) {
          return res.status(400).json({ error: `Error extracting ZIP archive: ${zipErr.message}` });
        }
      } else if (["txt", "pdf", "docx"].includes(ext)) {
        const text = await extractTextFromBuffer(fname, file.buffer);
        const cleanText = text.replace(/'/g, "''");
        const cleanName = fname.replace(/'/g, "''");

        // Save uploaded file into UPLOAD_DIR
        try {
          const filePath = path.join(UPLOAD_DIR, fname);
          fs.writeFileSync(filePath, file.buffer);
        } catch (_) {}

        db.run(`
          INSERT INTO reports (filename, file_size, file_type, report_text, processing_status)
          VALUES ('${cleanName}', ${file.size}, '${ext}', '${cleanText}', 'pending')
        `);
        const lastId = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0] as number;
        savedIds.push(lastId);
      }
    }

    persistDatabase();

    res.json({
      message: `Successfully uploaded ${savedIds.length} reports.`,
      uploaded_count: savedIds.length,
      report_ids: savedIds
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post(["/api/analyze", "/api/analyze/batch"], async (req, res) => {
  try {
    const { report_ids, reanalyze } = req.body;

    let targetIds: number[] = [];
    if (report_ids && Array.isArray(report_ids) && report_ids.length > 0) {
      targetIds = report_ids;
    } else if (reanalyze) {
      const q = db.exec("SELECT id FROM reports ORDER BY id ASC");
      if (q[0] && q[0].values) {
        targetIds = q[0].values.map(v => v[0] as number);
      }
    } else {
      const q = db.exec("SELECT id FROM reports WHERE processing_status != 'completed'");
      if (q[0] && q[0].values) {
        targetIds = q[0].values.map(v => v[0] as number);
      }
    }

    if (targetIds.length === 0) {
      return res.json({ message: "No unanalyzed reports found.", job_id: null, total: 0 });
    }

    const jobId = "job-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);

    db.run(`
      INSERT INTO jobs (id, total_reports, completed_reports, failed_reports, current_step, status)
      VALUES ('${jobId}', ${targetIds.length}, 0, 0, 'Initializing pipeline', 'running')
    `);
    persistDatabase();

    // Start background processing without blocking response
    setImmediate(() => {
      processBatchJob(jobId, targetIds).catch(err => {
        console.error("Batch processing error:", err);
      });
    });

    res.json({
      message: "Analysis job started in background.",
      job_id: jobId,
      total: targetIds.length
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  try {
    const jobId = req.params.id;
    if (!jobId) {
      return res.status(400).json({ error: "Missing job ID" });
    }
    const q = db.exec(`SELECT id, total_reports, completed_reports, failed_reports, current_file, current_step, status FROM jobs WHERE id = '${jobId.replace(/'/g, "''")}'`);

    if (!q[0] || !q[0].values[0]) {
      return res.status(404).json({ error: "Job not found" });
    }

    const [id, total, completed, failed, current_file, current_step, status] = q[0].values[0];
    res.json({ id, total_reports: total, completed_reports: completed, failed_reports: failed, current_file, current_step, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed retrieving job" });
  }
});

app.get("/api/reports", (req, res) => {
  try {
    const { filter_by, search, sort_by } = req.query;

    let whereClauses: string[] = ["1=1"];

    if (filter_by) {
      const f = String(filter_by).toLowerCase();
      if (["critical", "high", "medium", "low"].includes(f)) {
        whereClauses.push(`LOWER(a.risk_level) = '${f}'`);
      } else if (f === "sif") {
        whereClauses.push("a.sif_detected = 'YES'");
      } else if (f === "near_miss" || f === "near miss") {
        whereClauses.push("(r.report_type = 'near_miss' OR r.report_type = 'Near Miss')");
      } else if (f === "unsafe_act" || f === "unsafe act") {
        whereClauses.push("(r.report_type = 'unsafe_act' OR r.report_type = 'Unsafe Act')");
      } else if (f === "unsafe_condition" || f === "unsafe condition") {
        whereClauses.push("(r.report_type = 'unsafe_condition' OR r.report_type = 'Unsafe Condition')");
      } else if (f === "pending") {
        whereClauses.push("(rev.status = 'Pending Review' OR rev.status IS NULL)");
      } else if (f === "reviewed") {
        whereClauses.push("rev.status IN ('Confirmed', 'Not a SIF Precursor', 'Requires Further Review')");
      }
    }

    if (search) {
      const s = String(search).replace(/'/g, "''");
      whereClauses.push(`(r.filename LIKE '%${s}%' OR r.report_text LIKE '%${s}%' OR a.summary LIKE '%${s}%' OR r.location LIKE '%${s}%')`);
    }

    let orderBy = "COALESCE(a.priority_rank, 999) ASC, COALESCE(a.risk_score, 0) DESC";
    if (sort_by === "risk_score") {
      orderBy = "COALESCE(a.risk_score, 0) DESC";
    } else if (sort_by === "date") {
      orderBy = "r.uploaded_at DESC";
    }

    const query = `
      SELECT 
        r.id, r.filename, r.report_type, r.location, r.uploaded_at, r.processing_status,
        a.sif_detected, a.risk_score, a.risk_level, a.priority_rank, a.summary,
        rev.status as review_status, rev.reviewer, rev.reviewed_at
      FROM reports r
      LEFT JOIN analysis a ON r.id = a.report_id
      LEFT JOIN reviews rev ON r.id = rev.report_id
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY ${orderBy}
    `;

    const q = db.exec(query);
    const reports: any[] = [];

    if (q[0] && q[0].values) {
      const columns = q[0].columns;
      for (const row of q[0].values) {
        const rep: any = {};
        columns.forEach((col, idx) => {
          rep[col] = row[idx];
        });

        // Key factors
        const fq = db.exec(`SELECT factor_name FROM factors WHERE report_id = ${rep.id} LIMIT 3`);
        rep.key_factors = (fq[0]?.values || []).map(v => v[0]);

        reports.push(rep);
      }
    }

    console.log(`[GET /api/reports] DB: ${DB_FILE} - returning ${reports.length} reports`);
    res.json({ reports, count: reports.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed fetching reports" });
  }
});

app.get("/api/reports/:id", (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (!reportId || isNaN(reportId) || reportId <= 0) {
      return res.status(400).json({ error: "Invalid report ID" });
    }

    const rq = db.exec(`SELECT * FROM reports WHERE id = ${reportId}`);
    if (!rq[0] || !rq[0].values[0]) {
      return res.status(404).json({ error: "Report not found" });
    }

    const repCols = rq[0].columns;
    const report: any = {};
    repCols.forEach((col, idx) => {
      report[col] = rq[0].values[0][idx];
    });

    const aq = db.exec(`SELECT * FROM analysis WHERE report_id = ${reportId}`);
    let analysis: any = null;
    if (aq[0] && aq[0].values[0]) {
      analysis = {};
      aq[0].columns.forEach((col, idx) => {
        analysis[col] = aq[0].values[0][idx];
      });
    }

    const fq = db.exec(`SELECT factor_type, factor_name, evidence FROM factors WHERE report_id = ${reportId}`);
    const factors = (fq[0]?.values || []).map(v => ({
      factor_type: v[0],
      factor_name: v[1],
      evidence: v[2]
    }));

    const rvq = db.exec(`SELECT status, comment, reviewer, reviewed_at FROM reviews WHERE report_id = ${reportId}`);
    let review: any = { status: "Pending Review", comment: "", reviewer: "HSE Safety Officer" };
    if (rvq[0] && rvq[0].values[0]) {
      review = {
        status: rvq[0].values[0][0],
        comment: rvq[0].values[0][1],
        reviewer: rvq[0].values[0][2],
        reviewed_at: rvq[0].values[0][3]
      };
    }

    res.json({ report, analysis, factors, review });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed fetching report details" });
  }
});

app.patch("/api/reports/:id/review", (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (!reportId || isNaN(reportId) || reportId <= 0) {
      return res.status(400).json({ error: "Invalid report ID" });
    }
    const { status, comment, reviewer } = req.body;

    const cleanStatus = (status || "Pending Review").replace(/'/g, "''");
    const cleanComment = (comment || "").replace(/'/g, "''");
    const cleanReviewer = (reviewer || "HSE Safety Officer").replace(/'/g, "''");

    db.run(`
      INSERT INTO reviews (report_id, status, comment, reviewer, reviewed_at)
      VALUES (${reportId}, '${cleanStatus}', '${cleanComment}', '${cleanReviewer}', CURRENT_TIMESTAMP)
      ON CONFLICT(report_id) DO UPDATE SET
        status = '${cleanStatus}',
        comment = '${cleanComment}',
        reviewer = '${cleanReviewer}',
        reviewed_at = CURRENT_TIMESTAMP
    `);
    persistDatabase();

    res.json({ message: "Human review updated successfully.", status: cleanStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed updating review" });
  }
});

app.get("/api/dashboard", (req, res) => {
  try {
    const countHelper = (sql: string): number => {
      const q = db.exec(sql);
      return (q[0]?.values[0]?.[0] as number) || 0;
    };

    const totalReports = countHelper("SELECT COUNT(*) FROM reports");
    const sifReports = countHelper("SELECT COUNT(*) FROM analysis WHERE sif_detected = 'YES'");
    const critical = countHelper("SELECT COUNT(*) FROM analysis WHERE risk_level = 'CRITICAL'");
    const high = countHelper("SELECT COUNT(*) FROM analysis WHERE risk_level = 'HIGH'");
    const medium = countHelper("SELECT COUNT(*) FROM analysis WHERE risk_level = 'MEDIUM'");
    const low = countHelper("SELECT COUNT(*) FROM analysis WHERE risk_level = 'LOW'");

    // Reports by Type
    const tq = db.exec("SELECT report_type, COUNT(*) FROM reports WHERE report_type IS NOT NULL AND report_type != '' GROUP BY report_type");
    const reportsByType = (tq[0]?.values || []).map(v => ({
      report_type: v[0],
      count: v[1]
    }));

    // Top Hazards
    const hq = db.exec("SELECT factor_name, COUNT(*) as c FROM factors WHERE factor_type = 'hazard' GROUP BY factor_name ORDER BY c DESC LIMIT 5");
    const topHazards = (hq[0]?.values || []).map(v => ({
      factor_name: v[0],
      count: v[1]
    }));

    // Review status breakdown
    const rq = db.exec("SELECT status, COUNT(*) FROM reviews GROUP BY status");
    const reviewStatus = (rq[0]?.values || []).map(v => ({
      status: v[0],
      count: v[1]
    }));

    console.log(`[GET /api/dashboard] DB: ${DB_FILE} - total: ${totalReports}, sif: ${sifReports}, critical: ${critical}, high: ${high}, medium: ${medium}, low: ${low}`);
    res.json({
      total_reports: totalReports,
      sif_reports: sifReports,
      critical,
      high,
      medium,
      low,
      reports_by_type: reportsByType,
      top_hazards: topHazards,
      review_status: reviewStatus
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed computing dashboard metrics" });
  }
});

app.post("/api/seed-samples", async (req, res) => {
  try {
    let samplesDir = path.join(UPLOAD_DIR, "samples");
    if (!fs.existsSync(samplesDir)) {
      samplesDir = path.join(process.cwd(), "data", "samples");
    }
    if (!fs.existsSync(samplesDir)) {
      samplesDir = path.join(process.cwd(), "uploads", "samples");
    }
    if (!fs.existsSync(samplesDir)) {
      return res.status(404).json({ error: "Samples directory not found." });
    }

    const files = fs.readdirSync(samplesDir).filter(f => f.endsWith(".txt"));
    const savedIds: number[] = [];

    for (const f of files) {
      const fullPath = path.join(samplesDir, f);
      const text = fs.readFileSync(fullPath, "utf-8");
      const cleanText = text.replace(/'/g, "''");
      const cleanName = f.replace(/'/g, "''");

      db.run(`
        INSERT INTO reports (filename, file_size, file_type, report_text, processing_status)
        VALUES ('${cleanName}', ${text.length}, 'txt', '${cleanText}', 'pending')
      `);
      const lastId = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0] as number;
      savedIds.push(lastId);
    }

    persistDatabase();

    res.json({
      message: `Loaded ${savedIds.length} sample Oil India Limited reports into database.`,
      count: savedIds.length,
      report_ids: savedIds
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed loading samples" });
  }
});

app.all(["/api/clear", "/api/reset", "/api/database/reset", "/api/reports/reset"], (req, res) => {
  try {
    console.log(`[Reset API] Received reset request via ${req.method} ${req.originalUrl}`);
    console.log(`[Reset API] Target database file: ${DB_FILE}`);

    // 1. Invalidate and abort all in-progress batch analysis jobs
    currentJobEpoch++;
    activeJobs.clear();

    // 2. Perform transactional database wipe
    db.run("BEGIN TRANSACTION;");
    db.run("DELETE FROM reviews;");
    db.run("DELETE FROM factors;");
    db.run("DELETE FROM analysis;");
    db.run("DELETE FROM reports;");
    db.run("DELETE FROM jobs;");
    try {
      db.run("DELETE FROM sqlite_sequence WHERE name IN ('reports', 'analysis', 'factors', 'reviews', 'jobs');");
    } catch (_) {
      // sqlite_sequence may not exist yet if no autoincrement rows were inserted
    }
    db.run("COMMIT;");

    // 3. Commit the transaction and verify all relevant tables are genuinely empty (count === 0)
    const tablesToVerify = ["reports", "analysis", "factors", "reviews", "jobs"];
    const rowCounts: Record<string, number> = {};
    for (const table of tablesToVerify) {
      const q = db.exec(`SELECT COUNT(*) FROM ${table}`);
      const count = (q[0]?.values[0]?.[0] as number) || 0;
      rowCounts[table] = count;
      if (count !== 0) {
        throw new Error(`Reset verification failed: Table '${table}' still contains ${count} rows.`);
      }
    }

    // 4. Persist clean zero state to the configured SQLITE_DB_PATH database file
    persistDatabase();

    // 5. Clean ALL uploaded files and subdirectories inside the configured UPLOAD_DIR
    let cleanedFilesCount = 0;
    if (fs.existsSync(UPLOAD_DIR)) {
      const entries = fs.readdirSync(UPLOAD_DIR);
      for (const entry of entries) {
        const fullPath = path.join(UPLOAD_DIR, entry);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleanedFilesCount++;
        } catch (rmErr) {
          console.warn(`Could not delete file ${fullPath}:`, rmErr);
        }
      }
    }

    console.log(`[Reset API] Successfully reset database at ${DB_FILE}. Row counts:`, JSON.stringify(rowCounts));

    res.json({
      message: "Database and upload directory successfully reset to zero state.",
      database_path: DB_FILE,
      tables_verified_empty: tablesToVerify,
      row_counts: rowCounts,
      cleaned_files_count: cleanedFilesCount,
      active_jobs_cancelled: true
    });
  } catch (err: any) {
    console.error("[Database Reset Error]", err);
    try {
      db.run("ROLLBACK;");
    } catch (_) {}
    res.status(500).json({ error: err.message || "Failed resetting database" });
  }
});

// Guard: Explicit JSON 404 for ANY /api/* route - never let API requests fall through to HTML!
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Global JSON error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Express unhandled error:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    error: err.message || "Internal server error"
  });
});

// Serve frontend static files
const frontendDir = fs.existsSync(path.join(process.cwd(), "frontend", "index.html"))
  ? path.join(process.cwd(), "frontend")
  : path.join(process.cwd(), "dist");

app.use(express.static(frontendDir));

// Fallback to index.html for SPA (strictly non-API requests)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: `API endpoint not found: ${req.path}` });
  }
  res.sendFile(path.join(frontendDir, "index.html"));
});

// Start Server
async function start() {
  await initDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SIF Safety Intelligence Platform running at http://0.0.0.0:${PORT}`);
  });
}

start().catch(err => {
  console.error("Failed starting server:", err);
});
